/**
 * Development only: the filter bar on its own, in a real browser, with made-up
 * options and no backend.
 *
 * Exists because Base UI's popups cannot be exercised in jsdom, so this is
 * where the combobox behaviour is actually checked. Served by `npm run dev` at
 * /app/harness.html; it is not an entry of the production build. The facility
 * and LGA names are illustrative placeholders, not real sites.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FilterBar from '@/components/filter-bar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilterProvider, useFilters } from '@/core/filters'
import '@/index.css'

const OPTIONS = {
  states: ['Delta', 'Ekiti', 'Osun'],
  lgas: ['Delta LGA 1', 'Delta LGA 2', 'Ekiti LGA 1', 'Osun LGA 1', 'Osun LGA 2'],
  lga_res: ['Delta LGA 1', 'Edo LGA 1', 'Ekiti LGA 1', 'Osun LGA 2'],
  facilities: ['Delta Facility A', 'Delta Facility B', 'Delta Facility C', 'Ekiti Facility A',
               'Ekiti Facility B', 'Osun Facility A', 'Osun Facility B'],
  age_bands: ['0-9', '10-19', '20-24', '25-49', '50+'],
  quarters: ['FY25Q4', 'FY26Q1', 'FY26Q2', 'FY26Q3', 'FY26Q4'],
  fys: ['FY25', 'FY26'],
  months: [{ m: '2026-08', n: 312 }, { m: '2026-07', n: 288 }, { m: '2026-06', n: 301 }, { m: '2023-02', n: 2 }],
  plans: ['Continue current regimen', 'Repeat EAC', 'Refer to DTC'],
  lga_state: { 'Delta LGA 1': 'Delta', 'Delta LGA 2': 'Delta', 'Ekiti LGA 1': 'Ekiti',
               'Osun LGA 1': 'Osun', 'Osun LGA 2': 'Osun' },
  facility_state: { 'Delta Facility A': 'Delta', 'Delta Facility B': 'Delta', 'Delta Facility C': 'Delta',
                    'Ekiti Facility A': 'Ekiti', 'Ekiti Facility B': 'Ekiti',
                    'Osun Facility A': 'Osun', 'Osun Facility B': 'Osun' },
}

window.fetch = async () =>
  new Response(JSON.stringify(OPTIONS), { status: 200, headers: { 'Content-Type': 'application/json' } })

function Query() {
  const { query } = useFilters()
  return (
    <pre data-testid="query" className="mt-4 rounded-lg bg-muted p-3 font-mono text-xs">
      {query || '(no filters)'}
    </pre>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <FilterProvider>
        <main className="mx-auto max-w-6xl p-6">
          <FilterBar />
          <Query />
        </main>
      </FilterProvider>
    </TooltipProvider>
  </StrictMode>,
)
