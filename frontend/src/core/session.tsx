/**
 * Who is signed in, held in one place.
 *
 * The previous frontend kept TOKEN and ME as mutable module globals, which the
 * module-split proposal flagged as the one genuine design problem in a split:
 * live bindings cannot be exported. React context solves it properly - the
 * token has exactly one owner, and every consumer re-renders when it changes.
 *
 * The token is kept in memory and mirrored to sessionStorage, not
 * localStorage: a shared facility machine should not stay signed in after the
 * tab closes.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { api, setExpiryHandler, setToken } from './api'
import type { LoginResponse, Me } from './types'

const STORAGE_KEY = 'ecews.session'

interface Session {
  me: Me | null
  ready: boolean            // false until a stored token has been checked
  signIn: (handle: string, password: string) => Promise<void>
  signOut: () => void
}

const Ctx = createContext<Session | null>(null)

function readStored(): string | null {
  try { return sessionStorage.getItem(STORAGE_KEY) } catch { return null }
}
function writeStored(t: string | null) {
  // Private browsing and locked-down group policy both make this throw. A
  // failure here costs the user a re-login, not the session.
  try {
    if (t) sessionStorage.setItem(STORAGE_KEY, t)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* not fatal */ }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)

  const signOut = useCallback(() => {
    setToken(null); writeStored(null); setMe(null)
  }, [])

  // A 401 from anywhere means the session is over, however it happened.
  useEffect(() => { setExpiryHandler(signOut) }, [signOut])

  // Restore a session from a previous page load. A stored token that the
  // server no longer accepts must not leave the app half-signed-in, so the
  // token is only adopted once /api/me confirms it.
  useEffect(() => {
    const stored = readStored()
    if (!stored) { setReady(true); return }
    let cancelled = false
    setToken(stored)
    api<Me>('/me')
      .then((u) => { if (!cancelled) setMe(u) })
      .catch(() => { if (!cancelled) { setToken(null); writeStored(null) } })
      .finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [])

  const signIn = useCallback(async (handle: string, password: string) => {
    // The API takes `username` (or `email`, kept for older clients) - not
    // `handle`, which is only the name of the server-side accessor that
    // collapses the two.
    const r = await api<LoginResponse>('/login', {
      method: 'POST',
      body: JSON.stringify({ username: handle, password }),
    })
    setToken(r.token); writeStored(r.token); setMe(r.user)
  }, [])

  const value = useMemo<Session>(
    () => ({ me, ready, signIn, signOut }), [me, ready, signIn, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession must be used inside <SessionProvider>')
  return s
}
