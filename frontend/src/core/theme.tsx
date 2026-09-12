/**
 * Light or dark, remembered per browser.
 *
 * The choice is written to the root element as `data-theme`, which is exactly
 * what tokens.css keys off - so the palette is shared with the existing app
 * and neither has to know about the other.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'

type Theme = 'light' | 'dark'
const STORAGE_KEY = 'ecews.theme'

interface ThemeCtx { theme: Theme; toggle: () => void }
const Ctx = createContext<ThemeCtx | null>(null)

function initial(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* storage blocked - fall through to the system preference */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* not fatal */ }
  }, [theme])

  const toggle = useCallback(
    () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const t = useContext(Ctx)
  if (!t) throw new Error('useTheme must be used inside <ThemeProvider>')
  return t
}
