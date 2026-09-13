/**
 * Development only: the Worklists page in the real frame, with made-up rows and
 * no backend, so the table's popups (Columns, rows per page) can be checked in
 * a real browser - jsdom cannot open them. Served by `npm run dev` at
 * /app/harness-worklists.html; not a production build entry. Every S/N and
 * facility below is synthetic.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppSidebar } from '@/components/app-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilterProvider } from '@/core/filters'
import { SessionProvider } from '@/core/session'
import { ThemeProvider } from '@/core/theme'
import WorklistsPage, { WORKLISTS, type ClientRow } from '@/pages/worklists-page'
import '@/styles/fonts.css'
import '@/index.css'

try { sessionStorage.setItem('ecews.session', 'harness') } catch { /* ignore */ }

const OPTIONS = {
  states: ['Delta', 'Ekiti', 'Osun'], lgas: [], lga_res: [], facilities: [], age_bands: ['0-9', '10-19'],
  quarters: [], fys: ['FY26'], months: [], plans: [], lga_state: {}, facility_state: {},
}
const STATES = ['Delta', 'Ekiti', 'Osun']
const ROWS: ClientRow[] = Array.from({ length: 137 }, (_, i) => {
  const s = STATES[i % 3]!
  const unsupp = i % 5 === 0
  return {
    episode: `0.${String(900000000000 + i)}|2026-0${1 + (i % 8)}-15`, sn: `0.${String(900000000000 + i)}`,
    state: s, lga: `${s} LGA ${1 + (i % 4)}`, facility: `${s} Facility ${String.fromCharCode(65 + (i % 9))}`,
    sex: i % 3 ? 'Female' : 'Male', age: 14 + ((i * 7) % 50), art_status: i % 11 ? 'Active' : 'LTFU',
    idx_vl: 1000 + ((i * 7919) % 250000), recv_date: `2026-0${1 + (i % 8)}-${String(10 + (i % 18)).padStart(2, '0')}`,
    idx_samp: `2026-0${1 + (i % 8)}-05`, idx_date: `2026-0${1 + (i % 8)}-05`, sessions: i % 4,
    eac_completed: i % 4 === 3, fu_vl: unsupp ? 1200 + i * 31 : i % 3 ? null : 40,
    still_unsuppressed: unsupp, switched: false, months_unsuppressed: 3 + (i % 14),
    treatment_plan: ['Repeat EAC', 'Refer to DTC', 'Continue current regimen'][i % 3]!,
  }
})

const json = (b: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } })

window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/me')) return json({ username: 'harness', email: 'h@x', name: 'Harness Admin', role: 'admin', scope_state: null, scope_facility: null })
  if (url.includes('/api/version')) return json({ version: '1.0', commit: 'harness', dirty: true, label: 'v1.0+' })
  if (url.includes('/api/filters')) return json(OPTIONS)
  if (url.includes('/api/worklists')) {
    return json(WORKLISTS.map((w, i) => ({ flag: w.flag, n: i === 1 ? ROWS.length : [42, 0, 19, 7, 88, 213, 31, 0, 3, 12, 5][i] ?? 0 })))
  }
  if (url.includes('/api/clients')) return json(ROWS)
  return json({})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <SessionProvider>
          <FilterProvider>
            <SidebarProvider>
              <AppSidebar view="worklists" onNavigate={() => {}} asof="5 Sep 2026" episodes="4,548" clients="4,101" />
              <SidebarInset>
                <SiteHeader title="Worklists" />
                <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
                  <WorklistsPage />
                </div>
              </SidebarInset>
            </SidebarProvider>
          </FilterProvider>
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
