import type { ChartConfiguration } from 'chart.js'
import { ArrowRight, Microscope } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from 'cn'
import Chart from '@/components/Chart'
import FilterBar, { PinFiltersToggle } from '@/components/filter-bar'
import LgaMap, { type LgaCounts } from '@/components/lga-map'
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
import { DASH, fmt, fmtMonYY, pc } from '@/core/format'
import { cssVar, useChartPalette } from '@/core/palette'
import { WORKLISTS } from './worklists-page'

/* ─────────────────────────────────── types ─────────────────────────────────── */

export interface Dist { level: string; n: number; pct: number }
interface Quart { n: number; median: number; q1: number; q3: number }

export interface Profile {
  n: number
  clients: number
  who: {
    median_age: number | null; female_pct: number; adolescent_pct: number; paed_pct: number
    sex: Dist[]; age_group: Dist[]; age_band: Dist[]; marital: Dist[]
    education: Dist[]; job: Dist[]; pregnancy: Dist[]
  }
  what: {
    median_years_art: number | null
    regimen: Dist[]; vl_magnitude: Dist[]; cd4: Dist[]; years_art: Dist[]
    eac_status: Dist[]; who_stage: Dist[]; bmi: Dist[]; plan: Dist[]
  }
  when: {
    monthly: { months: string[]; n: number[]; exits: number[] }
    wait: (Quart & { pending: number }) | null
    quarter: Dist[]; time_to_first_vl: Dist[]; yrs_to_unsupp: Dist[]
    time_to_eac: Dist[]; months_unsupp: Dist[]
    ttfv_months: Quart | null; ttfu_years: Quart | null; mu_stats: Quart | null
  }
  care: {
    neg_total: number; neg_pct: number; neg_no_followup: number
    neg_no_post_eac: number; neg_dated: number
    status: Dist[]; exit_when: Dist[]
    breakdown: { level: string; n: number; no_followup_vl: number }[]
  } | null
  where: { state: Dist[]; lga: Dist[]; facility: Dist[]; lga_res: LgaCounts | null }
}

export interface FacilityRow {
  group: string; n: number; eac1_pct: number | null; post_result: number
  resupp_pct: number | null; still_unsuppressed: number; switched: number
}

/* ─────────────────────────────────── pieces ────────────────────────────────── */

function Stat({ label, value, note, tone }: {
  label: string; value: string; note: string; tone?: 'warn'
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn('text-2xl font-semibold', tone === 'warn' && 'text-warn')}>{value}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </CardContent>
    </Card>
  )
}

/**
 * A distribution as labelled rows: level, a bar of its share, the count and the
 * percentage. Rows rather than a donut - the levels are ordered and often close
 * together, which a donut reads badly, and every value is on the page.
 */
