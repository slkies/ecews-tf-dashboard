import { CircleAlert, Hammer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import ErrorBoundary from '@/components/error-boundary'
import { SiteHeader } from '@/components/site-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { api } from '@/core/api'
import { useFilters } from '@/core/filters'
import { fmt, fmtDate } from '@/core/format'
import type { Overview as Ov, TimeMetrics } from '@/core/overview'
import type { Summary } from '@/core/types'
import { useTrend } from '@/core/use-trend'
import CascadePage from '@/pages/cascade-page'
import DeepDivePage from '@/pages/deep-dive-page'
import DtcPage from '@/pages/dtc-page'
import OverviewPage from '@/pages/overview-page'
import WorklistsPage from '@/pages/worklists-page'
import { NAV } from './nav'

export default function AppShell() {
  const { query, options } = useFilters()
  const [view, setView] = useState('overview')
  // Which worklist to open when arriving from another page (a cascade step).
  const [worklistFlag, setWorklistFlag] = useState<string | null>(null)
  const navigate = (v: string) => { setWorklistFlag(null); setView(v); window.scrollTo(0, 0) }
  const openWorklist = (flag: string) => { setWorklistFlag(flag); setView('worklists'); window.scrollTo(0, 0) }
  const [summary, setSummary] = useState<Summary | null>(null)
  const [overview, setOverview] = useState<Ov | null>(null)
  const [times, setTimes] = useState<TimeMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const trend = useTrend(query, !!options)

  // Re-fetch whenever the filter query changes. `query` is a string, so an
  // identical selection reached another way does not refetch.
  useEffect(() => {
    if (!options) return          // wait for the filters, or the first call is unfiltered
    let cancelled = false
    setLoading(true)
    Promise.all([
      api<Summary>(`/summary${query}`),
      api<Ov>(`/overview${query}`),
      api<TimeMetrics>(`/time-metrics${query}`),
    ])
      .then(([s, o, t]) => {
        if (cancelled) return
        setSummary(s); setOverview(o); setTimes(t); setErr(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not load')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query, options])

  const label = NAV.find((n) => n.id === view)?.label ?? 'Overview'

  return (
    <SidebarProvider>
      <AppSidebar view={view} onNavigate={navigate}
                  asof={fmtDate(summary?.as_of)} episodes={fmt(summary?.n)}
                  clients={fmt(summary?.clients)} />
      <SidebarInset>
        <SiteHeader title={label} />
        <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
          {err && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>The dashboard could not load</AlertTitle>
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}
          {view === 'overview' ? (
            <ErrorBoundary name="Overview">
              <OverviewPage data={overview} times={times} trend={trend} loading={loading} />
            </ErrorBoundary>
          ) : view === 'deep' ? (
            <ErrorBoundary name="Deep dive">
              <DeepDivePage onOpenWorklist={openWorklist} />
            </ErrorBoundary>
          ) : view === 'dtc' ? (
            <ErrorBoundary name="DTC review">
              <DtcPage onOpenWorklist={openWorklist} />
            </ErrorBoundary>
          ) : view === 'cascade' ? (
            <ErrorBoundary name="Cascade">
              <CascadePage onOpenWorklist={openWorklist} />
            </ErrorBoundary>
          ) : view === 'worklists' ? (
            <ErrorBoundary name="Worklists">
              <WorklistsPage key={worklistFlag ?? 'default'} initialFlag={worklistFlag} />
            </ErrorBoundary>
          ) : <NotPorted label={label} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * Pages not yet rebuilt say so and point at the live dashboard, rather than
 * showing an empty panel that looks broken.
 */
function NotPorted({ label }: { label: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Hammer /></EmptyMedia>
        <EmptyTitle>{label} has not been rebuilt yet</EmptyTitle>
        <EmptyDescription>
          It is still live on the current dashboard, which is unchanged and remains
          the one to use for programme work.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <a href="/" className={buttonVariants({ variant: 'outline' })}>Open the current dashboard</a>
      </EmptyContent>
    </Empty>
  )
}
