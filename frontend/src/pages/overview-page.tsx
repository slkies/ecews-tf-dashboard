import type { ChartConfiguration, ScriptableLineSegmentContext } from 'chart.js'
import {
  Activity, Baby, CalendarClock, CircleAlert, CircleCheck, Download, FunnelX, Gavel,
  HeartHandshake, Microscope, Pill, TestTube, Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from 'cn'
import Chart from '@/components/Chart'
import FilterBar from '@/components/filter-bar'
import { KpiTile } from '@/components/kpi-tile'
import { StatusBadge, type Tone } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle,
} from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { getToken } from '@/core/api'
import { useFilters } from '@/core/filters'
import { DASH, fmt, fmtDate, fmtMonYY, pc, periodLabel } from '@/core/format'
import type { Dist, FacilityRow, Overview as Ov, TimeMetrics } from '@/core/overview'
import { cssVar, useChartPalette } from '@/core/palette'
import { useSession } from '@/core/session'
import type { Trend } from '@/core/use-trend'

const SRC_KIND: Record<string, string> = {
  total: 'Total Unsuppressed register',
  treatment: 'Treatment line list',
  eac: 'EAC line list',
}

/** "On track" or a named shortfall, from the same thresholds the original used. */
function rateTone(v: number | null | undefined, floor: number, severity: Tone): [Tone, string] | null {
  if (v == null) return null
  return v < floor ? [severity, `Below ${floor}%`] : ['good', 'On track']
}

