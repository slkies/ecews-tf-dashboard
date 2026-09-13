/**
 * The Worklists page: counts for every list, the open list as a table, and an
 * export of the selection that goes through the server, never the browser.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider } from '@/core/filters'
import { SessionProvider } from '@/core/session'
import WorklistsPage, { WORKLISTS, type ClientRow } from './worklists-page'

const OPTIONS = {
  states: ['Delta'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [],
  fys: [], months: [], plans: [], lga_state: {}, facility_state: {},
}

const row = (i: number, extra: Partial<ClientRow> = {}): ClientRow => ({
  episode: `0.10000000000${i}|2026-01-15`, sn: `0.10000000000${i}`, state: 'Delta', lga: 'Delta LGA 1',
  facility: `Delta Facility ${i}`, sex: 'Female', age: 30 + i, art_status: 'Active', idx_vl: 5000 + i,
  recv_date: '2026-01-30', idx_samp: '2026-01-15', idx_date: '2026-01-15', sessions: 1,
  eac_completed: false, fu_vl: null, still_unsuppressed: null, switched: null,
  months_unsuppressed: 8, treatment_plan: 'Repeat EAC', ...extra,
})

let calls: { url: string; init?: RequestInit }[] = []

function mockApi(role: 'admin' | 'viewer') {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b,
                                    headers: new Headers(), blob: async () => new Blob(['x']) })
    if (url.startsWith('/api/me')) return json({ username: 'u', email: 'u@x', name: 'U', role, scope_state: null, scope_facility: null })
    if (url.startsWith('/api/filters')) return json(OPTIONS)
    if (url.startsWith('/api/worklists')) {
      return json(WORKLISTS.map((w) => ({ flag: w.flag, n: w.flag === 'eac_incomplete' ? 3 : 0 })))
    }
    if (url.startsWith('/api/clients')) return json([row(1), row(2), row(3, { still_unsuppressed: true, fu_vl: 4200 })])
    if (url.startsWith('/api/export')) {
      return { ok: true, status: 200, json: async () => ({}), blob: async () => new Blob(['csv']),
               headers: new Headers({ 'Content-Disposition': 'attachment; filename="x.csv"' }) }
    }
    return json({})
  }))
}

beforeEach(() => {
  sessionStorage.setItem('ecews.session', 'token')
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  // The download link's click would ask jsdom to navigate, which it cannot.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

function draw() {
  const user = userEvent.setup()
  render(<SessionProvider><FilterProvider><WorklistsPage /></FilterProvider></SessionProvider>)
  return user
}

describe('Worklists page', () => {
  it('lists every worklist with its count, grouped by what it is for', async () => {
    mockApi('viewer')
    draw()
    const nav = await screen.findByRole('navigation', { name: 'Worklists' })
    expect(within(nav).getByText('Needs action')).toBeInTheDocument()
    expect(within(nav).getByText('Context and data checks')).toBeInTheDocument()
    await waitFor(() => expect(within(nav).getAllByRole('button')).toHaveLength(WORKLISTS.length))
  })

  it('opens the first list that has anyone on it, and shows its rows', async () => {
    mockApi('viewer')
    draw()
    const open = await screen.findByRole('button', { current: true })
    expect(open).toHaveTextContent('Started EAC but not completed')
    expect(await screen.findByText('Delta Facility 2')).toBeInTheDocument()
    expect(screen.getByText('3 episodes')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('/api/clients') && c.url.includes('flag=eac_incomplete'))).toBe(true)
  })

  it('marks a follow-up VL still at or above 1,000 in words as well as colour', async () => {
    mockApi('viewer')
    draw()
    expect(await screen.findByText('(still unsuppressed)')).toBeInTheDocument()
  })

  it('offers no export to a viewer', async () => {
    mockApi('viewer')
    draw()
    await screen.findByText('Delta Facility 1')
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
  })

  it('exports the selected episodes through the server, by episode key', async () => {
    mockApi('admin')
    const user = draw()
    await screen.findByText('Delta Facility 1')
    const exportSelected = screen.getByRole('button', { name: /Export selected/ })
    expect(exportSelected).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: 'Select client 0.100000000001' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select client 0.100000000003' }))
    await user.click(screen.getByRole('button', { name: 'Export selected (2)' }))

    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/export') && c.init?.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.url.startsWith('/api/export') && c.init?.method === 'POST')!
    expect(JSON.parse(String(post.init!.body))).toEqual({
      flag: 'eac_incomplete',
      episodes: ['0.100000000001|2026-01-15', '0.100000000003|2026-01-15'],
    })
  })

  it('exports the whole active list with a GET for that flag', async () => {
    mockApi('admin')
    const user = draw()
    await screen.findByText('Delta Facility 1')
    await user.click(screen.getByRole('button', { name: 'Export all active' }))
    await waitFor(() => expect(calls.some((c) =>
      c.url.startsWith('/api/export') && c.url.includes('flag=eac_incomplete') && c.init?.method === 'GET')).toBe(true))
  })
})
