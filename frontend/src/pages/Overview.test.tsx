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
import type { Overview as Ov } from '../core/overview'
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
  disagg: { sex: {}, state: {} },
  by_state: [{
    state: 'Delta', n: 2000, eac1: 1800, completed: 1000, post: 900,
    resupp: 700, eac1_pct: 90.0, resupp_pct: 77.8,
  }],
  by_volume: [{ facility: 'Delta Clinic', n: 199, eac1_pct: 91.2 }],
}

describe('Overview', () => {
  it('says so plainly when the filter matches nothing', () => {
    render(<Overview data={{ ...BASE, n: 0 }} />)
    expect(screen.getByText('No data for this filter.')).toBeInTheDocument()
  })

  it('renders nothing rather than crashing before data arrives', () => {
    render(<Overview data={null} />)
    expect(screen.getByText('No data for this filter.')).toBeInTheDocument()
  })

  it('shows the headline figures with their denominators', () => {
    render(<Overview data={BASE} />)
    expect(screen.getByText('86.0%')).toBeInTheDocument()
    // The denominator travels with the rate - "86%" alone is how a rate on
    // five clients gets quoted as a programme result.
    expect(screen.getByText(/3,912 of 4,548/)).toBeInTheDocument()
    expect(screen.getByText(/636 never started/)).toBeInTheDocument()
  })

  it('computes post-EAC VL against those who COMPLETED EAC, not the cohort', () => {
    render(<Overview data={BASE} />)
    // 1290 / 2104 = 61.3%, not 1290 / 4548.
    expect(screen.getByText('61.3%')).toBeInTheDocument()
    expect(screen.getByText(/1,290 of 2,104 who completed EAC/)).toBeInTheDocument()
  })

  it('shows an em dash, never a zero, for a rate that does not exist', () => {
    const noRetest: Ov = {
      ...BASE, retested: 0, retest_pct: null, resuppressed: 0, resupp_pct: null,
    }
    render(<Overview data={noRetest} />)
    const tiles = screen.getAllByText('—')
    expect(tiles.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('flags a low EAC commencement rate as bad, not neutral', () => {
    const { container } = render(<Overview data={{ ...BASE, eac1_pct: 42.0 }} />)
    const bad = container.querySelector('.stat.bad')
    expect(bad).toBeTruthy()
    expect(within(bad as HTMLElement).getByText('42.0%')).toBeInTheDocument()
  })

  it('draws both charts when there is something to draw', () => {
    render(<Overview data={BASE} />)
    expect(screen.getAllByTestId('chart')).toHaveLength(2)
  })

  it('replaces a chart with a reason when its series is empty', () => {
    const empty: Ov = {
      ...BASE,
      weekly: { months: [], female: [], male: [] },
      resupp_trend: { months: [], female: [], male: [], female_n: [], male_n: [] },
    }
    render(<Overview data={empty} />)
    expect(screen.queryAllByTestId('chart')).toHaveLength(0)
    expect(screen.getByText('No dated results in this selection.')).toBeInTheDocument()
    expect(screen.getByText('No follow-up results in this selection.')).toBeInTheDocument()
  })

  it('describes the period from the data on screen, not from the filter', () => {
    render(<Overview data={BASE} />)
    // It appears twice by design: once as the panel heading and once in the
    // opening sentence of the narrative.
    expect(screen.getAllByText(/Jul-25 to Aug-25/).length).toBeGreaterThanOrEqual(2)
  })
})
