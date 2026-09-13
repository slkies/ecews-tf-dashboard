/**
 * The data table's own behaviour: paging, sorting, the column search, and a
 * selection count that stays true across all of them. The Columns menu and
 * rows-per-page select are popups, which jsdom cannot open (see incident 13);
 * they are checked in a real browser through src/dev/worklists-harness.tsx.
 */
import { createColumnHelper } from '@tanstack/react-table'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, SortableHeader } from './data-table'
import type { DataTableFeatures } from './data-table-features'

interface Row { id: string; facility: string; n: number }

const col = createColumnHelper<DataTableFeatures, Row>()
const columns = col.columns([
  col.display({
    id: 'select',
    header: ({ table }) => (
      <Checkbox checked={table.getIsAllPageRowsSelected()}
                onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} aria-label="Select page" />
    ),
    cell: ({ row }) => (
      <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)}
                aria-label={`Select ${row.original.id}`} />
    ),
    enableSorting: false,
    enableHiding: false,
  }),
  col.accessor('facility', { header: ({ column }) => <SortableHeader column={column} title="Facility" /> }),
  col.accessor('n', { header: ({ column }) => <SortableHeader column={column} title="Episodes" /> }),
])

const DATA: Row[] = Array.from({ length: 30 }, (_, i) => ({
  id: `r${i + 1}`, facility: i % 2 ? `Osun Facility ${i + 1}` : `Delta Facility ${i + 1}`, n: 100 - i,
}))

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

function setup() {
  const user = userEvent.setup()
  render(<DataTable columns={columns} data={DATA} getRowId={(r) => r.id}
                    searchColumn="facility" searchPlaceholder="Search facilities" caption="Test list" />)
  return user
}

describe('DataTable', () => {
  it('pages rows 25 at a time and says where you are', async () => {
    const user = setup()
    expect(bodyRows()).toHaveLength(25)
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(bodyRows()).toHaveLength(5)
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('sorts a column when its header is clicked, and marks the header', async () => {
    const user = setup()
    await user.click(screen.getByRole('button', { name: 'Episodes' }))
    expect(within(bodyRows()[0]!).getByText('71')).toBeInTheDocument()     // ascending: smallest first
    const th = screen.getByRole('button', { name: 'Episodes' }).closest('th')!
    expect(th).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: 'Episodes' }))
    expect(within(bodyRows()[0]!).getByText('100')).toBeInTheDocument()
    expect(th).toHaveAttribute('aria-sort', 'descending')
  })

  it('searches one column', async () => {
    const user = setup()
    await user.type(screen.getByRole('textbox', { name: 'Search facilities' }), 'Osun')
    expect(bodyRows()).toHaveLength(15)
    expect(screen.queryByText(/Delta Facility/)).not.toBeInTheDocument()
  })

  it('counts a selection against the rows in view', async () => {
    const user = setup()
    expect(screen.getByText('0 of 30 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Select r1' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select r2' }))
    expect(screen.getByText('2 of 30 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Select page' }))
    expect(screen.getByText('25 of 30 selected')).toBeInTheDocument()
  })

  it('hands the selected rows to the actions it was given', async () => {
    const user = userEvent.setup()
    render(<DataTable columns={columns} data={DATA} getRowId={(r) => r.id}
                      actions={(selected) => <output data-testid="picked">{selected.map((s) => s.id).join(',')}</output>} />)
    await user.click(screen.getByRole('checkbox', { name: 'Select r3' }))
    expect(screen.getByTestId('picked')).toHaveTextContent('r3')
  })

  it('says so when a search matches nothing', async () => {
    const user = userEvent.setup()
    render(<DataTable columns={columns} data={DATA} searchColumn="facility"
                      searchPlaceholder="Search facilities" emptyText="No facility matches that search." />)
    await user.type(screen.getByRole('textbox', { name: 'Search facilities' }), 'Ekiti')
    expect(screen.getByText('No facility matches that search.')).toBeInTheDocument()
  })
})
