/**
 * The trend arithmetic. A tile's movement must be the change in the SAME rate
 * the tile shows - over the same denominator - or "up 2 pts" means nothing.
 */
import { describe, expect, it } from 'vitest'
import { toTrend } from './use-trend'

const metrics = (rows: Record<string, [number, number]>) =>
  Object.entries(rows).map(([metric, [a, b]]) => ({ metric, a, b }))

const OK = {
  ok: true,
  a: { id: 1, as_of: '2026-08-22', n: 4000 },
  b: { id: 2, as_of: '2026-09-05', n: 4548 },
  days_between: 14,
  back_dated: false,
  metrics: metrics({
    'Commenced EAC': [3400, 3912],
    'Completed EAC': [1800, 2104],
    'Post-EAC VL taken': [1100, 1290],
    'Follow-up VL result': [1600, 1877],
    'Re-suppressed': [1200, 1402],
  }),
}

describe('toTrend', () => {
  it('reports the cohort as a count of episodes, not a rate', () => {
    expect(toTrend(OK)!.values.cohort).toEqual({ delta: 548, unit: 'episodes' })
  })

  it('computes commenced EAC over the whole cohort', () => {
    // 3400/4000 = 85.0%  ->  3912/4548 = 86.0%
    expect(toTrend(OK)!.values.eac1.delta).toBe(1)
  })

  it('computes completion over those who commenced, not over the cohort', () => {
    // 1800/3400 = 52.9%  ->  2104/3912 = 53.8%
    expect(toTrend(OK)!.values.completed.delta).toBe(0.8)
  })

  it('computes re-suppression over those with a follow-up VL', () => {
    // 1200/1600 = 75.0%  ->  1402/1877 = 74.7%
    expect(toTrend(OK)!.values.resupp.delta).toBe(-0.3)
  })

  it('returns no trend when the comparison failed', () => {
    expect(toTrend({ ok: false, reason: 'no rows in scope' })).toBeNull()
  })

  it('leaves a rate out when a metric is missing, rather than inventing one', () => {
    const partial = { ...OK, metrics: metrics({ 'Commenced EAC': [3400, 3912] }) }
    const t = toTrend(partial)!
    expect(t.values.eac1.delta).toBe(1)
    expect(t.values.completed.delta).toBeNull()
  })

  it('flags a back-dated upload so time-dependent movement can be read correctly', () => {
    expect(toTrend({ ...OK, back_dated: true, days_between: -7 })!.backDated).toBe(true)
  })
})
