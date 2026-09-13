/**
 * Development only: the rebuilt frame and Overview, with illustrative figures
 * and no backend, so the design can be looked at without signing in.
 *
 * Served by `npm run dev` at /app/harness-overview.html; not a production
 * build entry. Every figure below is made up and internally consistent - it is
 * not the live cohort - and the facility names are placeholders.
 * Add ?theme=dark to see the dark palette.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilterProvider } from '@/core/filters'
import type { Overview, TimeMetrics } from '@/core/overview'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import type { Trend } from '@/core/use-trend'
import OverviewPage from '@/pages/overview-page'
import '@/styles/fonts.css'
import '@/index.css'

if (new URLSearchParams(location.search).get('theme') === 'dark') {
  try { localStorage.setItem('ecews.theme', 'dark') } catch { /* ignore */ }
} else {
  try { localStorage.setItem('ecews.theme', 'light') } catch { /* ignore */ }
}

const OPTIONS = {
  states: ['Delta', 'Ekiti', 'Osun'], lgas: ['Delta LGA 1'], lga_res: ['Delta LGA 1'],
  facilities: ['Delta Facility A'], age_bands: ['0-9', '10-19', '20+'], quarters: ['FY26Q1'],
  fys: ['FY26'], months: [{ m: '2026-08', n: 312 }], plans: ['Repeat EAC'],
  lga_state: { 'Delta LGA 1': 'Delta' }, facility_state: { 'Delta Facility A': 'Delta' },
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/version')) return json({ version: '1.0', commit: 'harness', dirty: true, label: 'v1.0+' })
  return json(OPTIONS)
}

const MONTHS = ['2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01',
  '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']

