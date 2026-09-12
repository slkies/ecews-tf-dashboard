/**
 * The filter bar as a user meets it.
 *
 * The behaviour worth pinning: selecting several values at once (which is the
 * whole reason the bar was rewritten - "all paediatrics and adolescents" was
 * impossible), and the cascade that stops a stale child selection quietly
 * filtering the page down to nothing.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterProvider, useFilters } from '../core/filters'
import FilterBar from './FilterBar'

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

function mockFilters() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => OPTIONS,
  }))
}

/** Surfaces the query string the rest of the app would send. */
function QuerySpy() {
  const { query } = useFilters()
  return <output data-testid="query">{query}</output>
}

function setup() {
  mockFilters()
  return render(
    <FilterProvider><FilterBar /><QuerySpy /></FilterProvider>,
  )
}

/** Open one filter's checkbox panel and return it. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const group = screen.getByText(label).closest('.f') as HTMLElement
  await user.click(within(group).getByRole('button'))
  return within(group).getByRole('group')
}

afterEach(() => { vi.unstubAllGlobals() })

describe('FilterBar', () => {
  it('shows every filter, all reading "All" before anything is chosen', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('Fiscal year')).toBeInTheDocument())
    for (const l of ['Fiscal year', 'Enrolment quarter', 'Month', 'State',
                     'LGA (service)', 'LGA (residence)', 'Facility', 'Sex',
                     'Age band', 'Treatment plan']) {
      expect(screen.getByText(l)).toBeInTheDocument()
    }
    // Each button is named "<caption>: <current value>", so every filter
    // reads as "...: All" until something is chosen - the caption alone would
    // not tell a screen-reader user what the filter is set to.
    expect(screen.getAllByRole('button', { name: /: All$/ })).toHaveLength(10)
    expect(screen.getByTestId('query')).toHaveTextContent('')
  })

  it('selects two age bands at once and sends both', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('Age band')).toBeInTheDocument())

    const menu = await openMenu(user, 'Age band')
    await user.click(within(menu).getByLabelText('0-9'))
    await user.click(within(menu).getByLabelText('10-19'))

    expect(screen.getByTestId('query'))
      .toHaveTextContent('?age_band=0-9&age_band=10-19')
  })

  it('summarises the button once more than two values are chosen', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('Age band')).toBeInTheDocument())

    const menu = await openMenu(user, 'Age band')
    for (const b of ['0-9', '10-19', '20+']) {
      await user.click(within(menu).getByLabelText(b))
    }
    const group = screen.getByText('Age band').closest('.f') as HTMLElement
    expect(within(group).getByRole('button', { name: /Age band/ }))
      .toHaveTextContent('3 selected')
  })

  it('narrows facilities to the chosen state', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('State')).toBeInTheDocument())

    const states = await openMenu(user, 'State')
    await user.click(within(states).getByLabelText('Delta'))

    const facilities = await openMenu(user, 'Facility')
    expect(within(facilities).getByLabelText('Delta Clinic')).toBeInTheDocument()
    expect(within(facilities).queryByLabelText('Osun Clinic')).not.toBeInTheDocument()
  })

  it('does NOT narrow residence LGA by the treating state', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('State')).toBeInTheDocument())

    const states = await openMenu(user, 'State')
    await user.click(within(states).getByLabelText('Delta'))

    // A client treated in Delta may live in Edo; hiding that is the bug.
    const res = await openMenu(user, 'LGA (residence)')
    expect(within(res).getByLabelText('Edo LGA')).toBeInTheDocument()
  })

  it('drops a facility selection when the state changes under it', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('Facility')).toBeInTheDocument())

    const facilities = await openMenu(user, 'Facility')
    await user.click(within(facilities).getByLabelText('Osun Clinic'))
    expect(screen.getByTestId('query')).toHaveTextContent('facility=Osun+Clinic')

    const states = await openMenu(user, 'State')
    await user.click(within(states).getByLabelText('Delta'))

    // Keeping it would ask for a facility outside the chosen state, which
    // returns nothing and reads on screen as "no data" rather than as a
    // contradiction.
    expect(screen.getByTestId('query')).not.toHaveTextContent('facility=')
    expect(screen.getByTestId('query')).toHaveTextContent('state=Delta')
  })

  it('Reset is disabled until something is chosen, then clears everything', async () => {
    const user = userEvent.setup()
    setup()
    await waitFor(() => expect(screen.getByText('Sex')).toBeInTheDocument())

    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeDisabled()

    const sex = await openMenu(user, 'Sex')
    await user.click(within(sex).getByLabelText('Female'))
    expect(reset).toBeEnabled()

    await user.click(reset)
    expect(screen.getByTestId('query')).toHaveTextContent('')
  })

  it('says why the bar is missing rather than hiding silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({ detail: 'No current upload' }),
    }))
    render(<FilterProvider><FilterBar /></FilterProvider>)
    await waitFor(() =>
      expect(screen.getByText('No data loaded')).toBeInTheDocument())
    expect(screen.getByText(/No current upload/)).toBeInTheDocument()
  })
})
