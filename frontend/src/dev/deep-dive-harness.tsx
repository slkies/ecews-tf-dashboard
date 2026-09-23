/**
 * Development only: the Deep dive page in the real frame, with made-up figures
 * and no backend. Served by `npm run dev` at /app/harness-deep-dive.html (add
 * ?theme=dark). Not a production build entry. Every figure below is synthetic.
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
import DeepDivePage, { type Dist, type FacilityRow, type Profile } from '@/pages/deep-dive-page'
import { WORKLISTS } from '@/pages/worklists-page'
import '@/styles/fonts.css'
import '@/index.css'

try {
  sessionStorage.setItem('ecews.session', 'harness')
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme === 'light' || theme === 'dark') localStorage.setItem('ecews.theme', theme)
} catch { /* ignore */ }

const dist = (pairs: [string, number][]): Dist[] => {
  const t = pairs.reduce((a, [, n]) => a + n, 0) || 1
  return pairs.map(([level, n]) => ({ level, n, pct: Math.round(n / t * 1000) / 10 }))
}

const LGAS = ['ughellinorth', 'warrisouth', 'oshimilisouth', 'ethiopeeast', 'ilesaeast',
              'osogbo', 'olorunda', 'adoekiti', 'ikereekiti', 'sapele', 'okpe', 'ifecentral']
const counts = Object.fromEntries(LGAS.map((k, i) => {
  const n = 380 - i * 29
  return [k, { n, f: Math.round(n * 0.6), m: Math.round(n * 0.4), peds: 6 + i, adol: 20 - i }]
}))

const P: Profile = {
  n: 4633, clients: 4180,
  who: {
    median_age: 38, female_pct: 61.4, adolescent_pct: 8.2, paed_pct: 3.1,
    sex: dist([['Female', 2845], ['Male', 1770], ['Unknown', 18]]),
    age_group: dist([['Under 10', 144], ['10-19', 380], ['20+', 4109]]),
    age_band: dist([['0-9', 144], ['10-19', 380], ['20-24', 290], ['25-34', 910], ['35-49', 1840], ['50+', 1050], ['Unknown', 19]]),
    marital: dist([['Married', 1980], ['Never married', 1120], ['Previously married', 640], ['Other', 60], ['Not recorded', 833]]),
    education: dist([['Primary', 980], ['Secondary', 1640], ['Tertiary', 520], ['Other', 40], ['Not recorded', 1453]]),
    job: dist([['Employee', 1800], ['Unemployed', 900], ['Student', 410], ['Other', 220], ['Not recorded', 1303]]),
    pregnancy: dist([['Pregnant', 88], ['Breastfeeding', 140], ['Not pregnant', 2010], ['Not recorded', 607]]),
  },
  what: {
    median_years_art: 7.4,
    regimen: dist([['1st line', 4102], ['2nd/3rd line', 531]]),
    vl_magnitude: dist([['1k-10k', 2410], ['10k-100k', 1510], ['>=100k', 713]]),
    cd4: dist([['<200', 520], ['>=200', 1010], ['Not recorded', 3103]]),
    years_art: dist([['<1 yr', 310], ['1-3 yr', 690], ['3-5 yr', 720], ['5-10 yr', 1610], ['10+ yr', 1250], ['Not recorded', 53]]),
    eac_status: dist([['Never commenced', 610], ['Commenced, not completed', 1350], ['Completed EAC', 2673]]),
    who_stage: dist([['Stage 1', 2900], ['Stage 2', 810], ['Stage 3', 380], ['Stage 4', 70], ['Not recorded', 473]]),
    bmi: dist([['Underweight (<18.5)', 410], ['Normal (18.5-24.9)', 2210], ['Overweight (25-29.9)', 980], ['Obese (30+)', 520], ['Not recorded', 513]]),
    plan: dist([['Repeat EAC', 1720], ['Refer to DTC', 820], ['Continue current regimen', 1640], ['Not recorded', 453]]),
  },
  when: {
    monthly: {
      months: ['2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01',
               '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'],
      n: [310, 342, 298, 355, 330, 290, 348, 362, 371, 340, 356, 330, 344, 318, 140],
      exits: [120, 180, 210, 240, 232, 225, 260, 250, 262, 270, 255, 248, 240, 230, 96],
    },
    wait: { n: 2197, median: 104, q1: 62, q3: 171, pending: 191 },
    quarter: dist([['FY25Q4', 950], ['FY26Q1', 980], ['FY26Q2', 1070], ['FY26Q3', 1033], ['FY26Q4', 600]]),
    time_to_first_vl: dist([['<6 mo', 1210], ['6-12 mo', 1350], ['1-2 yr', 820], ['2+ yr', 690], ['Not recorded', 563]]),
    yrs_to_unsupp: dist([['<1 yr', 520], ['1-3 yr', 940], ['3-5 yr', 810], ['5-10 yr', 1330], ['10+ yr', 880], ['Not recorded', 153]]),
    time_to_eac: dist([['<=30 d', 2120], ['31-90 d', 1230], ['>90 d', 673], ['No EAC on record', 610]]),
    months_unsupp: dist([['<3 mo', 1210], ['3-6 mo', 1080], ['6-12 mo', 1240], ['12+ mo', 1050], ['Not recorded', 53]]),
    ttfv_months: { n: 4070, median: 8.2, q1: 5.6, q3: 16.1 },
    ttfu_years: { n: 4480, median: 5.8, q1: 2.4, q3: 9.9 },
    mu_stats: { n: 4580, median: 7.1, q1: 3.2, q3: 12.9 },
  },
  care: {
    neg_total: 1320, neg_pct: 28.5, neg_no_followup: 870, neg_no_post_eac: 1010, neg_dated: 1180,
    status: dist([['Active', 3313], ['LTFU', 480], ['Transferred out', 370], ['Discontinued Care', 310], ['Death', 160]]),
    exit_when: dist([['Before EAC', 420], ['During EAC', 380], ['After EAC, before repeat VL', 250], ['After repeat VL', 130], ['Not dated', 140]]),
    breakdown: [
      { level: 'LTFU', n: 480, no_followup_vl: 390 },
      { level: 'Transferred out', n: 370, no_followup_vl: 210 },
      { level: 'Discontinued Care', n: 310, no_followup_vl: 190 },
      { level: 'Death', n: 160, no_followup_vl: 80 },
    ],
  },
  where: {
    state: dist([['Delta', 2580], ['Osun', 1210], ['Ekiti', 843]]),
    lga: dist([['Warri South', 520], ['Uvwie', 410], ['Osogbo', 380], ['Ado Ekiti', 360], ['Oshimili South', 300],
               ['Ughelli North', 280], ['Sapele', 240], ['Olorunda', 210], ['Ikere', 180], ['Ife Central', 170]]),
    facility: dist([['Delta Facility A', 410], ['Osun Facility B', 330], ['Delta Facility C', 300], ['Ekiti Facility D', 280],
                    ['Delta Facility E', 240], ['Osun Facility F', 210], ['Delta Facility G', 190], ['Ekiti Facility H', 180],
                    ['Osun Facility I', 160], ['Delta Facility J', 150]]),
    lga_res: { counts, total: 4633 },
  },
}

