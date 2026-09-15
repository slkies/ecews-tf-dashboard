/**
 * Development only: the Cascade page in the real frame with made-up figures and
 * no backend, for checking layout and both themes in a real browser. Served by
 * `npm run dev` at /app/harness-cascade.html (add ?theme=dark); not a
 * production build entry. Every figure below is synthetic.
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
import CascadePage, { type CascadeStep } from '@/pages/cascade-page'
import '@/styles/fonts.css'
import '@/index.css'

try {
  sessionStorage.setItem('ecews.session', 'harness')
  const theme = new URLSearchParams(location.search).get('theme')
  // ThemeProvider reads the remembered choice, so the parameter has to set that.
  if (theme === 'light' || theme === 'dark') localStorage.setItem('ecews.theme', theme)
} catch { /* ignore */ }

const OPTIONS = {
  states: ['Delta', 'Ekiti', 'Osun'], lgas: [], lga_res: [], facilities: [], age_bands: [],
  quarters: [], fys: ['FY26'], months: [], plans: [], lga_state: {}, facility_state: {},
}
const step = (s: number, label: string, n: number, den: number, dl: string, note?: string): CascadeStep => ({
  step: s, label, n, n_female: Math.round(n * 0.62), n_male: Math.round(n * 0.36),
  denominator: den, denominator_label: dl, pct: den ? Math.round(n / den * 1000) / 10 : null, note,
})
const STEPS: CascadeStep[] = [
  step(1, 'Total unsuppressed', 4548, 4548, '-'),
  step(2, 'EAC commenced', 3790, 4548, '#1'),
  step(3, 'EAC session 2', 3305, 3790, '#2'),
  step(4, 'EAC session 3', 2980, 3790, '#2'),
  step(5, 'Extended EAC (4+)', 212, 3790, '#2'),
  step(6, 'EAC completed', 2701, 3790, '#2'),
  step(61, 'Post-EAC VL sample', 1904, 2980, '#4', 'Sessions 1-3 done AND a VL sample on/after session 3, irrespective of the 30-day rule.'),
  step(7, 'Follow-up VL sample', 2388, 4548, '#1'),
  step(8, 'Follow-up VL result', 2197, 4548, '#1', 'Any later VL from the clinical line lists, not a post-EAC result. Reported against the cohort, not EAC1.'),
  step(9, 'Re-suppressed (<1,000)', 1522, 2197, '#8'),
  step(91, '- Undetectable (<50)', 1180, 2197, '#8'),
  step(92, '- LLV (50-999)', 342, 2197, '#8'),
  step(93, 'Still unsuppressed', 675, 2197, '#8'),
  step(10, 'Switched to 2nd/3rd line', 96, 675, '#9b', 'Denominator = episodes still >= 1,000 after follow-up. No switch date in the export, so time-to-switch is not computable.'),
]

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/me')) return json({ username: 'harness', email: 'h@x', name: 'Harness Admin', role: 'admin', scope_state: null, scope_facility: null })
  if (url.includes('/api/version')) return json({ version: '1.0', commit: 'harness', dirty: true, label: 'v1.0+' })
  if (url.includes('/api/filters')) return json(OPTIONS)
  if (url.includes('/api/cascade')) return json(STEPS)
  return json({})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <SessionProvider>
          <FilterProvider>
            <SidebarProvider>
              <AppSidebar view="cascade" onNavigate={() => {}} asof="5 Sep 2026" episodes="4,548" clients="4,101" />
              <SidebarInset>
                <SiteHeader title="Cascade" />
                <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
                  <CascadePage onOpenWorklist={(f) => console.info('open worklist', f)} />
                </div>
              </SidebarInset>
            </SidebarProvider>
          </FilterProvider>
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
