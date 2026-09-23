/**
 * Development only: the DTC review page in the real frame with synthetic
 * figures and no backend. /app/harness-dtc.html (add ?theme=dark). Not a
 * production build entry.
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
import DtcPage from '@/pages/dtc-page'
import { AWAITING, DTC, TRAJ } from './dtc-fixture'
import '@/styles/fonts.css'
import '@/index.css'

try {
  sessionStorage.setItem('ecews.session', 'harness')
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme === 'light' || theme === 'dark') localStorage.setItem('ecews.theme', theme)
} catch { /* ignore */ }

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/api/me')) return json({ username: 'harness', email: 'h@x', name: 'Harness Admin', role: 'admin', scope_state: null, scope_facility: null })
  if (url.includes('/api/version')) return json({ version: '1.0', commit: 'harness', dirty: true, label: 'v1.0+' })
  if (url.includes('/api/filters')) return json({ states: ['Delta', 'Ekiti', 'Osun'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [], fys: ['FY26'], months: [], plans: [], lga_state: {}, facility_state: {} })
  if (url.includes('/api/dtc/awaiting')) return json(AWAITING)
  if (url.includes('/api/dtc/trajectory')) return json(TRAJ)
  if (url.includes('/api/dtc')) return json(DTC)
  return json({})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider><TooltipProvider><SessionProvider><FilterProvider>
      <SidebarProvider>
        <AppSidebar view="dtc" onNavigate={() => {}} asof="12 Sep 2026" episodes="4,633" clients="4,180" />
        <SidebarInset>
          <SiteHeader title="DTC review" />
          <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
            <DtcPage onOpenWorklist={(f) => console.info('open worklist', f)} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </FilterProvider></SessionProvider></TooltipProvider></ThemeProvider>
  </StrictMode>,
)
