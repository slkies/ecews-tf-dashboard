/**
 * The Cascade page: every step with its count, rate and denominator, the loss
 * between steps that follow one another, the way through to a worklist, and
 * the follow-up outcome. Figures are synthetic.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider } from '@/core/filters'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import CascadePage, { type CascadeStep } from './cascade-page'

const OPTIONS = {
  states: ['Delta'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [],
  fys: [], months: [], plans: [], lga_state: {}, facility_state: {},
}

const s = (step: number, label: string, n: number, denominator: number, denominator_label: string,
           note?: string): CascadeStep => ({
  step, label, n, n_female: Math.round(n * 0.6), n_male: n - Math.round(n * 0.6) - 1,
  denominator, denominator_label, pct: denominator ? Math.round(n / denominator * 1000) / 10 : null, note,
})

export const STEPS: CascadeStep[] = [
  s(1, 'Total unsuppressed', 1000, 1000, '-'),
  s(2, 'EAC commenced', 800, 1000, '#1'),
  s(3, 'EAC session 2', 700, 800, '#2'),
  s(4, 'EAC session 3', 600, 800, '#2'),
  s(5, 'Extended EAC (4+)', 50, 800, '#2'),
  s(6, 'EAC completed', 500, 800, '#2'),
  s(61, 'Post-EAC VL sample', 450, 600, '#4', 'Sessions 1-3 done AND a VL sample on/after session 3.'),
  s(7, 'Follow-up VL sample', 700, 1000, '#1'),
  s(8, 'Follow-up VL result', 650, 1000, '#1'),
  s(9, 'Re-suppressed (<1,000)', 450, 650, '#8'),
  s(91, '- Undetectable (<50)', 300, 650, '#8'),
  s(92, '- LLV (50-999)', 150, 650, '#8'),
  s(93, 'Still unsuppressed', 200, 650, '#8'),
  s(10, 'Switched to 2nd/3rd line', 20, 200, '#9b'),
]

beforeEach(() => {
  sessionStorage.setItem('ecews.session', 'token')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, headers: new Headers() })
    if (url.startsWith('/api/me')) return json({ username: 'u', email: 'u@x', name: 'U', role: 'viewer', scope_state: null, scope_facility: null })
    if (url.startsWith('/api/filters')) return json(OPTIONS)
    if (url.startsWith('/api/cascade')) return json(STEPS)
    return json({})
  }))
})
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function draw(onOpenWorklist = vi.fn()) {
  const user = userEvent.setup()
  render(
    <ThemeProvider>
      <SessionProvider><FilterProvider><CascadePage onOpenWorklist={onOpenWorklist} /></FilterProvider></SessionProvider>
    </ThemeProvider>,
  )
  return { user, onOpenWorklist }
}

const stepRow = async (label: string) => {
  const list = await screen.findByRole('list', { name: 'Cascade steps' })
  return within(list).getByText(label).closest('li')!
}

describe('Cascade page', () => {
  it('lists every step with its count, rate and denominator', async () => {
    draw()
    const list = await screen.findByRole('list', { name: 'Cascade steps' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(STEPS.length)
    const row = await stepRow('EAC session 3')
    expect(within(row).getByText('600')).toBeInTheDocument()
    expect(within(row).getByText('75.0%')).toBeInTheDocument()
    expect(within(row).getByText('of 800 (#2)')).toBeInTheDocument()
  })

  it('shows loss only where one step follows directly from another', async () => {
    draw()
    expect(within(await stepRow('EAC commenced')).getByText('−200')).toBeInTheDocument()
    expect(within(await stepRow('EAC completed')).getByText('−100')).toBeInTheDocument()   // from session 3
    // Extended EAC is not a drop from session 3, and a follow-up sample is not a drop from EAC.
    expect(within(await stepRow('Extended EAC (4+)')).queryByText(/−/)).not.toBeInTheDocument()
    expect(within(await stepRow('Follow-up VL sample')).queryByText(/−/)).not.toBeInTheDocument()
  })

  it('opens the worklist behind a step', async () => {
    const { user, onOpenWorklist } = draw()
    await user.click(within(await stepRow('Post-EAC VL sample'))
      .getByRole('button', { name: /Open worklist: No post-EAC VL sample/ }))
    expect(onOpenWorklist).toHaveBeenCalledWith('awaiting_vl')
  })

  it('switches the bars to a split by sex, with a legend', async () => {
    const { user } = draw()
    await screen.findByRole('list', { name: 'Cascade steps' })
    expect(screen.queryByText('Sex not recorded')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'By sex' }))
    expect(screen.getByRole('button', { name: 'By sex' })).toHaveAttribute('aria-pressed', 'true')
    // The legend, not the filter bar's Female/Male toggle.
    const legend = screen.getByText('Sex not recorded').closest('div')!
    expect(within(legend).getByText('Female')).toBeInTheDocument()
    expect(within(legend).getByText('Male')).toBeInTheDocument()
  })

  it('counts the gaps where the cohort is lost, and links them to worklists', async () => {
    const { user, onOpenWorklist } = draw()
    const lost = await screen.findByRole('list', { name: 'Losses by gap' })
    const row = (label: string) => within(lost).getByText(label).closest('li')!
    expect(within(row('Never commenced EAC')).getByText('200')).toBeInTheDocument()
    expect(within(row('At session 3, not yet 30 days on')).getByText('100')).toBeInTheDocument()
    expect(within(row('Still unsuppressed, awaiting DTC review')).getByText('180')).toBeInTheDocument()
    // The 30-day wait is not a loss, so it has no worklist to open.
    expect(within(row('At session 3, not yet 30 days on')).queryByRole('button')).not.toBeInTheDocument()
    await user.click(within(row('Started, stopped before session 3')).getByRole('button'))
    expect(onOpenWorklist).toHaveBeenCalledWith('eac_incomplete')
  })

  it('splits the whole cohort by follow-up outcome, and the parts add up', async () => {
    draw()
    const out = await screen.findByRole('list', { name: 'Follow-up VL outcome' })
    const n = within(out).getAllByRole('listitem').map((li) => Number(li.querySelector('.font-medium')!.textContent!.replace(/,/g, '')))
    expect(n).toEqual([300, 150, 200, 350])
    expect(n.reduce((a, b) => a + b, 0)).toBe(1000)
  })
})
