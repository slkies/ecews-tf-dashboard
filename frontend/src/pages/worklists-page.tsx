import { createColumnHelper } from '@tanstack/react-table'
import { Download, ListChecks } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from 'cn'
import { DataTable, SortableHeader } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import FilterBar, { PinFiltersToggle } from '@/components/filter-bar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/core/api'
import { downloadExport } from '@/core/download'
import { useFilters } from '@/core/filters'
import { DASH, fmt, fmtDate } from '@/core/format'
import { useSession } from '@/core/session'

/** The worklists the backend defines (FLAGS in main.py), in the order a team works them. */
export const WORKLISTS: { flag: string; label: string; group: 'Needs action' | 'Context and data checks' }[] = [
  { flag: 'no_eac', label: 'Unsuppressed with no valid EAC record', group: 'Needs action' },
  { flag: 'eac_incomplete', label: 'Started EAC but not completed', group: 'Needs action' },
  { flag: 'awaiting_vl', label: 'Completed EAC 30+ days ago, no post-EAC VL sample', group: 'Needs action' },
  { flag: 'awaiting_switch', label: 'Still unsuppressed after EAC, awaiting DTC review', group: 'Needs action' },
  { flag: 'dtc_review', label: 'More than 2 EAC cycles, still failing', group: 'Needs action' },
  { flag: 'never_retested', label: 'Active, unsuppressed over a year, never retested', group: 'Needs action' },
  { flag: 'long_unsuppressed', label: 'Unsuppressed for more than 6 months', group: 'Needs action' },
  { flag: 'exited_no_vl', label: 'Left care before a repeat VL', group: 'Needs action' },
  { flag: 'prior_switch', label: 'Already switched before the index VL', group: 'Context and data checks' },
  { flag: 'trunc_pre', label: 'Sample taken before EAC session 1', group: 'Context and data checks' },
  { flag: 'trunc_mid', label: 'Sample taken mid-cycle, before session 3', group: 'Context and data checks' },
  { flag: 'prior_cycle', label: 'EAC session predates the index VL', group: 'Context and data checks' },
]

const ROW_LIMIT = 5000

export interface ClientRow {
  episode: string
  sn: string
  state: string | null
  lga: string | null
  facility: string | null
  sex: string | null
  age: number | null
  art_status: string | null
  idx_vl: number | null
  recv_date: string | null
  idx_samp: string | null
  idx_date: string | null
  sessions: number | null
  eac_completed: boolean | null
  fu_vl: number | null
  still_unsuppressed: boolean | null
  switched: boolean | null
  months_unsuppressed: number | null
  treatment_plan: string | null
}

const LABELS: Record<string, string> = {
  sn: 'Client', facility: 'Facility', state: 'State', sex: 'Sex', age: 'Age',
  art_status: 'ART status', idx_vl: 'Index VL', recv_date: 'Result received',
  sessions: 'EAC sessions', fu_vl: 'Follow-up VL', months_unsuppressed: 'Months unsuppressed',
  treatment_plan: 'Plan',
}

const col = createColumnHelper<DataTableFeatures, ClientRow>()

