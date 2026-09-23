/**
 * DTC review: the headline split, the switch gap, the log-drop reading, the
 * laboratory queue, the trajectories, and the way through to a worklist.
 * Figures are synthetic (src/dev/dtc-fixture.ts).
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider } from '@/core/filters'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import { AWAITING, DTC, TRAJ } from '@/dev/dtc-fixture'
import DtcPage, { vlShort } from './dtc-page'

const OPTIONS = {
  states: ['Delta'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [],
  fys: [], months: [], plans: [], lga_state: {}, facility_state: {},
}
let urls: string[] = []

function mock(dtc: unknown = DTC) {
  urls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, headers: new Headers() })
    if (url.startsWith('/api/me')) return json({ username: 'u', email: 'u@x', name: 'U', role: 'viewer', scope_state: null, scope_facility: null })
    if (url.startsWith('/api/filters')) return json(OPTIONS)
    if (url.startsWith('/api/dtc/awaiting')) return json(AWAITING)
    if (url.startsWith('/api/dtc/trajectory')) return json(TRAJ)
    if (url.startsWith('/api/dtc')) return json(dtc)
    return json({})
  }))
}

beforeEach(() => { sessionStorage.setItem('ecews.session', 'token') })
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function draw(onOpenWorklist = vi.fn()) {
  const user = userEvent.setup()
  render(<ThemeProvider><SessionProvider><FilterProvider>
    <DtcPage onOpenWorklist={onOpenWorklist} />
  </FilterProvider></SessionProvider></ThemeProvider>)
  return { user, onOpenWorklist }
}
const ready = () => screen.findByText('1st line at index, still 1st')
const section = (t: RegExp) => screen.getByRole('heading', { name: t }).closest('section')!

describe('DTC review page', () => {
  it('shortens viral loads the way clinicians read them', () => {
    expect(vlShort(412000)).toBe('412k')
    expect(vlShort(1_200_000)).toBe('1.2M')
    expect(vlShort(3_000_000)).toBe('3M')
    expect(vlShort(640)).toBe('640')
    expect(vlShort(null)).toBe('—')
  })

  it('asks for a bounded number of client rows', async () => {
    mock()
    draw()
    await ready()
    expect(urls.some((u) => u.startsWith('/api/dtc/awaiting') && u.includes('limit=200'))).toBe(true)
    expect(urls.some((u) => u.startsWith('/api/dtc/trajectory') && u.includes('limit=300'))).toBe(true)
  })

  it('shows the switch gap by state with the awaiting count against the total', async () => {
    mock()
    draw()
    await ready()
    const byState = screen.getByRole('list', { name: 'Switch gap by state' })
    const delta = within(byState).getByText('Delta').closest('li')!
    expect(delta).toHaveTextContent('262')
    expect(delta).toHaveTextContent('awaiting of 380')
  })

  it('reads the fall in viral load, with the no-response call-out', async () => {
    mock()
    draw()
    await ready()
    const bands = screen.getByRole('list', { name: 'Fall in viral load' })
    expect(within(bands).getAllByRole('listitem')).toHaveLength(5)
    expect(section(/responding at all/)).toHaveTextContent('188 episodes completed a full EAC cycle')
  })

  it('shows the laboratory queue with its long waits', async () => {
    mock()
    draw()
    await ready()
    const q = section(/result not yet returned/)
    expect(within(q).getByText('38')).toBeInTheDocument()          // waiting 60+ days
    expect(q).toHaveTextContent('2 sample(s) are dated after the line list')
  })

  it('lists trajectories with their pattern, 25 to a page', async () => {
    mock()
    draw()
    await ready()
    const t = section(/Viral load trajectory/)
    expect(within(t).getAllByText('Rebound after suppression').length).toBeGreaterThan(0)
    expect(within(t).getByText('Page 1 of 2')).toBeInTheDocument()
  })

  it('opens the DTC worklists', async () => {
    mock()
    const { user, onOpenWorklist } = draw()
    await ready()
    const act = section(/Intervention worklists/)
    const prior = within(act).getByText(/Prior switch: 2nd\/3rd line/).closest('tr')!
    await user.click(within(prior).getByRole('button', { name: /Open/ }))
    expect(onOpenWorklist).toHaveBeenCalledWith('prior_switch')
  })

  it('says so when the selection is empty', async () => {
    mock({ ok: false })
    draw()
    expect(await screen.findByText('No episodes in this selection')).toBeInTheDocument()
  })
})
