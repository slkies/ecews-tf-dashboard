/** Shapes the API returns. Only what is consumed so far is declared. */

/** What `_public()` returns in main.py - note there is no `id` on the wire. */
export interface Me {
  username: string | null
  email: string
  name: string | null
  role: 'admin' | 'viewer' | (string & {})
  scope_state: string | null
  scope_facility: string | null
}

export interface LoginResponse {
  token: string
  user: Me
}

export interface BuildInfo {
  version: string
  commit: string
  dirty: boolean
  label: string
  index_sha?: string | null
  index_bytes?: number
  index_modified?: string | null
}

export interface Summary {
  n: number
  clients: number
  as_of: string | null
}
