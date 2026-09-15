import { ArrowRight, GitBranch } from 'lucide-react'
import { useEffect, useState, type CSSProperties } from 'react'
import { cn } from 'cn'
import FilterBar, { PinFiltersToggle } from '@/components/filter-bar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/core/api'
import { useFilters } from '@/core/filters'
import { fmt, pc } from '@/core/format'
import { useChartPalette } from '@/core/palette'

/** One row of /api/cascade (indicators.cascade). */
export interface CascadeStep {
  step: number
  label: string
  n: number
  n_female: number
  n_male: number
  denominator: number
  denominator_label: string
  pct: number | null
  note?: string
}

/**
 * The worklist behind a step: the episodes that did not get past it. The
 * cascade shows the gap; the worklist puts names to it.
 */
export const STEP_WORKLIST: Record<number, { flag: string; action: string }> = {
  2: { flag: 'no_eac', action: 'No EAC record' },
  6: { flag: 'eac_incomplete', action: 'EAC not completed' },
  61: { flag: 'awaiting_vl', action: 'No post-EAC VL sample' },
  93: { flag: 'awaiting_switch', action: 'Awaiting DTC review' },
}

/**
 * Loss is shown only where one step follows directly from another. Extended
 * EAC (4+) is not a drop from session 3, and a follow-up sample is not a drop
 * from EAC, so neither carries one.
 */
const LOSS_FROM: Record<number, number> = { 2: 1, 3: 2, 4: 3, 6: 4, 8: 7 }

/** Tier labels match the "#n" the denominators refer to. */
const TIER: Record<number, string> = { 61: '6a', 91: '', 92: '', 93: '9b' }
const SUB = new Set([91, 92])