function useColumns() {
  return useMemo(() => col.columns([
    col.display({
      id: 'select',
      header: ({ table }) => (
        <Checkbox checked={table.getIsAllPageRowsSelected()}
                  indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
                  onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
                  aria-label="Select every row on this page" />
      ),
      cell: ({ row }) => (
        <Checkbox checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)}
                  aria-label={`Select client ${row.original.sn}`} />
      ),
      enableSorting: false,
      enableHiding: false,
    }),
    col.accessor('sn', {
      header: ({ column }) => <SortableHeader column={column} title="Client" />,
      // S/N is a pseudonymous key. Shortened for width; the full key is on hover.
      cell: ({ getValue }) => (
        <span className="font-mono text-xs text-muted-foreground" title={getValue()}>
          {String(getValue()).slice(0, 10)}…
        </span>
      ),
      enableHiding: false,
    }),
    col.accessor('facility', {
      header: ({ column }) => <SortableHeader column={column} title="Facility" />,
      cell: ({ getValue }) => (
        <span className="block max-w-[16rem] truncate" title={getValue() ?? undefined}>{getValue() ?? DASH}</span>
      ),
    }),
    col.accessor('state', {
      header: ({ column }) => <SortableHeader column={column} title="State" />,
      cell: ({ getValue }) => getValue() ?? DASH,
    }),
    col.accessor('sex', { header: 'Sex', cell: ({ getValue }) => getValue() ?? DASH, enableSorting: false }),
    col.accessor('age', {
      header: ({ column }) => <SortableHeader column={column} title="Age" align="right" />,
      cell: ({ getValue }) => <span className="block text-right tabular-nums">{getValue() ?? DASH}</span>,
    }),
    col.accessor('idx_vl', {
      header: ({ column }) => <SortableHeader column={column} title="Index VL" align="right" />,
      cell: ({ getValue }) => <span className="block text-right tabular-nums">{fmt(getValue())}</span>,
    }),
    col.accessor('recv_date', {
      header: ({ column }) => <SortableHeader column={column} title="Result received" />,
      // The date the result reached the facility, not the day blood was drawn:
      // every quarter and trend is bucketed on this one, a median 15 days later.
      cell: ({ row }) => (
        <span className="tabular-nums" title={`Sample collected ${fmtDate(row.original.idx_samp)}`}>
          {fmtDate(row.original.recv_date ?? row.original.idx_date)}
        </span>
      ),
    }),
    col.accessor('sessions', {
      header: ({ column }) => <SortableHeader column={column} title="Sessions" align="right" />,
      cell: ({ getValue }) => <span className="block text-right tabular-nums">{getValue() ?? 0}</span>,
    }),
    col.accessor('fu_vl', {
      header: ({ column }) => <SortableHeader column={column} title="Follow-up VL" align="right" />,
      cell: ({ row }) => (
        <span className={cn('block text-right tabular-nums', row.original.still_unsuppressed && 'font-medium text-bad')}>
          {fmt(row.original.fu_vl)}
          {row.original.still_unsuppressed && <span className="sr-only"> (still unsuppressed)</span>}
        </span>
      ),
    }),
    col.accessor('months_unsuppressed', {
      header: ({ column }) => <SortableHeader column={column} title="Months" align="right" />,
      cell: ({ getValue }) => <span className="block text-right tabular-nums">{getValue() ?? DASH}</span>,
    }),
    col.accessor('art_status', {
      header: ({ column }) => <SortableHeader column={column} title="ART status" />,
      cell: ({ getValue }) => getValue() ?? DASH,
    }),
    col.accessor('treatment_plan', {
      header: 'Plan',
      cell: ({ getValue }) => (
        <span className="block max-w-[12rem] truncate" title={getValue() ?? undefined}>{getValue() ?? DASH}</span>
      ),
      enableSorting: false,
    }),
  ]), [])
}

