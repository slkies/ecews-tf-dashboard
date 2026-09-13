/**
 * The filter bar as someone meets it: several values per filter, the grouping
 * that finds a facility by its state, and a visible, removable record of what
 * is applied.
 *
 * Opening a Base UI combobox popup cannot be tested here: jsdom does not
 * implement the layout and pointer behaviour it relies on, and shadcn's own
 * unmodified combobox crashes the test worker when clicked. The popups are
 * exercised in a real browser (src/dev/filter-harness.tsx). These tests drive
 * the selection through the filter context instead, which is the same path a
 * popup choice takes.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider, useFilters, type Selection } from '@/core/filters'
import FilterBar, { byState } from './filter-bar'

const OPTIONS = {
  states: ['Delta', 'Osun'],
  lgas: ['Aniocha North', 'Osogbo'],
  lga_res: ['Aniocha North', 'Edo LGA'],
  facilities: ['Delta Clinic', 'Osun Clinic'],
  age_bands: ['0-9', '10-19', '20+'],
  quarters: ['FY25Q4', 'FY26Q1'],
  fys: ['FY25', 'FY26'],
  months: [{ m: '2026-08', n: 312 }],
  plans: ['Continue'],
  lga_state: { 'Aniocha North': 'Delta', Osogbo: 'Osun' },
  facility_state: { 'Delta Clinic': 'Delta', 'Osun Clinic': 'Osun' },
}

/** Applies a selection once the options have loaded, as a popup choice would. */
function Seed({ selection }: { selection: Selection }) {
  const { options, set } = useFilters()
  useEffect(() => {
    if (!options) return
    for (const [k, v] of Object.entries(selection)) set(k as keyof Selection, v ?? [])
  }, [options]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function QuerySpy() {
  const { query } = useFilters()
  return <output data-testid="query">{query}</output>
}

function setup(selection?: Selection) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OPTIONS }))
  const user = userEvent.setup()
  render(
    <FilterProvider>
      {selection && <Seed selection={selection} />}
      <FilterBar /><QuerySpy />
    </FilterProvider>,
  )
  return user
}

afterEach(() => { vi.unstubAllGlobals() })

describe('FilterBar', () => {
  it('offers every filter, each reading "All" until something is chosen', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('Fiscal year')).toBeInTheDocument())
    for (const l of ['Fiscal year', 'Enrolment quarter', 'Month', 'State', 'LGA (service)',
                     'LGA (residence)', 'Facility', 'Age band', 'Treatment plan']) {
      expect(screen.getByLabelText(`${l}: All`)).toBeInTheDocument()
    }
    expect(screen.getByRole('group', { name: 'Sex' })).toBeInTheDocument()
    expect(screen.getByTestId('query')).toHaveTextContent('')
  })

  it('summarises several chosen values on the button and lists each as a chip', async () => {
    setup({ age_band: ['0-9', '10-19'] })
    expect(await screen.findByLabelText('Age band: 2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Age band 0-9' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Age band 10-19' })).toBeInTheDocument()
    expect(screen.getByTestId('query')).toHaveTextContent('?age_band=0-9&age_band=10-19')
  })

  it('shows a month by name and episode count, while sending its YYYY-MM value', async () => {
    setup({ month: ['2026-08'] })
    expect(await screen.findByLabelText('Month: Aug-26 (312)')).toBeInTheDocument()
    expect(screen.getByTestId('query')).toHaveTextContent('?month=2026-08')
  })

  it('selects sex with a toggle, where none pressed means both', async () => {
    const user = setup()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Sex' })).toBeInTheDocument())
    await user.click(within(screen.getByRole('group', { name: 'Sex' })).getByRole('button', { name: 'Female' }))
    await waitFor(() => expect(screen.getByTestId('query')).toHaveTextContent('?sex=Female'))
  })

  it('removes one value from its chip, and resets everything at once', async () => {
    const user = setup({ sex: ['Female', 'Male'], age_band: ['0-9'] })
    await user.click(await screen.findByRole('button', { name: 'Remove Sex Female' }))
    await waitFor(() => expect(screen.getByTestId('query')).toHaveTextContent('?sex=Male&age_band=0-9'))

    await user.click(screen.getByRole('button', { name: 'Reset all' }))
    await waitFor(() => expect(screen.getByTestId('query')).toHaveTextContent(''))
    expect(screen.queryByText('Filtered by')).not.toBeInTheDocument()
  })

  it('stops a facility filter surviving a change of state it no longer belongs to', async () => {
    setup({ facility: ['Osun Clinic'], state: ['Delta'] })
    await waitFor(() => expect(screen.getByTestId('query')).toHaveTextContent('?state=Delta'))
    expect(screen.getByTestId('query')).not.toHaveTextContent('facility=')
    expect(screen.getByLabelText('Facility: All')).toBeInTheDocument()
  })

  it('says why the bar is missing rather than hiding silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({ detail: 'No current upload' }),
    }))
    render(<FilterProvider><FilterBar /></FilterProvider>)
    expect(await screen.findByText('No data loaded')).toBeInTheDocument()
    expect(screen.getByText(/No current upload/)).toBeInTheDocument()
  })
})

describe('byState', () => {
  it('groups values under their state, in the order states are offered', () => {
    expect(byState(['Osun Clinic', 'Delta Clinic'], OPTIONS.facility_state, OPTIONS.states)).toEqual([
      { value: 'Delta', items: ['Delta Clinic'] },
      { value: 'Osun', items: ['Osun Clinic'] },
    ])
  })

  it('puts a value with no known state last, under Other, rather than dropping it', () => {
    const g = byState(['Delta Clinic', 'Mystery Site'], OPTIONS.facility_state, OPTIONS.states)
    expect(g[g.length - 1]).toEqual({ value: 'Other', items: ['Mystery Site'] })
  })
})
