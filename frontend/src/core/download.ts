/**
 * Download a server-built export.
 *
 * Exports are always built by the server: it applies the role check, the
 * row scope and the active-clients rule, and it writes the audit record. A
 * CSV assembled in the browser from rows already on screen would skip all
 * four, so there is deliberately no such path.
 */
import { getToken } from './api'

export async function downloadExport(path: string, body?: unknown): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const b = await res.json().catch(() => ({})) as { detail?: unknown }
    throw new Error(typeof b.detail === 'string' ? b.detail : `Export failed (${res.status})`)
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
    ?? 'ecews_tf_export.csv'
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return name
}
