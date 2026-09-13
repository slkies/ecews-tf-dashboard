/**
 * What the Overview actually puts on screen.
 *
 * The rule these pin down: a missing value and a zero are different facts
 * about a programme and must never look the same. "0.0%" means nobody
 * commenced EAC; an em dash means nobody knows. A page that renders one as the
 * other is worse than a page that fails to load, because it gets quoted.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Overview as Ov, TimeMetrics } from '../core/overview'
import { ThemeProvider } from '../core/theme'
import Overview from './Overview'

// Chart.js needs a real canvas, which jsdom does not provide. The chart's own
// configuration is not what this file is testing.
vi.mock('../components/Chart', () => ({
  default: ({ ariaLabel }: { ariaLabel?: string }) =>
    <div data-testid="chart" aria-label={ariaLabel} />,
}))

const BASE: Ov = {
  n: 4548, clients: 4101, repeats: 447, repeat_clients: 389,
  as_of: '2026-09-05', warnings: null,
  eac1: 3912, eac1_pct: 86.0,
  never_eac: 636,
  completed: 2104, completed_pct: 53.8,
  post_eac_vl: 1290,
  retested: 1877, retest_pct: 41.3,
  awaiting_retest: 2671,
  resuppressed: 1402, resupp_pct: 74.7,
  still_unsuppressed: 475,
  switch_eligible: 475, switched: 310, prior_switch: 42, switch_pct: 65.3,
  awaiting_switch: 123,
  repeat_failure: 88,
  progress: [{
    quarter: 'FY26Q1', n: 1200, eac1: 1050, completed: 600, retested: 500,
    resuppressed: 380, eac1_pct: 87.5, completed_pct: 57.1, retest_pct: 41.7,
    resupp_pct: 76.0,
  }],
  weekly: { months: ['2025-07-01', '2025-08-01'], female: [10, 20], male: [5, 8] },
  resupp_trend: {
    months: ['2025-07-01'], female: [72.5], male: [null],
    female_n: [40], male_n: [2],
  },
  demo: {
    female: 2800, female_pct: 61.6, male: 1748, male_pct: 38.4,
    paeds: 180, paeds_pct: 4.0, adolescents: 410, adolescents_pct: 9.0,
    median_months_art: 48, first_line: 3900, first_line_pct: 85.8,
    second_line: 600, second_line_pct: 13.2,
    median_time_to_eac: 25, median_lead_months: 2.1,
  },
  disagg: {
    sex: { Female: { n: 1200, resupp: 900, pct: 75.0 }, Male: { n: 677, resupp: 502, pct: 74.2 } },
    state: { Delta: { n: 900, resupp: 700, pct: 77.8 } },
  },
  by_state: [{
    state: 'Delta', n: 2000, eac1: 1800, completed: 1000, post: 900,
    resupp: 700, eac1_pct: 90.0, resupp_pct: 77.8,
  }],
  by_volume: [{ facility: 'Delta Clinic', n: 199, eac1: 181, completed: 90,
                eac1_pct: 91.0, completed_pct: 49.7 }],
  best: [{ facility: 'Osun Clinic', n: 44, eac1: 44, completed: 40,
           eac1_pct: 100.0, completed_pct: 90.9 }],
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
  time_to_resuppression: { n: 1400, median: 160, q1: 100, q3: 250, mean: 180, min: 5, max: 800, wlo: 5, whi: 475 },
  months_unsuppressed: { n: 4548, median: 7.2, q1: 3.1, q3: 13.4, mean: 9, min: 0, max: 60, wlo: 0, whi: 28 },
}

const draw = (data: Ov | null, times?: TimeMetrics | null) =>
  render(<ThemeProvider><Overview data={data} times={times} /></ThemeProvider>)

describe('Overview', () => {
  it('says so plainly when the filter matches nothing', () => {
    draw({ ...BASE, n: 0 })
    expect(screen.getByText('No data for this filter.')).toBeInTheDocument()
  })

  it('renders nothing rather than crashing before data arrives', () => {
    draw(null)
    expect(screen.getByText('No data for this filter.')).toBeInTheDocument()
  })

  it('shows the headline figures with their denominators', () => {
    const { container } = draw(BASE)
    // Scoped to the tile row: the same rate is also the figure in the
    // commenced-EAC donut, which is correct and not what this checks.
    const tiles = container.querySelector('.stats') as HTMLElement
    expect(within(tiles).getByText('86.0%')).toBeInTheDocument()
    // The denominator travels with the rate - "86%" alone is how a rate on
    // five clients gets quoted as a programme result.
    expect(screen.getByText(/3,912 of 4,548 · 636 never started/)).toBeInTheDocument()
  })

  it('computes post-EAC VL against those who COMPLETED EAC, not the cohort', () => {
    draw(BASE)
    // 1290 / 2104 = 61.3%, not 1290 / 4548.
    expect(screen.getByText('61.3%')).toBeInTheDocument()
    expect(screen.getByText(/1,290 of 2,104 who completed EAC/)).toBeInTheDocument()
  })

  it('shows an em dash, never a zero, for a rate that does not exist', () => {
    draw({ ...BASE, retested: 0, retest_pct: null, resuppressed: 0, resupp_pct: null })
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('flags a low EAC commencement rate as bad, not neutral', () => {
    const { container } = draw({ ...BASE, eac1_pct: 42.0 })
    const bad = container.querySelector('.stat.bad')
    expect(bad).toBeTruthy()
    expect(within(bad as HTMLElement).getByText('42.0%')).toBeInTheDocument()
  })

  it('draws the incidence line, two donuts and the trend', () => {
    draw(BASE)
    expect(screen.getAllByTestId('chart')).toHaveLength(4)
  })

  it('replaces a chart with a reason when its series is empty', () => {
    draw({
      ...BASE,
      weekly: { months: [], female: [], male: [] },
      resupp_trend: { months: [], female: [], male: [], female_n: [], male_n: [] },
    })
    // The two donuts still draw; only the time series are gone.
    expect(screen.getAllByTestId('chart')).toHaveLength(2)
    expect(screen.getByText('No dated results in this selection.')).toBeInTheDocument()
    expect(screen.getByText('No follow-up results in this selection.')).toBeInTheDocument()
  })

  it('describes the period from the data on screen, not from the filter', () => {
    draw(BASE)
    // Twice by design: the panel heading and the narrative's first sentence.
    expect(screen.getAllByText(/Jul-25 to Aug-25/).length).toBeGreaterThanOrEqual(2)
  })

  it('carries no inline bold in the narrative', () => {
    const { container } = draw(BASE)
    expect(container.querySelectorAll('.narrative strong, .narrative b')).toHaveLength(0)
  })

  // ── the cards that were missing from the first port ──────────────
  it('shows the time-to-event strip once time metrics arrive, not before', () => {
    const { rerender } = draw(BASE, null)
    expect(screen.queryByText('Median time to EAC')).not.toBeInTheDocument()
    rerender(<ThemeProvider><Overview data={BASE} times={TIMES} /></ThemeProvider>)
    expect(screen.getByText('Median time to EAC')).toBeInTheDocument()
    expect(screen.getByText('25 d')).toBeInTheDocument()
    expect(screen.getByText(/IQR 9–61/)).toBeInTheDocument()
  })

  it('draws EAC commencement by state as a bar per state with its count', () => {
    const { container } = draw(BASE)
    expect(screen.getByText('EAC commenced by state')).toBeInTheDocument()
    const bar = container.querySelector('.oc-state .st i') as HTMLElement
    // The DOM normalises '90.0%' to '90%'; compare the number, not the string.
    expect(parseFloat(bar.style.width)).toBe(90)
    expect(within(container.querySelector('.oc-state') as HTMLElement).getByText('2,000'))
      .toBeInTheDocument()
  })

  it('lists the cohort at a glance', () => {
    draw(BASE)
    expect(screen.getByText('Cohort at a glance')).toBeInTheDocument()
    expect(screen.getByText('Adolescents 10–19')).toBeInTheDocument()
    expect(screen.getByText('48 mo')).toBeInTheDocument()
  })

  it('ranks completion only among facilities with enough volume, and says so', () => {
    draw(BASE)
    expect(screen.getByText(/at least 20 episodes/)).toBeInTheDocument()
    expect(screen.getByText('Osun Clinic')).toBeInTheDocument()
  })

  it('calls out facilities with volume but no EAC, and hides the card when there are none', () => {
    const { rerender } = draw(BASE)
    expect(screen.getByText('Silent Clinic')).toBeInTheDocument()
    rerender(<ThemeProvider><Overview data={{ ...BASE, zero_eac: [] }} /></ThemeProvider>)
    expect(screen.queryByText(/volume but no EAC/)).not.toBeInTheDocument()
  })

  it('lists the source sheets and marks a censored one', () => {
    draw(BASE)
    expect(screen.getByText('TF Register')).toBeInTheDocument()
    expect(screen.getByText('Total Unsuppressed register')).toBeInTheDocument()
    expect(screen.getByText('censored')).toBeInTheDocument()
    expect(screen.getByText(/5 September 2026/)).toBeInTheDocument()
  })
})