export default function WorklistsPage() {
  const { query, options } = useFilters()
  const { me } = useSession()
  const canExport = me?.role === 'admin' || me?.role === 'analyst'
  const columns = useColumns()

  const [counts, setCounts] = useState<Record<string, number | null> | null>(null)
  const [flag, setFlag] = useState<string | null>(null)
  const [rows, setRows] = useState<ClientRow[] | null>(null)
  const [loadingRows, setLoadingRows] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'selected' | 'all' | null>(null)
  const [exportErr, setExportErr] = useState<string | null>(null)

  // Counts for every list, under the current filters.
  useEffect(() => {
    if (!options) return
    let cancelled = false
    api<{ flag: string; n: number | null }[]>(`/worklists${query}`)
      .then((r) => {
        if (cancelled) return
        const c = Object.fromEntries(r.map((x) => [x.flag, x.n]))
        setCounts(c)
        // Open the first list that has anyone on it, unless one is already open.
        setFlag((cur) => cur ?? WORKLISTS.find((w) => (c[w.flag] ?? 0) > 0)?.flag ?? WORKLISTS[0]!.flag)
      })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not load the worklists') })
    return () => { cancelled = true }
  }, [query, options])

  // The rows of the open list.
  useEffect(() => {
    if (!flag || !options) return
    let cancelled = false
    setLoadingRows(true)
    const sep = query ? '&' : '?'
    api<ClientRow[]>(`/clients${query}${sep}flag=${flag}&limit=${ROW_LIMIT}`)
      .then((r) => { if (!cancelled) { setRows(r); setErr(null) } })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not load the list') })
      .finally(() => { if (!cancelled) setLoadingRows(false) })
    return () => { cancelled = true }
  }, [flag, query, options])

  const current = WORKLISTS.find((w) => w.flag === flag)
  const total = flag ? counts?.[flag] ?? null : null
  const capped = total != null && total > ROW_LIMIT

  async function runExport(kind: 'selected' | 'all', selected: ClientRow[]) {
    if (!flag) return
    setExporting(kind); setExportErr(null)
    try {
      const sep = query ? '&' : '?'
      if (kind === 'selected') {
        await downloadExport(`/export${query}`, { flag, episodes: selected.map((r) => r.episode) })
      } else {
        await downloadExport(`/export${query}${sep}flag=${flag}`)
      }
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-balance">Worklists</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The episodes each follow-up step is waiting on, under the filters below. Choose a
            list, sort and search it, and select the rows a team will work.
          </p>
        </div>
        <PinFiltersToggle />
      </div>

      <FilterBar />

      {err && (
        <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav aria-label="Worklists" className="flex flex-col gap-4">
          {(['Needs action', 'Context and data checks'] as const).map((group) => (
            <div key={group} className="flex flex-col gap-1">
              <span className="px-2 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                {group}
              </span>
              {WORKLISTS.filter((w) => w.group === group).map((w) => {
                const n = counts?.[w.flag]
                const on = w.flag === flag
                return (
                  <button key={w.flag} type="button" onClick={() => setFlag(w.flag)}
                          aria-current={on ? 'true' : undefined}
                          className={cn(
                            'flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                            on ? 'bg-accent text-accent-foreground ring-1 ring-primary/25' : 'hover:bg-muted',
                          )}>
                    <span className="leading-snug">{w.label}</span>
                    {counts === null
                      ? <Skeleton className="mt-0.5 h-4 w-8" />
                      : <span className={cn('mt-0.5 shrink-0 text-xs font-medium tabular-nums',
                                            n ? 'text-foreground' : 'text-muted-foreground')}>
                          {n == null ? DASH : fmt(n)}
                        </span>}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-balance">{current?.label ?? 'Worklist'}</CardTitle>
            <CardDescription>
              {total == null ? DASH : `${fmt(total)} ${total === 1 ? 'episode' : 'episodes'}`}
              {capped && ` · the table shows the first ${fmt(ROW_LIMIT)}; export for the full list`}
              {canExport && ' · exports carry active clients only, because the others cannot be actioned'}
            </CardDescription>
            <CardAction><ListChecks className="size-5 text-muted-foreground" aria-hidden /></CardAction>
          </CardHeader>
          <CardContent>
            {exportErr && (
              <Alert variant="destructive" className="mb-3"><AlertDescription>{exportErr}</AlertDescription></Alert>
            )}
            {rows === null || (loadingRows && !rows.length) ? (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the list">
                {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
              </div>
            ) : !rows.length ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><ListChecks /></EmptyMedia>
                  <EmptyTitle>No one is on this list</EmptyTitle>
                  <EmptyDescription>Under the current filters, no episode is waiting at this step.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className={cn('transition-opacity', loadingRows && 'pointer-events-none opacity-60')}>
                <DataTable key={`${flag}${query}`} columns={columns} data={rows}
                           getRowId={(r) => r.episode} searchColumn="facility"
                           searchPlaceholder="Search facilities" columnLabels={LABELS}
                           // Off by default so the table fits a laptop; the list
                           // is mostly Active anyway, and exports are Active only.
                           hiddenColumns={['art_status']}
                           caption={current?.label} emptyText="No facility matches that search."
                           actions={(selected) => canExport && (
                             <>
                               <Button variant="outline" size="sm" disabled={!selected.length || exporting !== null}
                                       onClick={() => runExport('selected', selected)}>
                                 {exporting === 'selected' ? <Spinner /> : <Download />}
                                 Export selected{selected.length ? ` (${fmt(selected.length)})` : ''}
                               </Button>
                               <Button size="sm" disabled={exporting !== null}
                                       onClick={() => runExport('all', selected)}>
                                 {exporting === 'all' ? <Spinner /> : <Download />}
                                 Export all active
                               </Button>
                             </>
                           )} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
