import {
  useTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type ReactTable,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table'
import {
  ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft,
  ChevronsRight, Columns3, Search,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup,
  DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { features, type DataTableFeatures } from './data-table-features'

export type DataTableInstance<TData extends RowData> = ReactTable<DataTableFeatures, TData>

const PAGE_SIZES = [10, 25, 50, 100]

/**
 * A worklist table: sortable headers, a search on one column, a choice of
 * columns, row selection and pagination.
 *
 * Built from shadcn's data-table guide on TanStack Table v9. Selection and
 * the export built on it stay with the caller through `actions`, because what
 * may be done with chosen rows - and who may do it - is not the table's call.
 * Give it a `key` that changes with its data, so a new list starts unselected.
 */
export function DataTable<TData extends RowData>({
  columns, data, getRowId, searchColumn, searchPlaceholder = 'Search',
  columnLabels = {}, emptyText = 'No rows.', actions, caption, hiddenColumns = [],
}: {
  /** Columns that start hidden but can be shown from the Columns menu. */
  hiddenColumns?: string[]
  columns: ColumnDef<DataTableFeatures, TData>[]
  data: TData[]
  getRowId?: (row: TData, index: number) => string
  /** Column id the search box filters. No box without one. */
  searchColumn?: string
  searchPlaceholder?: string
  /** Readable names for the Columns menu, keyed by column id. */
  columnLabels?: Record<string, string>
  emptyText?: string
  /** Controls that act on the selection, e.g. export. */
  actions?: (selected: TData[], table: DataTableInstance<TData>) => ReactNode
  /** Names the table for assistive technology. */
  caption?: string
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(
    () => Object.fromEntries(hiddenColumns.map((id) => [id, false])))
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

  const table = useTable({
    features,
    data,
    columns,
    getRowId,
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: { sorting, columnFilters, columnVisibility, rowSelection },
  })

  const selected = table.getFilteredSelectedRowModel().rows.map((r) => r.original)
  const filtered = table.getFilteredRowModel().rows.length
  const { pageIndex, pageSize } = table.state.pagination
  // Leaf columns: a group heading is not itself something to show or hide.
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide())
  const search = searchColumn ? table.getColumn(searchColumn) : undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={(search.getFilterValue() as string) ?? ''}
                   onChange={(e) => search.setFilterValue(e.target.value)}
                   placeholder={searchPlaceholder} aria-label={searchPlaceholder}
                   className="pl-8" />
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions?.(selected, table)}
          {hideable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <Columns3 />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                  {hideable.map((c) => (
                    <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()}
                                              onCheckedChange={(v) => c.toggleVisibility(!!v)}>
                      {columnLabels[c.id] ?? c.id}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {/* 12px: at the body's 14px a worklist of fifteen columns read as crowded. */}
        <Table className="text-xs">
          {caption && <caption className="sr-only">{caption}</caption>}
          <TableHeader className="bg-muted/50">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const s = header.column.getIsSorted()
                  return (
                    <TableHead key={header.id} colSpan={header.colSpan}
                               // A group heading spans its columns and is centred over them.
                               className={cn(header.subHeaders.length > 0 && 'border-b text-center')}
                               aria-sort={s === 'asc' ? 'ascending' : s === 'desc' ? 'descending' : undefined}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length}
                           className="h-24 text-center text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm">
        <span className="text-muted-foreground tabular-nums" aria-live="polite">
          {selected.length.toLocaleString('en-GB')} of {filtered.toLocaleString('en-GB')} selected
        </span>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
              <SelectTrigger size="sm" className="w-[4.5rem]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <span className="tabular-nums">
            Page {pageIndex + 1} of {Math.max(1, table.getPageCount())}
          </span>
          <div className="flex items-center gap-1">
            <PageButton label="First page" onClick={() => table.setPageIndex(0)}
                        disabled={!table.getCanPreviousPage()} className="hidden lg:inline-flex">
              <ChevronsLeft />
            </PageButton>
            <PageButton label="Previous page" onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}>
              <ChevronLeft />
            </PageButton>
            <PageButton label="Next page" onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}>
              <ChevronRight />
            </PageButton>
            <PageButton label="Last page" onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                        disabled={!table.getCanNextPage()} className="hidden lg:inline-flex">
              <ChevronsRight />
            </PageButton>
          </div>
        </div>
      </div>
    </div>
  )
}

function PageButton({ label, onClick, disabled, className, children }: {
  label: string; onClick: () => void; disabled: boolean; className?: string; children: ReactNode
}) {
  return (
    <Button variant="outline" size="icon-sm" onClick={onClick} disabled={disabled}
            aria-label={label} className={className}>
      {children}
    </Button>
  )
}

/** A header that sorts its column: ascending, descending, then back. */
export function SortableHeader<TData extends RowData, TValue>({
  column, title, align = 'left',
}: {
  column: Column<DataTableFeatures, TData, TValue>
  title: string
  align?: 'left' | 'right'
}) {
  if (!column.getCanSort()) return <span>{title}</span>
  const s = column.getIsSorted()
  const Icon = s === 'asc' ? ArrowUp : s === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <Button variant="ghost" size="sm" onClick={() => column.toggleSorting(s === 'asc')}
            className={cn('-mx-2 h-7 gap-1 px-2 text-xs font-medium', align === 'right' && 'ml-auto flex')}>
      {title}
      <Icon className={cn('size-3.5', s ? 'text-foreground' : 'text-muted-foreground')} />
    </Button>
  )
}