export default function CascadePage({ onOpenWorklist }: { onOpenWorklist?: (flag: string) => void }) {
  const { query, options } = useFilters()
  const [steps, setSteps] = useState<CascadeStep[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [bySex, setBySex] = useState(false)

  useEffect(() => {
    if (!options) return
    let cancelled = false
    setLoading(true)
    api<CascadeStep[]>(`/cascade${query}`)
      .then((r) => { if (!cancelled) { setSteps(r); setErr(null) } })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not load the cascade') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, options])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-balance">The treatment failure cascade</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            From an unsuppressed viral load through EAC, the follow-up viral load and its outcome.
            Each gap is a group of clients; where a worklist holds them, open it from the step.
          </p>
        </div>
        <PinFiltersToggle />
      </div>

      <FilterBar />

      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {steps === null ? (
        <CascadeSkeleton />
      ) : !steps.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
            <EmptyTitle>No episodes in this selection</EmptyTitle>
            <EmptyDescription>Widen the filters to see the cascade.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // A refetch holds the previous cascade at reduced opacity rather than
        // flashing skeletons, so the page does not jump while a filter applies.
        <div className={cn('flex flex-col gap-4 transition-opacity', loading && 'pointer-events-none opacity-60')}
             aria-busy={loading}>
          <Steps steps={steps} bySex={bySex} setBySex={setBySex} onOpenWorklist={onOpenWorklist} />
          <div className="grid gap-4 xl:grid-cols-2">
            <WhereLost steps={steps} onOpenWorklist={onOpenWorklist} />
            <Outcome steps={steps} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────── steps ──────────────────────────────────── */

function Steps({ steps, bySex, setBySex, onOpenWorklist }: {
  steps: CascadeStep[]
  bySex: boolean
  setBySex: (v: boolean) => void
  onOpenWorklist?: (flag: string) => void
}) {
  const C = useChartPalette()
  const N = steps[0]?.n ?? 0
  const byStep = new Map(steps.map((s) => [s.step, s]))

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Step by step</CardTitle>
        <CardDescription>
          Every bar is drawn against the whole cohort (step 1), so bar lengths compare across steps.
          The rate beside it uses the step's own denominator, named under the count.
        </CardDescription>
        <CardAction>
          <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Bar colouring">
            <Button size="xs" variant={bySex ? 'ghost' : 'secondary'} aria-pressed={!bySex}
                    onClick={() => setBySex(false)}>All</Button>
            <Button size="xs" variant={bySex ? 'secondary' : 'ghost'} aria-pressed={bySex}
                    onClick={() => setBySex(true)}>By sex</Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {bySex && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Swatch color={C.female} label="Female" />
            <Swatch color={C.male} label="Male" />
            <Swatch color={C.unknown} label="Sex not recorded" />
          </div>
        )}
        <ol className="flex flex-col divide-y" aria-label="Cascade steps">
          {steps.map((s) => {
            const sub = SUB.has(s.step)
            const prev = LOSS_FROM[s.step] != null ? byStep.get(LOSS_FROM[s.step]!) : undefined
            const loss = prev ? prev.n - s.n : 0
            const worklist = STEP_WORKLIST[s.step]
            const tier = TIER[s.step] ?? String(s.step)
            return (
              <li key={s.step}
                  className="grid items-center gap-x-5 gap-y-2 py-3 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_9rem]">
                <div className={cn('flex min-w-0 flex-col gap-1', sub && 'pl-7')}>
                  <div className="flex items-baseline gap-2">
                    {!sub && <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{tier}</span>}
                    <span className={cn('text-sm', sub && 'text-muted-foreground')}>{s.label.replace(/^- /, '')}</span>
                  </div>
                  {s.note && <p className={cn('text-xs text-muted-foreground', !sub && 'pl-7')}>{s.note}</p>}
                  {worklist && onOpenWorklist && (
                    <Button variant="link" size="xs" className="h-auto self-start px-0 pl-7 text-xs"
                            onClick={() => onOpenWorklist(worklist.flag)}>
                      Open worklist: {worklist.action}
                      <ArrowRight />
                    </Button>
                  )}
                </div>

                <StepBar step={s} N={N} bySex={bySex} />

                <div className="flex flex-col items-end gap-0.5">
                  <div className="flex items-baseline gap-3 tabular-nums">
                    {loss > 0 && (
                      <span className="text-xs text-muted-foreground">
                        <span className="sr-only">lost since step {LOSS_FROM[s.step]}: </span>−{fmt(loss)}
                      </span>
                    )}
                    <span className="text-sm font-medium">{fmt(s.n)}</span>
                    {s.step !== 1 && <span className="w-12 text-right text-sm text-muted-foreground">{pc(s.pct)}</span>}
                  </div>
                  {s.step !== 1 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      of {fmt(s.denominator)} ({s.denominator_label})
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

function StepBar({ step, N, bySex }: { step: CascadeStep; N: number; bySex: boolean }) {
  const C = useChartPalette()
  const share = (v: number) => (N ? Math.max(0, v) / N * 100 : 0)
  const unknown = step.n - (step.n_female ?? 0) - (step.n_male ?? 0)
  // Status colour only where the step itself is a bad outcome, and its label says so.
  const tone = step.step === 93 ? 'var(--bad)'
    : SUB.has(step.step) ? 'color-mix(in oklch, var(--primary) 55%, transparent)'
    : 'var(--primary)'
  const seg = (v: number, color: string, last: boolean): CSSProperties => ({
    width: `${share(v)}%`, background: color,
    // a 2px surface gap between stacked segments, never a border
    boxShadow: last ? undefined : '2px 0 0 0 var(--card)',
  })
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-[4px] bg-muted" aria-hidden>
      {bySex ? (
        <>
          <span className="h-full" style={seg(step.n_female, C.female, false)} />
          <span className="relative h-full" style={seg(step.n_male, C.male, unknown <= 0)} />
          {unknown > 0 && <span className="h-full" style={seg(unknown, C.unknown, true)} />}
        </>
      ) : (
        <span className="h-full rounded-r-[4px]" style={{ width: `${share(step.n)}%`, background: tone }} />
      )}
    </div>
  )
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

/* ─────────────────────────────── where it is lost ──────────────────────────── */

function WhereLost({ steps, onOpenWorklist }: {
  steps: CascadeStep[]
  onOpenWorklist?: (flag: string) => void
}) {
  const g = (k: number) => steps.find((s) => s.step === k)?.n ?? 0
  const gaps: { label: string; n: number; flag?: string; pending?: boolean }[] = [
    { label: 'Never commenced EAC', n: Math.max(0, g(1) - g(2)), flag: 'no_eac' },
    { label: 'Started, stopped before session 3', n: Math.max(0, g(2) - g(4)), flag: 'eac_incomplete' },
    { label: 'At session 3, not yet 30 days on', n: Math.max(0, g(4) - g(6)), pending: true },
    { label: 'Completed EAC, no post-EAC VL sample', n: Math.max(0, g(6) - g(61)), flag: 'awaiting_vl' },
    { label: 'Still unsuppressed, awaiting DTC review', n: Math.max(0, g(93) - g(10)), flag: 'awaiting_switch' },
  ]
  const max = Math.max(1, ...gaps.map((x) => x.n))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where the cohort is lost</CardTitle>
        <CardDescription>
          Episodes at each gap. The grey bar is not yet a loss: those clients are inside the
          30-day wait after session 3.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3" aria-label="Losses by gap">
          {gaps.map((x) => (
            <li key={x.label} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_4rem]">
              {x.flag && onOpenWorklist ? (
                // Labels wrap rather than truncate: a clipped gap name is a lost finding.
                <button type="button" onClick={() => onOpenWorklist(x.flag!)}
                        className="group inline-flex min-w-0 items-center gap-1 text-left text-sm hover:underline">
                  <span>{x.label}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                </button>
              ) : <span className="text-sm text-muted-foreground">{x.label}</span>}
              <div className="h-3 w-full rounded-[4px] bg-muted" aria-hidden>
                <div className="h-full rounded-r-[4px]"
                     style={{ width: `${x.n / max * 100}%`,
                              background: x.pending ? 'var(--muted-foreground)' : 'var(--primary)',
                              opacity: x.pending ? 0.45 : 1 }} />
              </div>
              <span className="text-right text-sm font-medium tabular-nums">{fmt(x.n)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────────────── outcome ───────────────────────────────── */

function Outcome({ steps }: { steps: CascadeStep[] }) {
  const g = (k: number) => steps.find((s) => s.step === k)?.n ?? 0
  const N = g(1)
  const parts = [
    { label: 'Undetectable (<50)', n: g(91), color: 'var(--good)' },
    { label: 'Low-level viraemia (50-999)', n: g(92), color: 'color-mix(in oklch, var(--good) 50%, transparent)' },
    { label: 'Still unsuppressed (1,000 or more)', n: g(93), color: 'var(--bad)' },
    { label: 'No follow-up VL result yet', n: Math.max(0, N - g(8)), color: 'var(--muted-foreground)', faint: true },
  ]
  const share = (v: number) => (N ? v / N * 100 : 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Follow-up VL outcome</CardTitle>
        <CardDescription>
          The whole cohort by the result of its follow-up viral load, recomputed from the value,
          never the EMR status text.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex h-4 w-full overflow-hidden rounded-[4px] bg-muted" aria-hidden>
          {parts.map((p, i) => (
            <span key={p.label} className="h-full"
                  style={{ width: `${share(p.n)}%`, background: p.color, opacity: p.faint ? 0.35 : 1,
                           boxShadow: i < parts.length - 1 ? '2px 0 0 0 var(--card)' : undefined }} />
          ))}
        </div>
        <ul className="flex flex-col divide-y text-sm" aria-label="Follow-up VL outcome">
          {parts.map((p) => (
            <li key={p.label} className="flex items-center justify-between gap-4 py-2">
              <span className="inline-flex items-center gap-2">
                <span className="size-2.5 rounded-[3px]" style={{ background: p.color, opacity: p.faint ? 0.35 : 1 }} aria-hidden />
                {p.label}
              </span>
              <span className="flex items-baseline gap-3 tabular-nums">
                <span className="font-medium">{fmt(p.n)}</span>
                <span className="w-12 text-right text-muted-foreground">{pc(N ? Math.round(share(p.n) * 10) / 10 : null)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function CascadeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the cascade">
      <Skeleton className="h-[34rem] w-full rounded-xl" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  )
}