const DATA: Overview = {
  n: 4548, clients: 4101, repeats: 447, repeat_clients: 389, as_of: '2026-09-05', warnings: null,
  eac1: 3912, eac1_pct: 86.0, never_eac: 636, completed: 2104, completed_pct: 53.8, post_eac_vl: 1290,
  retested: 1877, retest_pct: 41.3, awaiting_retest: 2671, resuppressed: 1402, resupp_pct: 74.7,
  still_unsuppressed: 475, switch_eligible: 475, switched: 310, prior_switch: 42, switch_pct: 65.3,
  awaiting_switch: 123, repeat_failure: 88,
  progress: [
    { quarter: 'FY25Q4', n: 812, eac1: 731, completed: 498, retested: 506, resuppressed: 389, eac1_pct: 90.0, completed_pct: 68.1, retest_pct: 62.3, resupp_pct: 76.9 },
    { quarter: 'FY26Q1', n: 1046, eac1: 930, completed: 602, retested: 541, resuppressed: 402, eac1_pct: 88.9, completed_pct: 64.7, retest_pct: 51.7, resupp_pct: 74.3 },
    { quarter: 'FY26Q2', n: 1118, eac1: 972, completed: 551, retested: 470, resuppressed: 348, eac1_pct: 86.9, completed_pct: 56.7, retest_pct: 42.0, resupp_pct: 74.0 },
    { quarter: 'FY26Q3', n: 1021, eac1: 858, completed: 371, retested: 290, resuppressed: 214, eac1_pct: 84.0, completed_pct: 43.2, retest_pct: 28.4, resupp_pct: 73.8 },
    { quarter: 'FY26Q4', n: 551, eac1: 421, completed: 82, retested: 70, resuppressed: 49, eac1_pct: 76.4, completed_pct: 19.5, retest_pct: 12.7, resupp_pct: 70.0 },
  ],
  weekly: { months: MONTHS,
            female: [120, 128, 131, 139, 147, 144, 156, 151, 163, 159, 171, 168, 176, 182],
            male: [72, 77, 80, 84, 90, 88, 95, 92, 99, 97, 104, 102, 107, 111] },
  resupp_trend: { months: MONTHS,
                  female: [71.2, 73.0, 74.1, 72.8, 75.5, 76.0, 74.9, 76.8, 77.2, 75.9, 78.1, 77.4, 76.6, 58.0],
                  male: [68.0, 69.4, 71.2, 70.1, 72.3, 71.8, 73.0, 72.1, 74.4, 73.6, 74.9, 75.2, 73.8, 52.5],
                  female_n: [40, 44, 51, 48, 53, 57, 55, 60, 58, 62, 66, 61, 49, 18],
                  male_n: [22, 25, 27, 26, 30, 29, 31, 33, 32, 34, 36, 35, 27, 9] },
  demo: { female: 2800, female_pct: 61.6, male: 1748, male_pct: 38.4, paeds: 180, paeds_pct: 4.0,
          adolescents: 410, adolescents_pct: 9.0, median_months_art: 48, first_line: 3900, first_line_pct: 85.8,
          second_line: 600, second_line_pct: 13.2, median_time_to_eac: 25, median_lead_months: 4.3 },
  disagg: { sex: { Female: { n: 1200, resupp: 900, pct: 75.0 }, Male: { n: 677, resupp: 502, pct: 74.2 } },
            state: { Delta: { n: 900, resupp: 700, pct: 77.8 }, Ekiti: { n: 420, resupp: 305, pct: 72.6 }, Osun: { n: 557, resupp: 397, pct: 71.3 } } },
  by_state: [
    { state: 'Delta', n: 2210, eac1: 1990, completed: 1100, post: 900, resupp: 700, eac1_pct: 90.0, resupp_pct: 77.8 },
    { state: 'Osun', n: 1320, eac1: 1100, completed: 610, post: 557, resupp: 397, eac1_pct: 83.3, resupp_pct: 71.3 },
    { state: 'Ekiti', n: 1018, eac1: 822, completed: 394, post: 420, resupp: 305, eac1_pct: 80.7, resupp_pct: 72.6 },
  ],
  by_volume: [
    { facility: 'Delta Facility A', n: 199, eac1: 181, completed: 90, eac1_pct: 91.0, completed_pct: 49.7 },
    { facility: 'Osun Facility A', n: 164, eac1: 140, completed: 81, eac1_pct: 85.4, completed_pct: 57.9 },
    { facility: 'Delta Facility B', n: 151, eac1: 139, completed: 88, eac1_pct: 92.1, completed_pct: 63.3 },
    { facility: 'Ekiti Facility A', n: 132, eac1: 101, completed: 47, eac1_pct: 76.5, completed_pct: 46.5 },
    { facility: 'Osun Facility B', n: 118, eac1: 97, completed: 60, eac1_pct: 82.2, completed_pct: 61.9 },
  ],
  best: [
    { facility: 'Osun Facility C', n: 44, eac1: 44, completed: 40, eac1_pct: 100.0, completed_pct: 90.9 },
    { facility: 'Delta Facility D', n: 61, eac1: 58, completed: 49, eac1_pct: 95.1, completed_pct: 84.5 },
    { facility: 'Ekiti Facility C', n: 38, eac1: 36, completed: 29, eac1_pct: 94.7, completed_pct: 80.6 },
    { facility: 'Delta Facility B', n: 151, eac1: 139, completed: 88, eac1_pct: 92.1, completed_pct: 63.3 },
    { facility: 'Osun Facility B', n: 118, eac1: 97, completed: 60, eac1_pct: 82.2, completed_pct: 61.9 },
  ],
  min_vol: 20,
  zero_eac: [{ facility: 'Ekiti Facility D', n: 31 }, { facility: 'Delta Facility E', n: 24 }],
  sources: [
    { name: 'TF Register', kind: 'total', rows: 4548 },
    { name: 'Treatment Linelist 5th September', kind: 'treatment', rows: 180832 },
    { name: 'EAC Line List_23rd May', kind: 'eac', rows: 42478, censored: true },
  ],
}

const TIMES: TimeMetrics = {
  time_to_eac: { n: 3900, median: 25, q1: 9, q3: 61, mean: 44, min: 0, max: 700, wlo: 0, whi: 139 },
  eac_lead_time: { n: 1800, median: 131, q1: 80, q3: 210, mean: 150, min: 1, max: 900, wlo: 1, whi: 405 },
  time_to_resuppression: { n: 1400, median: 160, q1: 100, q3: 250, mean: 180, min: 5, max: 800, wlo: 5, whi: 475 },
  months_unsuppressed: { n: 4548, median: 7.2, q1: 3.1, q3: 13.4, mean: 9, min: 0, max: 60, wlo: 0, whi: 28 },
}

const TREND: Trend = {
  prevAsOf: '2026-08-22', days: 14, backDated: false,
  values: {
    cohort: { delta: 136, unit: 'episodes' }, eac1: { delta: 1.0, unit: 'pts' },
    completed: { delta: 0.8, unit: 'pts' }, postEac: { delta: -1.2, unit: 'pts' },
    retest: { delta: -2.4, unit: 'pts' }, resupp: { delta: 0.3, unit: 'pts' },
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <SessionProvider>
          <FilterProvider>
            <SidebarProvider>
              <AppSidebar view="overview" onNavigate={() => {}} asof="5 Sep 2026" episodes="4,548" clients="4,101" />
              <SidebarInset>
                <SiteHeader title="Overview" />
                <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
                  <OverviewPage data={DATA} times={TIMES} trend={TREND} loading={false} />
                </div>
              </SidebarInset>
            </SidebarProvider>
          </FilterProvider>
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
