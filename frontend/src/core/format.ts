/**
 * Number and date formatting, ported from the existing dashboard so the two
 * render a figure identically while both are served.
 *
 * Everything returns an em dash for missing values rather than "null", "NaN"
 * or "0". A zero and an unknown are different facts about a programme and must
 * not look the same on a screen a state team reads.
 */

export const DASH = '—'

/** A count. Rounded, thousands-separated, em dash when absent. */
export function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return DASH
  return Math.round(n).toLocaleString('en-GB')
}

/** A percentage to one decimal. */
export function pc(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return DASH
  return `${v.toFixed(1)}%`
}

/** 'Aug-26' from an ISO date. Short because it labels a dense axis. */
export function fmtMonYY(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  const m = d.toLocaleDateString('en-GB', { month: 'short' })
  return `${m}-${String(d.getFullYear()).slice(-2)}`
}

/** A readable date: 5 Sep 2026. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return d.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The period the loaded cohort actually covers, taken from its own month span
 * rather than from the filter. What is on screen is what gets described.
 */
export function periodLabel(o: { weekly?: { months?: string[] } } | null): string {
  const m = o?.weekly?.months ?? []
  if (!m.length) return 'the current period'
  return `${fmtMonYY(m[0]!)} to ${fmtMonYY(m[m.length - 1]!)}`
}

/** A rate, guarding the zero denominator that would otherwise be Infinity. */
export function rate(a: number, b: number): number | null {
  return b ? Math.round((a / b) * 1000) / 10 : null
}
