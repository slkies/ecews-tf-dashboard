import { createColumnHelper } from '@tanstack/react-table'
import { ArrowRight, Stethoscope } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { cn } from 'cn'
import { DataTable, SortableHeader } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import FilterBar, { PinFiltersToggle } from '@/components/filter-bar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { api } from '@/core/api'
import { useFilters } from '@/core/filters'
import { DASH, fmt, fmtDate, pc } from '@/core/format'

/* ─────────────────────────────────── types ─────────────────────────────────── */

interface GapRow { level: string; still: number; awaiting: number; switched: number; prior: number; pct_awaiting: number | null }
interface OrLevel { level: string; n: number; repeat: number; pct: number | null; ref: boolean
  or_: number | null; or_lo: number | null; or_hi: number | null; or_p: number | null }

export interface Dtc {
  ok: boolean
  summary: { repeat_clients: number; repeat_still_clients: number; repeat_still_episodes: number
    still: number; switched: number; awaiting: number; prior: number; dtc_flag: number }
  repeat_assoc: { n: number; pct: number | null; variables: { label: string; levels: OrLevel[] }[] }
  switch_gap: { n_still: number; by_state: GapRow[]; by_regimen: GapRow[]; by_months: GapRow[]; by_cd4: GapRow[] }
  log_drop: { ok: boolean; n: number; median?: number; no_response_completed_eac?: number
    bands?: { band: string; meaning: string; n: number; pct: number; completed_eac: number }[] }
}

export interface Awaiting {
  ok: boolean; n: number; as_of?: string; median_days?: number | null
  over_30?: number; over_60?: number; future_dated?: number; shown?: number
  by_facility: { facility: string | null; n: number; median_days: number; longest: number }[]
  rows: { facility: string | null; sample_date: string | null; days: number; idx_vl: number | null }[]
}

export interface TrajRow {
  sn: string; facility: string | null; eac_stage: string
  points: { label: string; date: string; value: number; suppressed: boolean; implausible: boolean }[]
  n_results: number; latest_vl: number | null; latest_date: string | null; pattern: string
}
export interface Trajectory { ok: boolean; n: number; shown?: number; rows: TrajRow[] }

/* ─────────────────────────────────── helpers ───────────────────────────────── */