function DistCard({ title, dist, highlight, note }: {
  title: string
  dist: Dist[] | undefined
  /** Levels that carry meaning of their own, e.g. a priority age group. */
  highlight?: Record<string, 'bad' | 'warn'>
  note?: string
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {note && <CardDescription className="text-xs">{note}</CardDescription>}
      </CardHeader>
      <CardContent>
        {dist?.length ? (
          <ul className="flex flex-col gap-2">
            {dist.map((r) => {
              const tone = highlight?.[r.level]
              const quiet = r.level === 'Not recorded' || r.level === 'Unknown'
              return (
                <li key={r.level} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3">
                  <span className={cn('truncate text-xs', quiet ? 'text-muted-foreground' : 'text-foreground')}
                        title={r.level}>
                    {r.level}
                  </span>
                  <span className="h-2 w-full rounded-[3px] bg-muted" aria-hidden>
                    <span className="block h-full rounded-[3px]"
                          style={{ width: `${Math.min(r.pct, 100)}%`,
                                   background: tone ? `var(--${tone})`
                                     : quiet ? 'var(--muted-foreground)' : 'var(--primary)',
                                   opacity: quiet ? 0.5 : 1 }} />
                  </span>
                  <span className="text-right text-xs tabular-nums">
                    {fmt(r.n)}<span className="ml-1.5 text-muted-foreground">{r.pct}%</span>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : <p className="py-4 text-center text-xs text-muted-foreground">Not available.</p>}
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

const GRID = 'grid gap-4 md:grid-cols-2 xl:grid-cols-3'

/* ──────────────────────────────────── page ─────────────────────────────────── */

export default function DeepDivePage({ onOpenWorklist }: { onOpenWorklist?: (flag: string) => void }) {
  const { query, options } = useFilters()
  const C = useChartPalette()
  const [p, setP] = useState<Profile | null>(null)
  const [fac, setFac] = useState<FacilityRow[] | null>(null)
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!options) return
    let off = false
    setLoading(true)
    Promise.all([
      api<Profile>(`/profile${query}`),
      api<FacilityRow[]>(`/breakdown/facility${query}`),
      api<{ flag: string; n: number | null }[]>(`/worklists${query}`),
    ])
      .then(([prof, facilities, wl]) => {
        if (off) return
        setP(prof); setFac(facilities)
        setCounts(Object.fromEntries(wl.map((w) => [w.flag, w.n])))
        setErr(null)
      })
      .catch((e: unknown) => { if (!off) setErr(e instanceof Error ? e.message : 'Could not load the profile') })
      .finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [query, options])

  const monthly = useMemo<ChartConfiguration | null>(() => {
    // An empty selection comes back as {"n": 0} with no sections at all.
    const m = p?.when?.monthly
    if (!m?.months?.length) return null
    const last = m.months.length - 1
    const grey = cssVar('--muted-foreground', C.provisional)
    return {
      type: 'line',
      data: {
        labels: m.months.map(fmtMonYY),
        datasets: [
          {
            label: 'Entered the cohort', data: m.n, borderColor: C.primary,
            backgroundColor: 'transparent', borderWidth: 2, fill: false,
            // The line list is drawn mid-month, so the last month is partial.
            segment: {
              borderColor: (c) => (c.p1DataIndex === last ? grey : C.primary),
              borderDash: (c) => (c.p1DataIndex === last ? [5, 4] : undefined),
            },
          },
          {
            label: 'Left (follow-up result back)', data: m.exits, borderColor: C.female,
            backgroundColor: 'transparent', borderWidth: 2, fill: false,
            segment: {
              borderColor: (c) => (c.p1DataIndex === last ? grey : C.female),
              borderDash: (c) => (c.p1DataIndex === last ? [5, 4] : undefined),
            },
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (i) => `${i.dataset.label}: ${fmt(i.parsed.y)} episodes`
            + (i.dataIndex === last ? ' (partial month)' : '') } },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, border: { display: false }, title: { display: true, text: 'Episodes per month' } },
        },
      },
    }
  }, [p, C])

  if (err) {
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <FilterBar />
        <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>
      </div>
    )
  }
  if (!p) {
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <FilterBar />
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-[26rem] w-full rounded-xl" />
      </div>
    )
  }
  if (!p.n) {
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <FilterBar />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Microscope /></EmptyMedia>
            <EmptyTitle>No episodes in this selection</EmptyTitle>
            <EmptyDescription>Widen the filters to profile the cohort.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const { who, what, when, care, where } = p
  const under20 = (who.paed_pct ?? 0) + (who.adolescent_pct ?? 0)

  return (
    <div className={cn('flex flex-col gap-8 transition-opacity', loading && 'opacity-60')}
         aria-busy={loading}>
      <Heading />
      <FilterBar />

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Episodes" value={fmt(p.n)} note={`${fmt(p.clients)} distinct clients`} />
        <Stat label="Median age" value={who.median_age == null ? DASH : `${fmt(who.median_age)} yr`}
              note="of the unsuppressed" />
        <Stat label="Female" value={`${who.female_pct}%`}
              note={`${fmt(who.sex.find((s) => s.level === 'Female')?.n)} episodes`} />
        <Stat label="Adolescents 10-19" value={`${who.adolescent_pct}%`}
              note={`${who.paed_pct}% are under 10`} tone={who.adolescent_pct > 10 ? 'warn' : undefined} />
        <Stat label="Median on ART" value={what.median_years_art == null ? DASH : `${what.median_years_art} yr`}
              note="at the index VL" />
        <Stat label="Median months unsuppressed" value={when.mu_stats ? String(when.mu_stats.median) : DASH}
              note="since the index VL" tone="warn" />
      </div>

      <Section eyebrow="Who" title="The people behind the unsuppressed results"
               description="Composition of the cohort. Where a field is blank in the export it is shown as Not recorded rather than quietly dropped: the gap is itself a finding.">
        <div className={GRID}>
          <DistCard title="Sex" dist={who.sex} />
          <DistCard title="Age group" dist={who.age_group} note={`${under20.toFixed(1)}% are under 20`}
                    highlight={{ 'Under 10': 'bad', '10-19': 'warn' }} />
          <DistCard title="Age band" dist={who.age_band} />
          <DistCard title="Marital status" dist={who.marital} />
          <DistCard title="Education" dist={who.education} />
          <DistCard title="Employment" dist={who.job} />
          <DistCard title="Pregnancy" dist={who.pregnancy} note="women only" />
        </div>
      </Section>

      <Section eyebrow="What" title="Their treatment and clinical picture"
               description="What they are on, how long for, how high the index viral load was, and how far through EAC they have moved.">
        <div className={GRID}>
          <DistCard title="Regimen line" dist={what.regimen} />
          <DistCard title="EAC status" dist={what.eac_status}
                    highlight={{ 'Never commenced': 'bad' }} />
          <DistCard title="Index VL magnitude" dist={what.vl_magnitude} />
          <DistCard title="Years on ART" dist={what.years_art} />
          <DistCard title="WHO stage" dist={what.who_stage} />
          <DistCard title="BMI" dist={what.bmi} />
          <DistCard title="Baseline CD4" dist={what.cd4}
                    note="measured at ART start, so it predates the index VL" />
          <DistCard title="Treatment plan" dist={what.plan} />
        </div>
      </Section>

      {care && (
        <Section eyebrow="Care outcome" title="Left care before a repeat VL"
                 description={`${fmt(care.neg_total)} episodes (${care.neg_pct}%) carry a negative ART status - LTFU, died, stopped, transferred out or discontinued. Of those, ${fmt(care.neg_no_followup)} have no follow-up VL at all and ${fmt(care.neg_no_post_eac)} have no post-EAC VL, so they can never re-suppress in this cohort. ${fmt(care.neg_dated)} of the exits are dated, which is what lets them be placed against the cascade.`}>
          <div className={GRID}>
            <DistCard title="When the exit happened" dist={care.exit_when} />
            <DistCard title="ART status, all episodes" dist={care.status} />
            <Card size="sm" className="min-w-0">
              <CardHeader><CardTitle className="text-sm">Never retested, by exit reason</CardTitle></CardHeader>
              <CardContent>
                {care.breakdown?.length ? (
                  <ul className="flex flex-col gap-2">
                    {care.breakdown.map((r) => (
                      <li key={r.level} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3">
                        <span className="truncate text-xs" title={r.level}>{r.level}</span>
                        <span className="h-2 w-full rounded-[3px] bg-muted" aria-hidden>
                          <span className="block h-full rounded-[3px] bg-bad"
                                style={{ width: `${Math.min(r.no_followup_vl / (care.neg_no_followup || 1) * 100, 100)}%` }} />
                        </span>
                        <span className="text-right text-xs tabular-nums">
                          {fmt(r.no_followup_vl)}<span className="ml-1.5 text-muted-foreground">of {fmt(r.n)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="py-4 text-center text-xs text-muted-foreground">No negative outcomes recorded.</p>}
              </CardContent>
            </Card>
          </div>
          {onOpenWorklist && (
            <Button variant="link" size="sm" className="self-start px-0"
                    onClick={() => onOpenWorklist('exited_no_vl')}>
              Open worklist: left care with no follow-up VL ({fmt(care.neg_no_followup)})
              <ArrowRight />
            </Button>
          )}
        </Section>
      )}

      <Section eyebrow="When" title="Timing - when they entered and how long they wait"
               description="Dated by result received at the facility. The final month is partial, because the line list was drawn mid-month, so it is dashed rather than read as a fall.">
        <Card>
          <CardHeader>
            <CardTitle>Episodes entering and leaving the cohort</CardTitle>
            <CardDescription>
              An episode enters on an unsuppressed result and leaves when the repeat result comes back.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px]" style={{ background: C.primary }} />Entered
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px]" style={{ background: C.female }} />Left
              </span>
            </div>
            {monthly
              ? <Chart config={monthly} height={260} ariaLabel="Monthly episodes entering and leaving the cohort" />
              : <p className="py-10 text-center text-sm text-muted-foreground">No dated results in this selection.</p>}
          </CardContent>
        </Card>
        <div className={GRID}>
          <DistCard title="Enrolment quarter" dist={when.quarter} />
          <DistCard title="Months unsuppressed" dist={when.months_unsupp} />
          <DistCard title="Time to EAC" dist={when.time_to_eac} />
          <DistCard title="ART start to first VL" dist={when.time_to_first_vl}
                    note={when.ttfv_months ? `median ${when.ttfv_months.median} months` : undefined} />
          <DistCard title="ART start to first unsuppressed VL" dist={when.yrs_to_unsupp}
                    note={when.ttfu_years ? `median ${when.ttfu_years.median} years` : undefined} />
          {when.wait && (
            <Card size="sm">
              <CardHeader><CardTitle className="text-sm">Wait for the repeat result</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                <span className="text-2xl font-semibold">{when.wait.median} days</span>
                <span className="text-xs text-muted-foreground">
                  middle half {when.wait.q1} to {when.wait.q3} days, over {fmt(when.wait.n)} episodes
                  whose result is back; {fmt(when.wait.pending)} are still waiting
                </span>
              </CardContent>
            </Card>
          )}
        </div>
      </Section>

      <Section eyebrow="Where" title="Geography - where the burden sits"
               description="The map shades each LGA by where unsuppressed clients live. The cards beside it use the service LGA and facility, so comparing the two shows who travels for care.">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>LGA of residence</CardTitle>
              <CardDescription>Darker means more unsuppressed clients living there.</CardDescription>
            </CardHeader>
            <CardContent><LgaMap res={where.lga_res} /></CardContent>
          </Card>
          <div className="flex min-w-0 flex-col gap-4">
            <DistCard title="State (service)" dist={where.state} />
            <DistCard title="Top 10 LGAs (service)" dist={where.lga} />
            <DistCard title="Top 10 facilities" dist={where.facility} />
          </div>
        </div>
      </Section>

      <Section eyebrow="Facilities" title="Facility league table"
               description="Facilities with 20 or more episodes, weakest EAC commencement first.">
        <Card className="min-w-0">
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Facility</TableHead>
                    <TableHead className="text-right">Episodes</TableHead>
                    <TableHead className="w-44 text-right">EAC commenced</TableHead>
                    <TableHead className="text-right">Follow-up VL results</TableHead>
                    <TableHead className="text-right">Re-suppressed</TableHead>
                    <TableHead className="text-right">Awaiting DTC review</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(fac ?? []).filter((f) => f.n >= 20)
                    .sort((a, b) => (a.eac1_pct ?? 0) - (b.eac1_pct ?? 0))
                    .map((f) => {
                      const r = (f.eac1_pct ?? 0) / 100
                      const tone = r < 0.5 ? 'var(--bad)' : r < 0.75 ? 'var(--warn)' : 'var(--good)'
                      const awaiting = Math.max(0, f.still_unsuppressed - f.switched)
                      return (
                        <TableRow key={f.group}>
                          <TableCell className="font-medium">{f.group}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(f.n)}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-medium tabular-nums" style={{ color: tone }}>{pc(f.eac1_pct)}</span>
                              <span className="h-2 w-20 rounded-[3px] bg-muted" aria-hidden>
                                <span className="block h-full rounded-[3px]"
                                      style={{ width: `${Math.min(r * 100, 100)}%`, background: tone }} />
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(f.post_result)}</TableCell>
                          <TableCell className="text-right tabular-nums">{pc(f.resupp_pct)}</TableCell>
                          <TableCell className={cn('text-right tabular-nums',
                                                   awaiting > 0 && 'font-medium text-bad')}>
                            {fmt(awaiting)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  {!(fac ?? []).some((f) => f.n >= 20) && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                        No facility has 20 or more episodes in this selection.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section eyebrow="Act" title="Actionable flags"
               description="Each row is a facility worklist under the current filters. Open one to work it.">
        <Card className="min-w-0">
          <CardContent className="px-0">
            <Table className="text-xs">
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Worklist</TableHead>
                  <TableHead className="text-right">Episodes</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {WORKLISTS.map((w) => (
                  <TableRow key={w.flag}>
                    <TableCell className="font-medium">{w.label}</TableCell>
                    <TableCell className={cn('text-right tabular-nums',
                                             !counts[w.flag] && 'text-muted-foreground')}>
                      {counts[w.flag] == null ? DASH : fmt(counts[w.flag])}
                    </TableCell>
                    <TableCell className="text-right">
                      {onOpenWorklist && (
                        <Button variant="outline" size="xs" onClick={() => onOpenWorklist(w.flag)}>
                          Open
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

function Heading() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-balance">Deep dive</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Who the unsuppressed clients are, what treatment they are on, when they entered and
          how long they wait, and where they live and are served.
        </p>
      </div>
      <PinFiltersToggle />
    </div>
  )
}
