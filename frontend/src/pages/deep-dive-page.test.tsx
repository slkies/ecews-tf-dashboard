/**
 * The Deep dive page: headline tiles, every section, the league table's order
 * and threshold, and the way through to a worklist. The map's boundary file is
 * not served in tests, so it shows its unavailable message; it is checked in a
 * real browser through src/dev/deep-dive-harness.tsx. Figures are synthetic.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider } from '@/core/filters'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import DeepDivePage, { type Dist, type FacilityRow, type Profile } from './deep-dive-page'
import { WORKLISTS } from './worklists-page'

const OPTIONS = {
  states: ['Delta'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [],
  fys: [], months: [], plans: [], lga_state: {}, facility_state: {},
}
const d = (...pairs: [string, number][]): Dist[] => {
  const t = pairs.reduce((a, [, n]) => a + n, 0)
  return pairs.map(([level, n]) => ({ level, n, pct: Math.round(n / t * 1000) / 10 }))
}
const P: Profile = {
  n: 1000, clients: 900,
  who: { median_age: 38, female_pct: 60, adolescent_pct: 12, paed_pct: 3,
    sex: d(['Female', 600], ['Male', 400]), age_group: d(['Under 10', 30], ['10-19', 120], ['20+', 850]),
    age_band: [], marital: d(['Married', 500], ['Not recorded', 500]), education: [], job: [], pregnancy: [] },
  what: { median_years_art: 7.4, regimen: d(['1st line', 900], ['2nd/3rd line', 100]), vl_magnitude: [], cd4: [],
    years_art: [], eac_status: d(['Never commenced', 200], ['Completed EAC', 800]), who_stage: [], bmi: [], plan: [] },
  when: { monthly: { months: ['2026-07-01', '2026-08-01'], n: [100, 80], exits: [60, 40] },
    wait: { n: 500, median: 104, q1: 62, q3: 171, pending: 90 }, quarter: [], time_to_first_vl: [],
    yrs_to_unsupp: [], time_to_eac: [], months_unsupp: [], ttfv_months: null, ttfu_years: null,
    mu_stats: { n: 990, median: 7.1, q1: 3, q3: 12 } },
  care: { neg_total: 300, neg_pct: 30, neg_no_followup: 210, neg_no_post_eac: 250, neg_dated: 280,
    status: d(['Active', 700], ['LTFU', 300]), exit_when: [], breakdown: [{ level: 'LTFU', n: 300, no_followup_vl: 210 }] },
  where: { state: d(['Delta', 1000]), lga: [], facility: [], lga_res: { counts: {}, total: 1000 } },
}
const FAC: FacilityRow[] = [
  { group: 'Delta Facility Strong', n: 60, eac1_pct: 90, post_result: 30, resupp_pct: 70, still_unsuppressed: 5, switched: 5 },
  { group: 'Delta Facility Weak', n: 50, eac1_pct: 40, post_result: 10, resupp_pct: 50, still_unsuppressed: 8, switched: 2 },
  { group: 'Delta Facility Tiny', n: 12, eac1_pct: 10, post_result: 1, resupp_pct: 0, still_unsuppressed: 1, switched: 0 },
]

function mock(profile: Profile) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, headers: new Headers() })
    if (url.startsWith('/api/me')) return json({ username: 'u', email: 'u@x', name: 'U', role: 'viewer', scope_state: null, scope_facility: null })
    if (url.startsWith('/api/filters')) return json(OPTIONS)
    if (url.startsWith('/api/profile')) return json(profile)
    if (url.startsWith('/api/breakdown/facility')) return json(FAC)
    if (url.startsWith('/api/worklists')) return json(WORKLISTS.map((w) => ({ flag: w.flag, n: w.flag === 'no_eac' ? 200 : 0 })))
    return json({})
  }))
}

beforeEach(() => { sessionStorage.setItem('ecews.session', 'token') })
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function draw(onOpenWorklist = vi.fn()) {
  const user = userEvent.setup()
  render(<ThemeProvider><SessionProvider><FilterProvider>
    <DeepDivePage onOpenWorklist={onOpenWorklist} />
  </FilterProvider></SessionProvider></ThemeProvider>)
  return { user, onOpenWorklist }
}

const section = (title: RegExp) => screen.getByRole('heading', { name: title }).closest('section')!

describe('Deep dive page', () => {
  it('shows the headline figures and every section', async () => {
    mock(P)
    draw()
    const tile = (await screen.findByText('900 distinct clients')).closest('[data-slot=card]')!
    expect(within(tile as HTMLElement).getByText('1,000')).toBeInTheDocument()
    expect(screen.getByText('38 yr')).toBeInTheDocument()
    for (const t of [/people behind/, /treatment and clinical/, /Left care/, /Timing/, /Geography/,
                     /Facility league/, /Actionable flags/]) {
      expect(screen.getByRole('heading', { name: t })).toBeInTheDocument()
    }
  })

  it('lists each distribution with its count and share', async () => {
    mock(P)
    draw()
    await screen.findByText('900 distinct clients')
    const who = section(/people behind/)
    const married = within(who).getByText('Married').closest('li')!
    expect(married).toHaveTextContent('500')
    expect(married).toHaveTextContent('50%')
  })

  it('ranks facilities weakest EAC commencement first, and leaves out those under 20 episodes', async () => {
    mock(P)
    draw()
    await screen.findByText('900 distinct clients')
    const rows = within(section(/Facility league/)).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.children[0]!.textContent)).toEqual(['Delta Facility Weak', 'Delta Facility Strong'])
    expect(rows[0]).toHaveTextContent('6')          // awaiting DTC review: 8 still unsuppressed - 2 switched
  })

  it('opens a worklist from the flags table and from the care section', async () => {
    mock(P)
    const { user, onOpenWorklist } = draw()
    await screen.findByText('900 distinct clients')
    const flags = section(/Actionable flags/)
    const noEac = within(flags).getByText('Unsuppressed with no valid EAC record').closest('tr')!
    expect(noEac).toHaveTextContent('200')
    await user.click(within(noEac).getByRole('button', { name: 'Open' }))
    expect(onOpenWorklist).toHaveBeenCalledWith('no_eac')
    await user.click(screen.getByRole('button', { name: /left care with no follow-up VL \(210\)/ }))
    expect(onOpenWorklist).toHaveBeenCalledWith('exited_no_vl')
  })

  it('says so when the selection is empty', async () => {
    mock({ n: 0 } as Profile)
    draw()
    expect(await screen.findByText('No episodes in this selection')).toBeInTheDocument()
  })
})
