/**
 * The filter bar's state, and the rules about which options may be offered.
 *
 * Every filter is a LIST. "Paediatrics and adolescents" is two age bands, and
 * until the API accepted lists there was no way to ask it - you looked at 0-9,
 * then at 10-19, and added them up by hand, which is exactly the arithmetic a
 * dashboard exists to remove.
 *
 * An empty list means "no restriction", not "nothing". That distinction is the
 * whole of the "All" behaviour and is why nothing here ever sends an empty
 * parameter.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { api } from './api'

/** The API's filter names, which are also the query-string keys. */
export type FilterKey =
  | 'fy' | 'quarter' | 'month' | 'state' | 'lga' | 'lga_res'
  | 'facility' | 'sex' | 'age_band' | 'plan'

export type Selection = Partial<Record<FilterKey, string[]>>

export interface MonthOption { m: string; n: number }

export interface FilterOptions {
  states: string[]
  lgas: string[]
  lga_res: string[]
  facilities: string[]
  age_bands: string[]
  quarters: string[]
  fys: string[]
  months: MonthOption[]
  plans: string[]
  lga_state: Record<string, string>
  facility_state: Record<string, string>
}

interface Ctx {
  options: FilterOptions | null
  error: string | null
  selection: Selection
  /** Values currently chosen for one filter; never undefined. */
  get: (k: FilterKey) => string[]
  set: (k: FilterKey, values: string[]) => void
  reset: () => void
  /** '?fy=FY26&age_band=0-9&age_band=10-19', or '' when nothing is chosen. */
  query: string
  active: number
}

const FilterCtx = createContext<Ctx | null>(null)

/**
 * One parameter PER selected value - ?age_band=0-9&age_band=10-19. FastAPI
 * collects repeats into a list, and a single selection is a list of one, so
 * every existing link and bookmark still resolves.
 */
export function buildQuery(sel: Selection): string {
  const p = new URLSearchParams()
  for (const [k, vals] of Object.entries(sel)) {
    for (const v of vals ?? []) if (v) p.append(k, v)
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<FilterOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>({})

  useEffect(() => {
    let cancelled = false
    api<FilterOptions>('/filters')
      .then((f) => { if (!cancelled) { setOptions(f); setError(null) } })
      .catch((e: unknown) => {
        // Never silently hide the bar. Say what went wrong - an empty filter
        // row and a failed request look identical otherwise.
        if (!cancelled) setError(e instanceof Error ? e.message : 'Filters failed to load')
      })
    return () => { cancelled = true }
  }, [])

  const get = useCallback(
    (k: FilterKey) => selection[k] ?? [], [selection])

  const set = useCallback((k: FilterKey, values: string[]) => {
    setSelection((prev) => {
      const next: Selection = { ...prev, [k]: values }
      // Cascades. Changing a parent invalidates what was chosen beneath it:
      // quarters belong to a fiscal year, and LGA/facility belong to a state,
      // so leaving a stale child selected would filter to nothing and read as
      // "no data" rather than as a contradiction.
      if (k === 'fy') delete next.quarter
      if (k === 'state') { delete next.lga; delete next.facility }
      return next
    })
  }, [])

  const reset = useCallback(() => setSelection({}), [])

  const query = useMemo(() => buildQuery(selection), [selection])
  const active = useMemo(
    () => Object.values(selection).reduce((n, v) => n + (v?.length ?? 0), 0),
    [selection])

  const value = useMemo<Ctx>(
    () => ({ options, error, selection, get, set, reset, query, active }),
    [options, error, selection, get, set, reset, query, active])

  return <FilterCtx.Provider value={value}>{children}</FilterCtx.Provider>
}

export function useFilters(): Ctx {
  const c = useContext(FilterCtx)
  if (!c) throw new Error('useFilters must be used inside <FilterProvider>')
  return c
}

/**
 * Which options each filter may offer, given what else is chosen.
 *
 * Kept as a pure function of (options, selection) so it can be tested without
 * a browser - the cascading rules are the part most likely to go quietly wrong.
 */
export function visibleOptions(
  f: FilterOptions | null, sel: Selection,
): Record<FilterKey, string[]> {
  const empty = {
    fy: [], quarter: [], month: [], state: [], lga: [], lga_res: [],
    facility: [], sex: [], age_band: [], plan: [],
  } as Record<FilterKey, string[]>
  if (!f) return empty

  const fys = sel.fy ?? []
  const states = sel.state ?? []

  // Enrolment quarters belong to a fiscal year (FY26Q1...), so only offer the
  // quarters inside the chosen FY - FY25Q4 must not show under FY26. With
  // several years chosen, offer the quarters of ALL of them rather than none.
  const quarters = fys.length
    ? f.quarters.filter((q) => fys.some((y) => String(q).startsWith(y)))
    : f.quarters

  const within = (all: string[], map: Record<string, string>) =>
    states.length ? all.filter((v) => states.includes(map[v]!)) : all

  return {
    ...empty,
    fy: f.fys,
    quarter: quarters,
    month: f.months.map((m) => m.m),
    state: f.states,
    lga: within(f.lgas, f.lga_state ?? {}),
    // Residence is deliberately NOT cascaded off the service state - a client
    // treated in Delta may live in Edo, and narrowing by the treating state
    // would hide exactly those cross-border cases.
    lga_res: f.lga_res,
    facility: within(f.facilities, f.facility_state ?? {}),
    // The API exposes no list for sex; these are the only two values the EMR
    // records, and 'Unknown' is a data gap rather than a population.
    sex: ['Female', 'Male'],
    age_band: f.age_bands,
    plan: f.plans,
  }
}
