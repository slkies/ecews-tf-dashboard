/** Synthetic DTC figures for the harness and tests. Every S/N and facility is made up. */
import type { Awaiting, Dtc, Trajectory } from '@/pages/dtc-page'

const lv = (level: string, n: number, repeat: number, ref = false, or_: number | null = null,
            or_lo: number | null = null, or_hi: number | null = null, or_p: number | null = null) =>
  ({ level, n, repeat, pct: Math.round(repeat / n * 1000) / 10, ref, or_: ref ? 1 : or_, or_lo, or_hi, or_p })

export const DTC: Dtc = {
  ok: true,
  summary: { repeat_clients: 410, repeat_still_clients: 118, repeat_still_episodes: 131,
    still: 675, switched: 96, awaiting: 470, prior: 109, dtc_flag: 21 },
  repeat_assoc: { n: 853, pct: 18.4, variables: [
    { label: 'Sex', levels: [lv('Female', 2845, 480, true), lv('Male', 1770, 370, false, 1.31, 1.12, 1.52, 0.0006)] },
    { label: 'Age group', levels: [lv('20+', 4109, 700, true), lv('10-19', 380, 110, false, 1.98, 1.56, 2.51, 0.0001),
                                    lv('Under 10', 144, 43, false, 2.07, 1.43, 2.99, 0.0002)] },
  ] },
  switch_gap: { n_still: 675,
    by_state: [
      { level: 'Delta', still: 380, awaiting: 262, switched: 60, prior: 58, pct_awaiting: 68.9 },
      { level: 'Osun', still: 190, awaiting: 138, switched: 22, prior: 30, pct_awaiting: 72.6 },
      { level: 'Ekiti', still: 105, awaiting: 70, switched: 14, prior: 21, pct_awaiting: 66.7 },
    ],
    by_regimen: [
      { level: '1st line', still: 566, awaiting: 470, switched: 96, prior: 0, pct_awaiting: 83 },
      { level: '2nd/3rd line', still: 109, awaiting: 0, switched: 0, prior: 109, pct_awaiting: 0 },
    ],
    by_months: [
      { level: '<3 mo', still: 90, awaiting: 60, switched: 12, prior: 18, pct_awaiting: 66.7 },
      { level: '12+ mo', still: 260, awaiting: 190, switched: 30, prior: 40, pct_awaiting: 73.1 },
    ],
    by_cd4: [{ level: '<200', still: 110, awaiting: 80, switched: 14, prior: 16, pct_awaiting: 72.7 }],
  },
  log_drop: { ok: true, n: 640, median: 0.62, no_response_completed_eac: 188, bands: [
    { band: 'Fell >2 log', meaning: 'responding well', n: 70, pct: 10.9, completed_eac: 40 },
    { band: 'Fell 1-2 log', meaning: 'substantial response', n: 140, pct: 21.9, completed_eac: 90 },
    { band: 'Fell 0.5-1 log', meaning: 'partial response', n: 120, pct: 18.8, completed_eac: 70 },
    { band: 'Fell <0.5 log', meaning: 'essentially no fall', n: 190, pct: 29.7, completed_eac: 120 },
    { band: 'Viral load rose', meaning: 'worse than at index', n: 120, pct: 18.8, completed_eac: 68 },
  ] },
}

export const AWAITING: Awaiting = {
  ok: true, n: 191, as_of: '2026-09-12', median_days: 34, over_30: 102, over_60: 38, future_dated: 2, shown: 191,
  by_facility: [
    { facility: 'Delta Facility A', n: 31, median_days: 41, longest: 96 },
    { facility: 'Osun Facility B', n: 22, median_days: 28, longest: 55 },
    { facility: 'Ekiti Facility C', n: 14, median_days: 63, longest: 120 },
  ],
  rows: Array.from({ length: 20 }, (_, i) => ({
    facility: `${['Delta', 'Osun', 'Ekiti'][i % 3]} Facility ${String.fromCharCode(65 + (i % 6))}`,
    sample_date: `2026-0${5 + (i % 3)}-1${i % 9}`, days: 120 - i * 5, idx_vl: 2400 + i * 13000,
  })),
}

const PATTERNS = ['Rebound after suppression', 'Sharp rise', 'Persistently high', 'Erratic', 'Mixed', 'Single result']
export const TRAJ: Trajectory = {
  ok: true, n: 675, shown: 40,
  rows: Array.from({ length: 40 }, (_, i) => {
    const k = i % 6
    const vals = k === 0 ? [80000, 400, 12000] : k === 1 ? [2000, 45000] : k === 2 ? [9000, 11000, 8000]
      : k === 3 ? [5000, 900, 30000, 2000] : k === 4 ? [3000, 1200] : [15000]
    return {
      sn: `0.${String(700000000000 + i)}`,
      facility: `${['Delta', 'Osun', 'Ekiti'][i % 3]} Facility ${String.fromCharCode(65 + (i % 7))}`,
      eac_stage: ['Completed EAC', 'Commenced, not completed', 'Never commenced'][i % 3]!,
      points: vals.map((v, j) => ({ label: j === 0 ? 'Index VL' : `Result ${j + 1}`, date: `2025-${String(3 + j * 3).padStart(2, '0')}-10`,
                                    value: v, suppressed: v < 1000, implausible: false })),
      n_results: vals.length, latest_vl: vals[vals.length - 1]!, latest_date: '2026-08-20', pattern: PATTERNS[k]!,
    }
  }),
}
