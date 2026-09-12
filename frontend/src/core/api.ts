/**
 * The single way this app talks to the backend.
 *
 * Two behaviours here are not stylistic - each one is a bug the previous
 * frontend shipped, and both are carried forward deliberately:
 *
 *  1. A request with a body MUST send Content-Type: application/json. Without
 *     it FastAPI treats the body as text/plain and rejects it with 422 before
 *     the handler runs, so the call looks like it worked from the caller's
 *     side and nothing changes. That is how a broken password-change reached
 *     production. Setting it here means no call site can forget.
 *
 *  2. FastAPI validation errors arrive as an ARRAY of objects. Rendering one
 *     straight into a message produced "[object Object]", which told the user
 *     nothing at all.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Called when the server says the session is over, so the app can sign out. */
type ExpiryHandler = () => void
let onExpired: ExpiryHandler = () => {}
export function setExpiryHandler(fn: ExpiryHandler) { onExpired = fn }

let token: string | null = null
export function setToken(t: string | null) { token = t }
export function getToken() { return token }

function detailToMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const parts = detail.map((x) =>
      x && typeof x === 'object' && 'msg' in x
        ? String((x as { msg: unknown }).msg)
        : JSON.stringify(x))
    return parts.join('; ')
  }
  return null
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  }

  const res = await fetch(`/api${path}`, { ...init, headers })

  // A 401 means "your session ended" only if we actually sent a token. Signing
  // in with a wrong password is also a 401, and the original frontend reported
  // it as "Session expired" - which is both untrue and unhelpful, since the
  // user never had a session to expire. Without a token, fall through and show
  // what the server said.
  if (res.status === 401 && token) {
    onExpired()
    throw new ApiError('Session expired', 401)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: unknown }
    throw new ApiError(
      detailToMessage(body.detail) ?? `Request failed (${res.status})`,
      res.status,
    )
  }
  // 204 and other empty responses would throw on .json().
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Build a query string, dropping empties so the URL stays readable. */
export function qs(params: Record<string, string | string[] | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((one) => one && sp.append(k, one))
    else if (v !== '') sp.append(k, v)
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