/** 412000 -> 412k, 1.2M. Viral loads span six orders of magnitude. */
export function vlShort(v: number | null | undefined): string {
  if (v == null) return DASH
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`
  return String(Math.round(v))
}

/** The shape of a VL history. Rebound and sharp rise are the switch signals. */
const PATTERN_TONE: Record<string, string> = {
  'Rebound after suppression': 'bg-bad-tint text-bad',
  'Sharp rise': 'bg-bad-tint text-bad',
  Erratic: 'bg-warn-tint text-warn',
  'Persistently high': 'bg-warn-tint text-warn',
  Mixed: 'bg-muted text-muted-foreground',
  'Single result': 'bg-muted text-muted-foreground',
}

/** How far the VL fell. The colour is the reading, so it is never decorative. */
const LOG_TONE: Record<string, string> = {
  'Viral load rose': 'var(--bad)',
  'Fell <0.5 log': 'color-mix(in oklch, var(--bad) 60%, var(--warn))',
  'Fell 0.5-1 log': 'var(--warn)',
  'Fell 1-2 log': 'color-mix(in oklch, var(--good) 65%, var(--warn))',
  'Fell >2 log': 'var(--good)',
}

const withQuery = (path: string, query: string, extra: string) =>
  `${path}${query}${query ? '&' : '?'}${extra}`

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'bad' | 'warn' | 'good' }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn('text-2xl font-semibold', tone && `text-${tone}`)}>{value}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </CardContent>
    </Card>
  )
}

function Section({ eyebrow, title, description, children }: {
  eyebrow: string; title: string; description?: string; children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{eyebrow}</span>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="max-w-4xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

const Swatch = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />{label}
  </span>
)

/* ──────────────────────────────── trajectory table ─────────────────────────── */

const col = createColumnHelper<DataTableFeatures, TrajRow>()

function useTrajectoryColumns() {
  return useMemo(() => col.columns([
    col.accessor('sn', {
      header: 'Client',
      cell: ({ getValue }) => (
        <span className="font-mono text-muted-foreground" title={getValue()}>{String(getValue()).slice(0, 10)}…</span>
      ),
      enableSorting: false, enableHiding: false,
    }),
    col.accessor('facility', {
      header: ({ column }) => <SortableHeader column={column} title="Facility" />,
      cell: ({ getValue }) => <span className="block max-w-[14rem] truncate" title={getValue() ?? undefined}>{getValue() ?? DASH}</span>,
    }),
    col.accessor('eac_stage', {
      header: ({ column }) => <SortableHeader column={column} title="EAC" />,
    }),
    col.display({
      id: 'trajectory',
      header: 'Trajectory, oldest first',
      // One block per result: green below 1,000, red at or above, hatched when
      // implausibly high. Blocks sit in order, not on a time grid - the gaps
      // between tests are irregular.
      cell: ({ row }) => (
        <div className="flex items-center gap-1" role="img"
             aria-label={row.original.points.map((p) => `${p.label} ${fmt(p.value)} on ${p.date}`).join(', ')}>
          {row.original.points.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="text-muted-foreground" aria-hidden>›</span>}
              <span title={`${p.label} · ${fmtDate(p.date)} · ${fmt(p.value)}${p.implausible ? ' (implausibly high)' : ''}`}
                    className={cn('inline-block h-3 w-5 rounded-[3px]',
                                  p.implausible ? 'border border-bad bg-bad-tint' : p.suppressed ? 'bg-good' : 'bg-bad')} />
            </Fragment>
          ))}
        </div>
      ),
    }),
    col.accessor('latest_vl', {
      header: ({ column }) => <SortableHeader column={column} title="Latest VL" align="right" />,
      cell: ({ row }) => (
        <span className="block text-right">
          <span className="font-medium tabular-nums">{vlShort(row.original.latest_vl)}</span>
          <span className="block text-[10px] text-muted-foreground">{fmtDate(row.original.latest_date)}</span>
        </span>
      ),
    }),
    col.accessor('pattern', {
      header: ({ column }) => <SortableHeader column={column} title="Pattern" />,
      cell: ({ getValue }) => (
        <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
                            PATTERN_TONE[getValue()] ?? 'bg-muted text-muted-foreground')}>
          {getValue()}
        </span>
      ),
    }),
  ]), [])
}

/* ──────────────────────────────────── page ─────────────────────────────────── */

export default function DtcPage({ onOpenWorklist }: { onOpenWorklist?: (flag: string) => void }) {
  const { query, options } = useFilters()
  const [d, setD] = useState<Dtc | null>(null)
  const [aw, setAw] = useState<Awaiting | null>(null)
  const [traj, setTraj] = useState<Trajectory | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const columns = useTrajectoryColumns()

  useEffect(() => {
    if (!options) return
    let off = false
    setLoading(true)
    Promise.all([
      api<Dtc>(`/dtc${query}`),
      api<Awaiting>(withQuery('/dtc/awaiting', query, 'limit=200')),
      api<Trajectory>(withQuery('/dtc/trajectory', query, 'limit=300')),
    ])
      .then(([a, b, c]) => { if (!off) { setD(a); setAw(b); setTraj(c); setErr(null) } })
      .catch((e: unknown) => { if (!off) setErr(e instanceof Error ? e.message : 'Could not load DTC review') })
      .finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [query, options])

  const head = (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-balance">DTC review</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Episodes still at or above 1,000 after the follow-up viral load: who is waiting for a
            switch decision, whether the virus is responding, what the laboratory still owes, and
            who fails more than once.
          </p>
        </div>
        <PinFiltersToggle />
      </div>
      <FilterBar />
    </>
  )

  if (err) return <div className="flex flex-col gap-6">{head}<Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert></div>
  if (!d) {
    return (
      <div className="flex flex-col gap-6">{head}
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }
  if (!d.ok) {
    return (
      <div className="flex flex-col gap-6">{head}
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Stethoscope /></EmptyMedia>
            <EmptyTitle>No episodes in this selection</EmptyTitle>
            <EmptyDescription>Widen the filters to review the switch pathway.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const s = d.summary
  const gap = d.switch_gap
  const L = d.log_drop
  const bandMax = Math.max(1, ...(L.bands ?? []).map((b) => b.n))
  const oneResult = traj?.rows.filter((r) => r.n_results === 1).length ?? 0

  return (
    <div className={cn('flex flex-col gap-8 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
      {head}

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Still at or above 1,000" value={fmt(s.still)} note="after the follow-up VL" tone="warn" />
        <Stat label="Of whom failed more than once" value={fmt(s.repeat_still_clients)} note={`clients, a subset of the ${fmt(s.still)}`} />
        <Stat label="Awaiting DTC review" value={fmt(s.awaiting)} note="1st line at index, still 1st" tone="bad" />
        <Stat label="Prior switch" value={fmt(s.prior)} note="already 2nd/3rd line at index" tone="warn" />
        <Stat label="Switched" value={fmt(s.switched)} note="1st at index, now 2nd/3rd" />
        <Stat label="More than 2 cycles" value={fmt(s.dtc_flag)} note="still failing" tone={s.dtc_flag ? 'warn' : 'good'} />
      </div>

      <Section eyebrow="Switch gap" title="Still unsuppressed after EAC - the DTC pathway"
               description="Every episode still at or above 1,000, split by the regimen line at the index VL. Awaiting review is the true switch backlog. Prior switch means already on 2nd or 3rd line, so the need is a drug-history and VL review, not another switch. The export has no switch date, so this shows who is waiting and where, not why.">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>By state</CardTitle>
              <CardDescription>Each bar is that state's episodes still at or above 1,000.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <Swatch color="var(--bad)" label="Awaiting DTC review" />
                <Swatch color="var(--warn)" label="Prior switch" />
                <Swatch color="var(--primary)" label="Switched" />
              </div>
              <ul className="flex flex-col gap-3" aria-label="Switch gap by state">
                {gap.by_state.map((r) => {
                  const t = r.still || 1
                  const seg = (n: number, c: string, last = false) => (
                    <span className="h-full" style={{ width: `${n / t * 100}%`, background: c,
                      boxShadow: last ? undefined : '2px 0 0 0 var(--card)' }} />
                  )
                  return (
                    <li key={r.level} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span>{r.level}</span>
                        <span className="tabular-nums"><span className="font-medium">{fmt(r.awaiting)}</span>
                          <span className="text-muted-foreground"> awaiting of {fmt(r.still)}</span></span>
                      </div>
                      <div className="flex h-3 w-full overflow-hidden rounded-[4px] bg-muted" aria-hidden>
                        {seg(r.awaiting, 'var(--bad)')}{seg(r.prior, 'var(--warn)')}{seg(r.switched, 'var(--primary)', true)}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader><CardTitle>By regimen line, time unsuppressed and baseline CD4</CardTitle></CardHeader>
            <CardContent className="px-0">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader className="bg-muted/50">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Still at or above 1,000</TableHead>
                      <TableHead className="text-right">Awaiting</TableHead>
                      <TableHead className="text-right">Prior switch</TableHead>
                      <TableHead className="text-right">Switched</TableHead>
                      <TableHead className="text-right">% awaiting</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {([['By regimen line', gap.by_regimen], ['By months unsuppressed', gap.by_months],
                       ['By baseline CD4', gap.by_cd4]] as const).map(([title, rows]) => (
                      <Fragment key={title}>
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={6} className="font-medium text-muted-foreground">{title}</TableCell>
                        </TableRow>
                        {rows.map((r) => (
                          <TableRow key={`${title}${r.level}`}>
                            <TableCell className="pl-5">{r.level}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(r.still)}</TableCell>
                            <TableCell className={cn('text-right tabular-nums', r.awaiting > 0 && 'font-medium text-bad')}>{fmt(r.awaiting)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(r.prior)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(r.switched)}</TableCell>
                            <TableCell className="text-right tabular-nums">{pc(r.pct_awaiting)}</TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section eyebrow="Switch evidence" title="Is the viral load responding at all?"
               description="Still at or above 1,000 hides two opposite situations. A viral load that fell from 400,000 to 3,000 is responding to adherence support, and another cycle may finish the job. One that is unchanged or has risen is not an adherence problem, and another cycle spends months to arrive at the same place. A 1-log fall is a tenfold reduction, the usual threshold for a credible response.">
        <Card>
          <CardContent className="flex flex-col gap-4">
            {L.ok && L.n ? (
              <>
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
                  {fmt(L.no_response_completed_eac)} episodes completed a full EAC cycle and the viral load
                  still fell by less than half a log. Adherence has been addressed and the virus did not
                  respond, which is the clearest switch argument in the data. The median fall across all{' '}
                  {fmt(L.n)} episodes is {L.median} log.
                </p>
                <ul className="flex flex-col gap-3" aria-label="Fall in viral load">
                  {(L.bands ?? []).map((b) => (
                    <li key={b.band} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span>{b.band} <span className="text-muted-foreground">· {b.meaning}</span></span>
                        <span className="tabular-nums"><span className="font-medium">{fmt(b.n)}</span>
                          <span className="ml-2 text-muted-foreground">{pc(b.pct)}</span></span>
                      </div>
                      <span className="h-3 w-full rounded-[4px] bg-muted" aria-hidden>
                        <span className="block h-full rounded-[4px]"
                              style={{ width: `${b.n / bandMax * 100}%`, background: LOG_TONE[b.band] ?? 'var(--primary)' }} />
                      </span>
                      {b.completed_eac > 0 && (
                        <span className="text-xs text-muted-foreground">{fmt(b.completed_eac)} of these completed EAC</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No episodes with both an index and a follow-up viral load in this selection.
              </p>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="Laboratory queue" title="Post-EAC sample collected, result not yet returned"
               description="A repeat sample has been drawn and the laboratory has not reported it. These clients have done their part, so chasing them would be the wrong response. The wait runs to the line list's date, not to today, so the same file always reports the same wait.">
        {aw?.ok && aw.n ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              <Stat label="Samples outstanding" value={fmt(aw.n)} note="post-EAC, no result yet" />
              <Stat label="Median wait" value={`${aw.median_days ?? DASH} days`} note={`to ${fmtDate(aw.as_of)}`} />
              <Stat label="Waiting 30+ days" value={fmt(aw.over_30)} note="past normal turnaround" tone={aw.over_30 ? 'warn' : undefined} />
              <Stat label="Waiting 60+ days" value={fmt(aw.over_60)} note="likely lost, not delayed" tone={aw.over_60 ? 'bad' : undefined} />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card className="min-w-0">
                <CardHeader><CardTitle>Facilities with the most samples outstanding</CardTitle></CardHeader>
                <CardContent className="px-0">
                  <Table className="text-xs">
                    <TableHeader className="bg-muted/50">
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Facility</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">Median</TableHead>
                        <TableHead className="text-right">Longest</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {aw.by_facility.map((f, i) => (
                        <TableRow key={`${f.facility}${i}`}>
                          <TableCell>{f.facility ?? DASH}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(f.n)}</TableCell>
                          <TableCell className="text-right tabular-nums">{f.median_days} d</TableCell>
                          <TableCell className={cn('text-right tabular-nums', f.longest >= 60 && 'font-medium text-bad')}>{f.longest} d</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card className="min-w-0">
                <CardHeader><CardTitle>Longest outstanding</CardTitle></CardHeader>
                <CardContent className="px-0">
                  <Table className="text-xs">
                    <TableHeader className="bg-muted/50">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-right">Waiting</TableHead>
                        <TableHead>Sampled</TableHead>
                        <TableHead>Facility</TableHead>
                        <TableHead className="text-right">Index VL</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {aw.rows.slice(0, 15).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className={cn('text-right tabular-nums', r.days >= 60 && 'font-medium text-bad')}>{r.days} d</TableCell>
                          <TableCell className="tabular-nums">{fmtDate(r.sample_date)}</TableCell>
                          <TableCell>{r.facility ?? DASH}</TableCell>
                          <TableCell className="text-right tabular-nums">{vlShort(r.idx_vl)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground">
              Longest first; {fmt(Math.min(15, aw.rows.length))} of {fmt(aw.n)} shown here.
              {aw.future_dated ? ` ${fmt(aw.future_dated)} sample(s) are dated after the line list and are left out of the wait times - a data-entry error, not a delay.` : ''}
            </p>
          </>
        ) : (
          <Card><CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">No post-EAC samples outstanding in this selection.</p>
          </CardContent></Card>
        )}
      </Section>

      <Section eyebrow="Client review" title="Viral load trajectory - clients to review"
               description="Every episode still at or above 1,000, whether or not EAC was completed. Each block is one result, oldest first: green below 1,000, red at or above. Where the index and follow-up carry the same value they count as one result, because with no repeat test the follow-up simply restates the index.">
        <Card className="min-w-0">
          <CardContent className="flex flex-col gap-3">
            {traj?.ok && traj.rows.length ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {fmt(traj.n)} episodes still unsuppressed; the {fmt(traj.shown ?? traj.rows.length)} with the
                  highest current viral load are listed. {fmt(oneResult)} have only one result on record, so
                  their trajectory cannot be read yet.
                </p>
                <DataTable key={query} columns={columns} data={traj.rows} searchColumn="facility"
                           searchPlaceholder="Search facilities" caption="Viral load trajectories"
                           columnLabels={{ facility: 'Facility', eac_stage: 'EAC', trajectory: 'Trajectory', latest_vl: 'Latest VL', pattern: 'Pattern' }}
                           emptyText="No facility matches that search." />
              </>
            ) : <p className="py-6 text-center text-sm text-muted-foreground">No clients match this selection.</p>}
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="Repeat unsuppression" title="Who unsuppresses more than once"
               description="Univariate odds ratios for an episode belonging to a client with more than one unsuppression episode. A descriptive signal, not an adjusted model, and it covers every repeat episode, not only those still at or above 1,000.">
        <Card className="min-w-0">
          <CardContent className="flex flex-col gap-3 px-0">
            <p className="mx-6 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              {pc(d.repeat_assoc.pct)} of episodes ({fmt(d.repeat_assoc.n)}) belong to one of the{' '}
              {fmt(s.repeat_clients)} clients who have unsuppressed more than once.
            </p>
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Variable and level</TableHead>
                    <TableHead className="text-right">n</TableHead>
                    <TableHead className="text-right">% repeat</TableHead>
                    <TableHead className="text-right">Odds ratio (95% CI)</TableHead>
                    <TableHead className="text-right">p</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.repeat_assoc.variables.map((v) => (
                    <Fragment key={v.label}>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={5} className="font-medium text-muted-foreground">{v.label}</TableCell>
                      </TableRow>
                      {v.levels.map((l) => (
                        <TableRow key={`${v.label}${l.level}`}>
                          <TableCell className="pl-5">{l.level}{l.ref && <span className="ml-1.5 text-muted-foreground">(reference)</span>}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.n)}</TableCell>
                          <TableCell className="text-right tabular-nums">{pc(l.pct)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {l.ref ? '1.00' : l.or_ == null ? DASH
                              : `${l.or_.toFixed(2)} (${l.or_lo?.toFixed(2)} to ${l.or_hi?.toFixed(2)})`}
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums', l.or_p != null && l.or_p < 0.05 && 'font-medium')}>
                            {l.or_p == null ? '' : l.or_p < 0.001 ? '<0.001' : l.or_p.toFixed(3)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="Act" title="Intervention worklists"
               description="The episodes a DTC needs to see. Each opens its worklist under the current filters.">
        <Card className="min-w-0">
          <CardContent className="px-0">
            <Table className="text-xs">
              <TableBody>
                {([['awaiting_switch', 'Awaiting DTC review: 1st line at index, still 1st, still at or above 1,000', s.awaiting],
                   ['prior_switch', 'Prior switch: 2nd/3rd line at index, needs a drug-history and VL review', s.prior],
                   ['dtc_review', 'More than 2 EAC cycles, still failing', s.dtc_flag]] as const).map(([flag, label, n]) => (
                  <TableRow key={flag}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{fmt(n)}</TableCell>
                    <TableCell className="w-28 text-right">
                      {onOpenWorklist && (
                        <Button variant="outline" size="xs" onClick={() => onOpenWorklist(flag)}>
                          Open <ArrowRight />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Section>
    </div>
  )
}