const FAC: FacilityRow[] = Array.from({ length: 14 }, (_, i) => ({
  group: `${['Delta', 'Osun', 'Ekiti'][i % 3]} Facility ${String.fromCharCode(65 + i)}`,
  n: 40 + i * 23, eac1_pct: 38 + i * 4.3, post_result: 20 + i * 11,
  resupp_pct: 55 + (i % 5) * 6, still_unsuppressed: 6 + (i % 7), switched: i % 4,
}))

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.includes('/api/')) return realFetch(input, init)          // the map's boundary files
  if (url.includes('/api/me')) return json({ username: 'harness', email: 'h@x', name: 'Harness Admin', role: 'admin', scope_state: null, scope_facility: null })
  if (url.includes('/api/version')) return json({ version: '1.0', commit: 'harness', dirty: true, label: 'v1.0+' })
  if (url.includes('/api/filters')) return json({ states: ['Delta', 'Ekiti', 'Osun'], lgas: [], lga_res: [], facilities: [], age_bands: [], quarters: [], fys: ['FY26'], months: [], plans: [], lga_state: {}, facility_state: {} })
  if (url.includes('/api/profile')) return json(P)
  if (url.includes('/api/breakdown/facility')) return json(FAC)
  if (url.includes('/api/worklists')) return json(WORKLISTS.map((w, i) => ({ flag: w.flag, n: [610, 1350, 330, 480, 88, 213, 1240, 870, 42, 12, 5, 3][i] ?? 0 })))
  return json({})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <SessionProvider>
          <FilterProvider>
            <SidebarProvider>
              <AppSidebar view="deep" onNavigate={() => {}} asof="12 Sep 2026" episodes="4,633" clients="4,180" />
              <SidebarInset>
                <SiteHeader title="Deep dive" />
                <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-4 lg:p-6">
                  <DeepDivePage onOpenWorklist={(f) => console.info('open worklist', f)} />
                </div>
              </SidebarInset>
            </SidebarProvider>
          </FilterProvider>
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
