/**
 * "Which way is it moving" for the headline tiles: the current line list
 * against the one before it, under the same filters.
 *
 * TF Monitor refreshes from a bi-weekly line list, so the honest comparison is
 * with the previous list - never "last week". The backend already computes
 * the movement (/api/compare); this only finds the previous snapshot and turns
 * its counts into the same rates the tiles show.
 *
 * Two things a trend here does NOT mean, and the tiles say so on hover: a
 * change mixes genuinely new episodes with maturation of existing ones, and a
 * back-dated upload moves every time-dependent rate on arithmetic alone.
 */
import { useEffect, useState } from 'react'
import { api } from './api'

interface UploadRow {
  id: number
  as_of: string | null
  status: string
  is_current: boolean
}

interface Snapshot { id: number; as_of: string; n: number }

interface CompareResponse {
  ok: boolean
  reason?: string
  a?: Snapshot
  b?: Snapshot
  days_between?: number
  back_dated?: boolean
  metrics?: { metric: string; a: number; b: number }[]
}

export type TrendKey = 'cohort' | 'eac1' | 'completed' | 'postEac' | 'retest' | 'resupp'

export interface TrendValue {
  /** Percentage points for rates; a count for the cohort. */
  delta: number | null
  unit: 'pts' | 'episodes'
}

export interface Trend {
  prevAsOf: string
  days: number
  backDated: boolean
  values: Record<TrendKey, TrendValue>
}

const pct = (a: number, b: number) => (b ? (a / b) * 100 : null)
const diff = (a: number | null, b: number | null) =>
  a == null || b == null ? null : Math.round((b - a) * 10) / 10

/** Pure, so the rate arithmetic can be tested without a network. */
export function toTrend(r: CompareResponse): Trend | null {
  if (!r.ok || !r.a || !r.b || !r.metrics) return null
  const m = (label: string) => r.metrics!.find((x) => x.metric === label)
  const eac1 = m('Commenced EAC')
  const done = m('Completed EAC')
  const post = m('Post-EAC VL taken')
  const fu = m('Follow-up VL result')
  const rs = m('Re-suppressed')
  const nA = r.a.n
  const nB = r.b.n
  const rate = (num?: { a: number; b: number }, den?: { a: number; b: number } | 'n') => {
    if (!num || !den) return null
    const [da, db] = den === 'n' ? [nA, nB] : [den.a, den.b]
    return diff(pct(num.a, da), pct(num.b, db))
  }
  return {
    prevAsOf: r.a.as_of,
    days: r.days_between ?? 0,
    backDated: !!r.back_dated,
    values: {
      cohort: { delta: nB - nA, unit: 'episodes' },
      eac1: { delta: rate(eac1, 'n'), unit: 'pts' },
      completed: { delta: rate(done, eac1), unit: 'pts' },
      postEac: { delta: rate(post, done), unit: 'pts' },
      retest: { delta: rate(fu, 'n'), unit: 'pts' },
      resupp: { delta: rate(rs, fu), unit: 'pts' },
    },
  }
}

/**
 * The trend for the current filter selection, or null while it loads, when
 * there is no earlier snapshot, or when the comparison fails. A missing trend
 * simply does not render - the tile is complete without it.
 */
export function useTrend(query: string, enabled: boolean): Trend | null {
  const [pair, setPair] = useState<{ prev: number; cur: number } | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api<UploadRow[]>('/uploads')
      .then((rows) => {
        const ready = rows.filter((r) => r.status === 'ready' && r.as_of)
        const cur = ready.find((r) => r.is_current)
        if (!cur) return
        // The previous line list is the latest one dated before the current
        // one - by as-of date, not by upload time, since lists are sometimes
        // uploaded out of order.
        const prev = ready
          .filter((r) => !r.is_current && r.as_of! < cur.as_of!)
          .sort((x, y) => (y.as_of! > x.as_of! ? 1 : -1))[0]
        if (!cancelled && prev) setPair({ prev: prev.id, cur: cur.id })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [enabled])

  useEffect(() => {
    if (!pair) return
    let cancelled = false
    const sep = query ? '&' : '?'
    api<CompareResponse>(`/compare${query}${sep}a=${pair.prev}&b=${pair.cur}`)
      .then((r) => { if (!cancelled) setTrend(toTrend(r)) })
      .catch(() => { if (!cancelled) setTrend(null) })
    return () => { cancelled = true }
  }, [pair, query])

  return trend
}