export default function OverviewPage({ data, times, trend, loading }: {
  data: Ov | null
  times: TimeMetrics | null
  trend: Trend | null
  loading: boolean
}) {
  const { active, reset, query } = useFilters()
  const { me } = useSession()
  const canExport = me?.role === 'admin' || me?.role === 'analyst'

  if (loading && !data) return <OverviewSkeleton />

  const hasData = !!data && data.n > 0
  const since = trend ? fmtDate(trend.prevAsOf) : undefined
  const asofLong = data?.as_of
    ? new Date(data.as_of).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : DASH

  return (
    <div className="flex flex-col gap-6">
      {/* ── heading ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-balance">Programme overview</h1>
          <p className="text-sm text-muted-foreground">
            Line list as of {asofLong}
            {hasData && <> · {fmt(data!.n)} treatment-failure episodes · {periodLabel(data)}</>}
            {since && <> · trends compare with the list of {since}</>}
          </p>
        </div>
        {canExport && hasData && <ExportButton query={query} />}
      </div>

      <FilterBar />

      {!hasData ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FunnelX /></EmptyMedia>
            <EmptyTitle>No episodes match these filters</EmptyTitle>
            <EmptyDescription>
              Every indicator on this page is calculated from the episodes the filters
              select, and this combination selects none.
            </EmptyDescription>
          </EmptyHeader>
          {active > 0 && (
            <EmptyContent>
              <Button variant="outline" onClick={reset}>Reset filters</Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        // While a new selection loads, the previous figures stay on screen,
        // dimmed. Flashing skeletons on every filter change makes the page jump.
        <div className={cn('flex flex-col gap-6 transition-opacity',
                           loading && 'pointer-events-none opacity-60')}
             aria-busy={loading}>
          <Headline data={data!} trend={trend} since={since} />
          <TimeStrip t={times} />
          <NarrativeRow data={data!} />
          <ChartsRow data={data!} />
          <ResuppressionAndCascade data={data!} />
          <FacilityRow data={data!} />
          <ZeroEac data={data!} />
          <Sources data={data!} asofLong={asofLong} />
        </div>
      )}
    </div>
  )
}

/* ───────────────────────────────── headline tiles ─────────────────────────── */

function Headline({ data, trend, since }: { data: Ov; trend: Trend | null; since?: string }) {
  const q = data.progress ?? []
  const series = (k: 'n' | 'eac1_pct' | 'completed_pct' | 'retest_pct' | 'resupp_pct') =>
    q.map((p) => p[k] as number | null)
  const span = (k: 'eac1_pct' | 'completed_pct' | 'retest_pct' | 'resupp_pct', label: string) => {
    const first = q[0], last = q[q.length - 1]
    if (!first || !last) return undefined
    return `${label} by enrolment quarter, from ${pc(first[k])} in ${first.quarter} to ${pc(last[k])} in ${last.quarter}; the latest quarter is provisional`
  }
  const postEacPct = data.completed ? (data.post_eac_vl / data.completed) * 100 : null
  const badge = (t: [Tone, string] | null) => t && <StatusBadge tone={t[0]}>{t[1]}</StatusBadge>
  const tv = trend?.values

  return (
    <section aria-label="Headline indicators" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile icon={Users} label="Index cohort" value={fmt(data.n)}
               sparkline={series('n')} sparkLabel="Episodes by enrolment quarter; the latest quarter is still filling"
               trend={tv?.cohort} better="neutral" since={since}
               note={`${fmt(data.clients)} clients · ${fmt(data.repeats)} repeat episodes`}
               definition="Every treatment-failure episode in the Total Unsuppressed register. The unit is the episode - S/N, index VL date and value - so a client unsuppressed twice counts twice." />
      <KpiTile icon={HeartHandshake} label="Commenced EAC" value={pc(data.eac1_pct)}
               sparkline={series('eac1_pct')} sparkLabel={span('eac1_pct', 'Commenced EAC')}
               trend={tv?.eac1} since={since}
               note={`${fmt(data.eac1)} of ${fmt(data.n)} · ${fmt(data.never_eac)} never started`}
               status={badge(rateTone(data.eac1_pct, 70, 'bad'))}
               definition="Episodes with EAC session 1 recorded, over all episodes in the index cohort." />
      <KpiTile icon={CircleCheck} label="Completed EAC" value={pc(data.completed_pct)}
               sparkline={series('completed_pct')} sparkLabel={span('completed_pct', 'Completed EAC')}
               trend={tv?.completed} since={since}
               note={`${fmt(data.completed)} of ${fmt(data.eac1)} commenced`}
               status={badge(rateTone(data.completed_pct, 50, 'warn'))}
               definition="Sessions 1-3 recorded and at least 30 days since session 3, over episodes that commenced EAC." />
      <KpiTile icon={TestTube} label="Post-EAC VL sample" value={pc(postEacPct)}
               trend={tv?.postEac} since={since}
               note={`${fmt(data.post_eac_vl)} of ${fmt(data.completed)} who completed EAC`}
               status={badge(rateTone(postEacPct, 60, 'bad'))}
               definition="Sessions 1-3 plus a viral load sample on or after session 3, over episodes that completed EAC. A different indicator from the follow-up VL." />
      <KpiTile icon={Microscope} label="Follow-up VL done" value={pc(data.retest_pct)}
               sparkline={series('retest_pct')} sparkLabel={span('retest_pct', 'Follow-up VL done')}
               trend={tv?.retest} since={since}
               note={`${fmt(data.awaiting_retest)} episodes with no later VL`}
               status={badge(rateTone(data.retest_pct, 50, 'bad'))}
               definition="Episodes with any viral load sampled after the index result was received, over all episodes. Taken from the clinical line lists, never the EAC sheet." />
      <KpiTile icon={Activity} label="Re-suppressed" value={pc(data.resupp_pct)}
               sparkline={series('resupp_pct')} sparkLabel={span('resupp_pct', 'Re-suppressed')}
               trend={tv?.resupp} since={since}
               note={`${fmt(data.resuppressed)} of ${fmt(data.retested)} with a follow-up VL`}
               status={badge(rateTone(data.resupp_pct, 70, 'warn'))}
               definition="A follow-up viral load below 1,000 copies/mL, over episodes that have a follow-up VL." />
      <KpiTile icon={Gavel} label="Awaiting DTC review" value={fmt(data.awaiting_switch)}
               className="sm:col-span-2"
               note={`of ${fmt(data.still_unsuppressed)} episodes still at or above 1,000 copies/mL`}
               status={data.awaiting_switch
                 ? <StatusBadge tone="bad">Action needed</StatusBadge>
                 : <StatusBadge tone="good">None waiting</StatusBadge>}
               definition="Episodes whose follow-up viral load is still at or above 1,000 copies/mL and are waiting for the switch committee's decision.">
        <dl className="grid grid-cols-3 gap-3 border-t pt-3">
          <MiniStat term="Still ≥ 1,000" value={fmt(data.still_unsuppressed)} />
          <MiniStat term="Prior switch" value={fmt(data.prior_switch)} />
          <MiniStat term="Switched" value={fmt(data.switched)}
                    sub={data.switch_pct != null ? `${pc(data.switch_pct)} of ${fmt(data.switch_eligible)} eligible` : undefined} />
        </dl>
      </KpiTile>
    </section>
  )
}

function MiniStat({ term, value, sub }: { term: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="truncate text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

/* ───────────────────────────────── time to event ──────────────────────────── */

function TimeStrip({ t }: { t: TimeMetrics | null }) {
  if (!t || !Object.keys(t).length) return null
  const med = (d?: Dist | null) => (d?.median != null ? fmt(d.median) : DASH)
  const iqr = (d?: Dist | null, unit = 'd') => (d ? `IQR ${d.q1}-${d.q3} ${unit}` : 'No episodes to measure')
  const cells: { label: string; value: string; unit: string; how: string; iqr: string; status?: [Tone, string] }[] = [
    { label: 'Median time to EAC', value: med(t.time_to_eac), unit: 'days',
      how: 'Index result to session 1', iqr: iqr(t.time_to_eac),
      status: t.time_to_eac?.median != null
        ? (t.time_to_eac.median > 30 ? ['warn', 'Over 30 days'] : ['good', 'Within 30 days']) : undefined },
    { label: 'EAC lead time', value: med(t.eac_lead_time), unit: 'days',
      how: 'Session 1 to follow-up sample', iqr: iqr(t.eac_lead_time),
      status: t.eac_lead_time?.median != null && t.eac_lead_time.median > 120 ? ['warn', 'Over 120 days'] : undefined },
    { label: 'Time to re-suppression', value: med(t.time_to_resuppression), unit: 'days',
      how: 'Session 1 to a suppressed VL', iqr: iqr(t.time_to_resuppression) },
    { label: 'Months unsuppressed', value: t.months_unsuppressed?.median != null ? String(t.months_unsuppressed.median) : DASH,
      unit: 'months', how: 'Index VL to the line-list date', iqr: iqr(t.months_unsuppressed, 'mo') },
  ]
  return (
    <section aria-labelledby="time-h" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="time-h" className="text-base font-semibold">Time to event</h2>
        <p className="text-sm text-muted-foreground">Medians across the filtered episodes, with the middle half of the distribution.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cells.map((c) => (
          <Card key={c.label} size="sm">
            <CardContent className="flex h-full flex-col gap-1.5">
              <span className="text-sm text-muted-foreground">{c.label}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold tracking-tight proportional-nums">{c.value}</span>
                <span className="text-sm text-muted-foreground">{c.unit}</span>
              </span>
              <span className="text-xs text-muted-foreground">{c.how} · <span className="tabular-nums">{c.iqr}</span></span>
              {c.status && <span className="mt-auto pt-1"><StatusBadge tone={c.status[0]}>{c.status[1]}</StatusBadge></span>}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

/* ─────────────────────────────── narrative + cohort ───────────────────────── */

function NarrativeRow({ data }: { data: Ov }) {
  const d = data.demo
  const period = periodLabel(data)
  const mo = d.median_months_art
  const yrs = mo ? (mo / 12).toFixed(1) : null
  const sx = data.disagg?.sex ?? {}
  const stateBits = Object.entries(data.disagg?.state ?? {}).map(([k, v]) => `${k} ${pc(v.pct)}`).join(', ')
  const rows: { Icon: typeof Users; label: string; value: string; count?: string }[] = [
    { Icon: Users, label: 'Female', value: pc(d.female_pct), count: fmt(d.female) },
    { Icon: Users, label: 'Adolescents 10-19', value: pc(d.adolescents_pct), count: fmt(d.adolescents) },
    { Icon: Baby, label: 'Children under 10', value: pc(d.paeds_pct), count: fmt(d.paeds) },
    { Icon: CalendarClock, label: 'Median time on ART', value: mo ? `${mo} mo` : DASH, count: yrs ? `${yrs} yr` : undefined },
    { Icon: Pill, label: 'First-line regimen', value: pc(d.first_line_pct), count: fmt(d.first_line) },
    { Icon: Pill, label: 'Second-line regimen', value: pc(d.second_line_pct), count: fmt(d.second_line) },
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardDescription className="text-xs font-medium tracking-[0.08em] uppercase">Programme narrative</CardDescription>
          <CardTitle className="text-lg font-semibold text-balance">Treatment-failure cohort, {period}</CardTitle>
        </CardHeader>
        {/* Plain prose: no inline emphasis. The numbers carry themselves. */}
        <CardContent className="flex max-w-[78ch] flex-col gap-3 text-[15px] leading-7 text-foreground/80 text-pretty">
          <p>
            In {period}, {fmt(data.n)} treatment-failure episodes were recorded across{' '}
            {fmt(data.clients)} clients ({fmt(data.repeat_clients)} unsuppressed more than once).
            The cohort is {pc(d.female_pct)} female ({fmt(d.female)}) and {pc(d.male_pct)} male
            ({fmt(d.male)}); {pc(d.adolescents_pct)} are adolescents (10-19, {fmt(d.adolescents)})
            and {pc(d.paeds_pct)} are children under 10 ({fmt(d.paeds)}). Median time on ART is{' '}
            {mo ? `${mo} months` : DASH}{yrs ? ` (${yrs} years)` : ''}, and {pc(d.first_line_pct)} are
            on a first-line regimen with {pc(d.second_line_pct)} ({fmt(d.second_line)}) already on second-line.
          </p>
          <p>
            {pc(data.eac1_pct)} ({fmt(data.eac1)}) have commenced EAC, and {pc(data.completed_pct)}{' '}
            ({fmt(data.completed)}) of those have completed it. Median time to EAC commencement is{' '}
            {d.median_time_to_eac != null ? `${d.median_time_to_eac} days` : DASH}, with an EAC lead
            time (commencement to follow-up sample) of about{' '}
            {d.median_lead_months != null ? `${d.median_lead_months} months` : DASH}.
          </p>
          <p>
            Among episodes with a follow-up viral load, the re-suppression rate is {pc(data.resupp_pct)}.{' '}
            {fmt(data.awaiting_switch)} episodes remain at or above 1,000 copies/mL and are awaiting DTC
            review; {fmt(data.switched)} have moved to second- or third-line. Re-suppression is{' '}
            {pc(sx['Female']?.pct)} in females versus {pc(sx['Male']?.pct)} in males
            {stateBits ? `, and by state runs ${stateBits}.` : '.'} The clearest gap is coverage, not
            efficacy: only {pc(data.retest_pct)} of episodes have any follow-up VL on record, leaving{' '}
            {fmt(data.awaiting_retest)} untested.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cohort at a glance</CardTitle>
          <CardDescription>Who is in the index cohort</CardDescription>
        </CardHeader>
        <CardContent>
          <ItemGroup>
            {rows.map((r) => (
              <Item key={r.label} size="xs" className="px-0">
                <ItemMedia className="flex size-8 items-center justify-center rounded-lg bg-brand-tint text-primary [&_svg]:size-4">
                  <r.Icon aria-hidden />
                </ItemMedia>
                <ItemContent><ItemTitle className="font-normal">{r.label}</ItemTitle></ItemContent>
                <ItemActions className="gap-2">
                  <span className="text-sm font-semibold tabular-nums">{r.value}</span>
                  {r.count && <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{r.count}</span>}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </Card>
    </div>
  )
}

/* ───────────────────────────────────── charts ─────────────────────────────── */

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  )
}

function ChartsRow({ data }: { data: Ov }) {
  const C = useChartPalette()
  const w = data.weekly

  const incidence = useMemo<ChartConfiguration | null>(() => {
    if (!w?.months?.length) return null
    const line = (label: string, values: number[], color: string) => ({
      label, data: values, borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, tension: 0.3,
    })
    return {
      type: 'line',
      data: { labels: w.months.map(fmtMonYY),
              datasets: [line('Female', w.female, C.female), line('Male', w.male, C.male)] },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { footer: (items) =>
            `Total ${(items[0]?.parsed.y ?? 0) + (items[1]?.parsed.y ?? 0)}` } },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, border: { display: false }, ticks: { precision: 0 } },
        },
      },
    }
  }, [w, C])

  const F = w.female.reduce((a, b) => a + b, 0)
  const M = w.male.reduce((a, b) => a + b, 0)
  const T = F + M || 1
  const peak = Math.max(0, ...w.female.map((v, i) => v + (w.male[i] ?? 0)))

  const d = data.demo
  const unknown = Math.max(0, data.n - d.female - d.male)
  const split = [
    { label: 'Female', n: d.female, color: C.female },
    { label: 'Male', n: d.male, color: C.male },
    ...(unknown ? [{ label: 'Unknown', n: unknown, color: C.unknown }] : []),
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>New unsuppressed results by month</CardTitle>
          <CardDescription>By sex, dated by result received at the facility, the same clock the fiscal quarters use.</CardDescription>
          <CardAction><Legend items={[{ label: 'Female', color: C.female }, { label: 'Male', color: C.male }]} /></CardAction>
        </CardHeader>
        <CardContent>
          {incidence
            ? <Chart config={incidence} height={264} ariaLabel="Line chart of new unsuppressed results by month, female and male" />
            : <p className="py-10 text-center text-sm text-muted-foreground">No dated results in this selection.</p>}
        </CardContent>
        {incidence && (
          <CardFooter className="flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span>Female <span className="font-medium text-foreground">{fmt(F)}</span> ({(F / T * 100).toFixed(1)}%)</span>
            <span>Male <span className="font-medium text-foreground">{fmt(M)}</span> ({(M / T * 100).toFixed(1)}%)</span>
            <span>Mean per month <span className="font-medium text-foreground">{fmt(T / (w.months.length || 1))}</span></span>
            <span>Peak <span className="font-medium text-foreground">{fmt(peak)}</span></span>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>EAC and outcome summary</CardTitle>
          <CardDescription>How the cohort splits by sex, and how far each state has moved into EAC.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Cohort by sex</span>
            <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img"
                 aria-label={split.map((s) => `${s.label} ${fmt(s.n)}`).join(', ')}>
              {split.map((s) => (
                <span key={s.label} style={{ width: `${(s.n / (data.n || 1)) * 100}%`, background: s.color }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {split.map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />
                  {s.label} <span className="font-medium text-foreground tabular-nums">{pc((s.n / (data.n || 1)) * 100)}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Commenced EAC by state</span>
            {data.by_state?.length ? data.by_state.map((s) => (
              <div key={s.state} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate">{s.state}</span>
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(s.eac1_pct ?? 0, 100)}%` }} />
                </span>
                <span className="w-24 text-right tabular-nums">
                  <span className="font-medium">{pc(s.eac1_pct)}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">{fmt(s.n)}</span>
                </span>
              </div>
            )) : <p className="text-sm text-muted-foreground">No state breakdown for this selection.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ResuppressionAndCascade({ data }: { data: Ov }) {
  const C = useChartPalette()
  const t = data.resupp_trend

  const config = useMemo<ChartConfiguration | null>(() => {
    if (!t?.months?.length) return null
    const lastIdx = t.months.length - 1
    const grey = cssVar('--muted-foreground', C.provisional)
    // The latest month is dashed and grey: its follow-ups are freshly sampled
    // and mostly not yet re-suppressed, so the rate is provisional.
    const line = (label: string, values: (number | null)[], color: string) => ({
      label, data: values, borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: true,
      segment: {
        borderColor: (c: ScriptableLineSegmentContext) => (c.p1DataIndex === lastIdx ? grey : color),
        borderDash: (c: ScriptableLineSegmentContext) => (c.p1DataIndex === lastIdx ? [5, 4] : undefined),
      },
    })
    return {
      type: 'line',
      data: { labels: t.months.map(fmtMonYY),
              datasets: [line('Female', t.female, C.female), line('Male', t.male, C.male)] },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: (i) => `${i.dataset.label}: ${i.parsed.y == null ? DASH : `${i.parsed.y.toFixed(1)}%`}`
              + (i.dataIndex === lastIdx ? ' (provisional)' : ''),
            // The denominator travels with the rate: 100% on two results is not a good month.
            afterLabel: (i) => `n = ${fmt((i.dataset.label === 'Female' ? t.female_n : t.male_n)[i.dataIndex])}`,
          } },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          y: { min: 0, max: 100, border: { display: false }, ticks: { callback: (v) => `${v}%` } },
        },
      },
    }
  }, [t, C])

  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle>Monthly re-suppression</CardTitle>
          <CardDescription>
            Share of follow-up VLs below 1,000, dated on the follow-up sample. The latest month is
            provisional; months with fewer than three results are left blank.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Legend items={[{ label: 'Female', color: C.female }, { label: 'Male', color: C.male }]} />
          {config
            ? <Chart config={config} height={240} ariaLabel="Line chart of monthly re-suppression rate, female and male" />
            : <p className="py-10 text-center text-sm text-muted-foreground">No follow-up results in this selection.</p>}
        </CardContent>
      </Card>

      <Card className="xl:col-span-3">
        <CardHeader>
          <CardTitle>EAC cascade by enrolment quarter</CardTitle>
          <CardDescription>
            Counts with each step's rate. Recent quarters are still moving through EAC, so their later steps read low.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quarter</TableHead>
                <TableHead className="text-right">Episodes</TableHead>
                <TableHead className="text-right">EAC commenced</TableHead>
                <TableHead className="text-right">EAC completed</TableHead>
                <TableHead className="text-right">Follow-up VL</TableHead>
                <TableHead className="text-right">Re-suppressed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.progress?.map((p) => (
                <TableRow key={p.quarter}>
                  <TableCell className="font-medium">{p.quarter}</TableCell>
                  <TableCell className="text-right">{fmt(p.n)}</TableCell>
                  <PairCell n={p.eac1} rate={p.eac1_pct} />
                  <PairCell n={p.completed} rate={p.completed_pct} />
                  <PairCell n={p.retested} rate={p.retest_pct} />
                  <PairCell n={p.resuppressed} rate={p.resupp_pct} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function PairCell({ n, rate }: { n: number; rate: number | null }) {
  return (
    <TableCell className="text-right">
      {fmt(n)} <span className="ml-1 text-xs text-muted-foreground">{pc(rate)}</span>
    </TableCell>
  )
}

/* ─────────────────────────────────── facilities ───────────────────────────── */

function FacilityTable({ rows }: { rows: FacilityRow[] | undefined }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Facility</TableHead>
          <TableHead className="text-right">Episodes</TableHead>
          <TableHead className="text-right">EAC commenced</TableHead>
          <TableHead className="text-right">EAC completed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows?.map((r, i) => (
          <TableRow key={`${r.facility ?? DASH}-${i}`}>
            <TableCell className="max-w-[16rem] truncate" title={r.facility ?? undefined}>{r.facility ?? DASH}</TableCell>
            <TableCell className="text-right">{fmt(r.n)}</TableCell>
            <PairCell n={r.eac1} rate={r.eac1_pct} />
            <PairCell n={r.completed} rate={r.completed_pct} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function FacilityRow({ data }: { data: Ov }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Top 10 facilities by volume</CardTitle>
          <CardDescription>Where the burden sits.</CardDescription>
        </CardHeader>
        <CardContent><FacilityTable rows={data.by_volume} /></CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Top 10 by EAC completion</CardTitle>
          <CardDescription>
            Ranked among facilities with at least {data.min_vol} episodes; completion rates on a
            handful of clients are noise, not signal.
          </CardDescription>
        </CardHeader>
        <CardContent><FacilityTable rows={data.best} /></CardContent>
      </Card>
    </div>
  )
}

function ZeroEac({ data }: { data: Ov }) {
  if (!data.zero_eac?.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Facilities with volume but no EAC on record</CardTitle>
        <CardDescription>
          These sites carry real caseload and show no EAC session. The export cannot tell whether
          counselling did not happen or was not recorded; both need a call.
        </CardDescription>
        <CardAction><StatusBadge tone="bad">{data.zero_eac.length} {data.zero_eac.length === 1 ? 'site' : 'sites'}</StatusBadge></CardAction>
      </CardHeader>
      <CardContent>
        <ItemGroup className="grid gap-2 md:grid-cols-2">
          {data.zero_eac.map((r) => (
            <Item key={r.facility ?? DASH} variant="outline" size="sm">
              <ItemMedia className="flex size-8 items-center justify-center rounded-lg bg-bad-tint text-bad [&_svg]:size-4">
                <CircleAlert aria-hidden />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{r.facility ?? DASH}</ItemTitle>
                <ItemDescription>{fmt(r.n)} episodes · no EAC session recorded</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────────────── sources ──────────────────────────────── */

function Sources({ data, asofLong }: { data: Ov; asofLong: string }) {
  const rules = [
    ['The unit of analysis', `the failure episode (S/N, index VL date and value), never the client; ${fmt(data.repeat_clients)} clients were unsuppressed more than once.`],
    ['The cohort', 'a quarterly open cohort drawn from the Total Unsuppressed register.'],
    ['Viral loads', 'index and follow-up both come from the clinical line lists, never the EAC sheet.'],
    ['The follow-up VL', 'the next VL sampled after the index result was received.'],
    ['EAC completed', 'sessions 1-3 recorded plus at least 30 days since session 3. Post-EAC VL is sessions 1-3 plus a sample on or after session 3.'],
  ]
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Methodology and data sources</CardTitle>
        <CardDescription>How the numbers on this page are built, and the line lists they rest on.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-8 lg:grid-cols-2">
        <dl className="flex flex-col gap-3 text-sm">
          {rules.map(([term, text]) => (
            <div key={term} className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="text-foreground/85">{text}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-3">
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
            Line list as of {asofLong}. This date sets the fiscal quarter and the follow-up window.
          </p>
          {data.sources?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sheet</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sources.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell className="max-w-[14rem] truncate" title={s.name}>{s.name}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        {SRC_KIND[s.kind] ?? s.kind}
                        {s.censored && <StatusBadge tone="warn">Censored</StatusBadge>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{fmt(s.rows)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <p className="text-sm text-muted-foreground">The sheet list is unavailable for this upload.</p>}
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────────── export + loading ─────────────────────────── */

/**
 * Downloads the active-client worklist for the current filters. The server
 * restricts this to analysts and administrators and logs every export; the
 * button is only shown to those roles so the rule is visible, not a surprise.
 */
function ExportButton({ query }: { query: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/export${query}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: string }
        throw new Error(body.detail ?? `Export failed (${res.status})`)
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
        ?? 'ecews_tf_active.csv'
      const url = URL.createObjectURL(await res.blob())
      const a = Object.assign(document.createElement('a'), { href: url, download: name })
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={run} disabled={busy}>
        {busy ? <Spinner /> : <Download />}
        {busy ? 'Exporting' : 'Export active clients'}
      </Button>
      {err && (
        <Alert variant="destructive" className="max-w-sm"><AlertDescription>{err}</AlertDescription></Alert>
      )}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading the overview">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className={cn('h-40 rounded-xl', i === 6 && 'sm:col-span-2')} />
        ))}
      </div>
    </div>
  )
}
