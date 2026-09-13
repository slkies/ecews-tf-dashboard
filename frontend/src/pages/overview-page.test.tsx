/**
 * What the rebuilt Overview puts on screen.
 *
 * The rules pinned here survive the redesign unchanged: a missing value and a
 * zero never look the same, every rate travels with its denominator, status is
 * carried by a word as well as a colour, and the narrative has no inline bold.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider } from '@/core/filters'
import type { Overview as Ov, TimeMetrics } from '@/core/overview'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import type { Trend } from '@/core/use-trend'
import OverviewPage from './overview-page'

vi.mock('@/components/Chart', () => ({
  default: ({ ariaLabel }: { ariaLabel?: string }) => <div data-testid="chart" aria-label={ariaLabel} />,
}))

const OPTIONS = {
  states: ['Delta'], lgas: [], lga_res: [], facilities: [], age_bands: ['0-9'],
  quarters: [], fys: ['FY26'], months: [], plans: [], lga_state: {}, facility_state: {},
}

const BASE: Ov = {
  n: 4548, clients: 4101, repeats: 447, repeat_clients: 389, as_of: '2026-09-05', warnings: null,
  eac1: 3912, eac1_pct: 86.0, never_eac: 636, completed: 2104, completed_pct: 53.8, post_eac_vl: 1290,
  retested: 1877, retest_pct: 41.3, awaiting_retest: 2671, resuppressed: 1402, resupp_pct: 74.7,
  still_unsuppressed: 475, switch_eligible: 475, switched: 310, prior_switch: 42, switch_pct: 65.3,
  awaiting_switch: 123, repeat_failure: 88,
  progress: [
    { quarter: 'FY26Q1', n: 1200, eac1: 1050, completed: 600, retested: 500, resuppressed: 380,
      eac1_pct: 87.5, completed_pct: 57.1, retest_pct: 41.7, resupp_pct: 76.0 },
    { quarter: 'FY26Q2', n: 900, eac1: 700, completed: 300, retested: 250, resuppressed: 180,
      eac1_pct: 77.8, completed_pct: 42.9, retest_pct: 27.8, resupp_pct: 72.0 },
  ],
  weekly: { months: ['2025-07-01', '2025-08-01'], female: [10, 20], male: [5, 8] },
  resupp_trend: { months: ['2025-07-01'], female: [72.5], male: [null], female_n: [40], male_n: [2] },
  demo: {
    female: 2800, female_pct: 61.6, male: 1748, male_pct: 38.4, paeds: 180, paeds_pct: 4.0,
    adolescents: 410, adolescents_pct: 9.0, median_months_art: 48, first_line: 3900, first_line_pct: 85.8,
    second_line: 600, second_line_pct: 13.2, median_time_to_eac: 25, median_lead_months: 2.1,
  },
  disagg: { sex: { Female: { n: 1200, resupp: 900, pct: 75.0 }, Male: { n: 677, resupp: 502, pct: 74.2 } },
            state: { Delta: { n: 900, resupp: 700, pct: 77.8 } } },
  by_state: [{ state: 'Delta', n: 2000, eac1: 1800, completed: 1000, post: 900, resupp: 700,
               eac1_pct: 90.0, resupp_pct: 77.8 }],
  by_volume: [{ facility: 'Delta Clinic', n: 199, eac1: 181, completed: 90, eac1_pct: 91.0, completed_pct: 49.7 }],
  best: [{ facility: 'Osun Clinic', n: 44, eac1: 44, completed: 40, eac1_pct: 100.0, completed_pct: 90.9 }],
  min_vol: 20,
  zero_eac: [{ facility: 'Silent Clinic', n: 31 }],
  sources: [
    { name: 'TF Register', kind: 'total', rows: 4548 },
    { name: 'EAC Line List_23rd May', kind: 'eac', rows: 42478, censored: true },
  ],
}

const TIMES: TimeMetrics = {
  time_to_eac: { n: 3900, median: 25, q1: 9, q3: 61, mean: 44, min: 0, max: 700, wlo: 0, whi: 139 },
  eac_lead_time: { n: 1800, median: 131, q1: 80, q3: 210, mean: 150, min: 1, max: 900, wlo: 1, whi: 405 },
}

const TREND: Trend = {
  prevAsOf: '2026-08-22', days: 14, backDated: false,
  values: {
    cohort: { delta: 548, unit: 'episodes' }, eac1: { delta: 1, unit: 'pts' },
    completed: { delta: 0.8, unit: 'pts' }, postEac: { delta: null, unit: 'pts' },
    retest: { delta: -2.4, unit: 'pts' }, resupp: { delta: -0.3, unit: 'pts' },
  },
}

function draw(data: Ov | null, opts: { times?: TimeMetrics | null; trend?: Trend | null; loading?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OPTIONS }))
  return render(
    <ThemeProvider><SessionProvider><FilterProvider>
      <OverviewPage data={data} times={opts.times ?? null} trend={opts.trend ?? null} loading={opts.loading ?? false} />
    </FilterProvider></SessionProvider></ThemeProvider>,
  )
}

const tile = (label: string) =>
  screen.getByText(label, { selector: 'span' }).closest('[data-slot="card"]') as HTMLElement

afterEach(() => { vi.unstubAllGlobals() })

describe('Overview page', () => {
  it('shows a skeleton on first load, not an empty page', () => {
    draw(null, { loading: true })
    expect(screen.getByLabelText('Loading the overview')).toBeInTheDocument()
  })

  it('says plainly when the filters select no episodes', async () => {
    draw({ ...BASE, n: 0 })
    expect(await screen.findByText('No episodes match these filters')).toBeInTheDocument()
  })

  it('shows each headline figure with its denominator', () => {
    draw(BASE)
    const t = tile('Commenced EAC')
    expect(within(t).getByText('86.0%')).toBeInTheDocument()
    expect(within(t).getByText('3,912 of 4,548 · 636 never started')).toBeInTheDocument()
  })

  it('computes post-EAC VL over those who completed EAC, not the cohort', () => {
    draw(BASE)
    const t = tile('Post-EAC VL sample')
    expect(within(t).getByText('61.3%')).toBeInTheDocument()   // 1290 / 2104
  })

  it('carries status as a word, not colour alone', () => {
    draw(BASE)
    expect(within(tile('Follow-up VL done')).getByText('Below 50%')).toBeInTheDocument()
    expect(within(tile('Commenced EAC')).getByText('On track')).toBeInTheDocument()
    expect(within(tile('Awaiting DTC review')).getByText('Action needed')).toBeInTheDocument()
  })

  it('shows an em dash, never 0.0%, for a rate that does not exist', () => {
    draw({ ...BASE, retested: 0, retest_pct: null, resuppressed: 0, resupp_pct: null })
    expect(within(tile('Re-suppressed')).getByText('—')).toBeInTheDocument()
    expect(within(tile('Re-suppressed')).queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('shows movement against the previous line list, and says so for screen readers', () => {
    draw(BASE, { trend: TREND })
    const t = tile('Follow-up VL done')
    expect(within(t).getByText('2.4 pts')).toBeInTheDocument()
    expect(within(t).getByText('down 2.4 pts since the previous line list')).toBeInTheDocument()
    expect(screen.getByText(/trends compare with the list of 22 Aug 2026/)).toBeInTheDocument()
  })

  it('omits a trend it cannot compute rather than showing zero', () => {
    draw(BASE, { trend: TREND })
    expect(within(tile('Post-EAC VL sample')).queryByText(/pts/)).not.toBeInTheDocument()
  })

  it('breaks the DTC tile into still-unsuppressed, prior switch and switched', () => {
    draw(BASE)
    const t = tile('Awaiting DTC review')
    expect(within(t).getByText('Prior switch')).toBeInTheDocument()
    expect(within(t).getByText('65.3% of 475 eligible')).toBeInTheDocument()
  })

  it('shows time to event with its interquartile range', () => {
    draw(BASE, { times: TIMES })
    expect(screen.getByText('Median time to EAC')).toBeInTheDocument()
    expect(screen.getByText(/IQR 9-61 d/)).toBeInTheDocument()
    expect(screen.getByText('Over 120 days')).toBeInTheDocument()
  })

  it('carries no inline bold in the narrative', () => {
    draw(BASE)
    const narrative = screen.getByText('Programme narrative').closest('[data-slot="card"]')!
    expect(narrative.querySelectorAll('strong, b')).toHaveLength(0)
  })

  it('draws both charts', () => {
    draw(BASE)
    expect(screen.getAllByTestId('chart')).toHaveLength(2)
  })

  it('lists facilities with volume but no EAC, and hides the card when there are none', async () => {
    const { unmount } = draw(BASE)
    expect(screen.getByText('Silent Clinic')).toBeInTheDocument()
    unmount()
    draw({ ...BASE, zero_eac: [] })
    await waitFor(() => expect(screen.queryByText(/volume but no EAC/)).not.toBeInTheDocument())
  })

  it('lists the source sheets and marks a censored one', () => {
    draw(BASE)
    expect(screen.getByText('TF Register')).toBeInTheDocument()
    expect(screen.getByText('Censored')).toBeInTheDocument()
  })

  it('hides export from a viewer', () => {
    draw(BASE)
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
  })
})
