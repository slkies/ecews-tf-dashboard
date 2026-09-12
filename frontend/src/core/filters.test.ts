/**
 * The cascading rules and the query string.
 *
 * These are the parts that fail silently: a stale child selection filters to
 * nothing and reads on screen as "no data for this filter" rather than as a
 * contradiction, and a wrongly-built query returns the unfiltered cohort while
 * the bar still shows a selection.
 */
import { describe, expect, it } from 'vitest'
import { buildQuery, visibleOptions, type FilterOptions } from './filters'

const OPTS: FilterOptions = {
  states: ['Delta', 'Osun', 'Ekiti'],
  lgas: ['Aniocha North', 'Osogbo', 'Ado Ekiti'],
  lga_res: ['Aniocha North', 'Oshimili South', 'Edo LGA'],
  facilities: ['Delta Clinic', 'Osun Clinic', 'Ekiti Clinic'],
  age_bands: ['0-9', '10-19', '20+'],
  quarters: ['FY25Q4', 'FY26Q1', 'FY26Q2'],
  fys: ['FY25', 'FY26'],
  months: [{ m: '2026-08', n: 312 }, { m: '2026-07', n: 288 }],
  plans: ['Continue', 'Switch'],
  lga_state: { 'Aniocha North': 'Delta', Osogbo: 'Osun', 'Ado Ekiti': 'Ekiti' },
  facility_state: { 'Delta Clinic': 'Delta', 'Osun Clinic': 'Osun', 'Ekiti Clinic': 'Ekiti' },
}

describe('buildQuery', () => {
  it('repeats the key once per value, which is what FastAPI collects', () => {
    expect(buildQuery({ age_band: ['0-9', '10-19'] }))
      .toBe('?age_band=0-9&age_band=10-19')
  })

  it('is empty when nothing is selected, so the call is unfiltered', () => {
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ state: [] })).toBe('')
  })

  it('encodes a facility name with spaces and punctuation intact', () => {
    // A facility written "os State Hospital -  Asubiaro" (two spaces, as the
    // EMR stores it) once reached the API with one space, matched no rows, and
    // the page reported no data for a site carrying 199 episodes.
    const q = buildQuery({ facility: ['os State Hospital -  Asubiaro'] })
    expect(new URLSearchParams(q.slice(1)).get('facility'))
      .toBe('os State Hospital -  Asubiaro')
  })

  it('carries several different filters at once', () => {
    const p = new URLSearchParams(
      buildQuery({ state: ['Delta'], sex: ['Female'], age_band: ['0-9', '10-19'] }).slice(1))
    expect(p.getAll('age_band')).toEqual(['0-9', '10-19'])
    expect(p.get('state')).toBe('Delta')
  })
})

describe('visibleOptions', () => {
  it('offers everything when nothing is chosen', () => {
    const v = visibleOptions(OPTS, {})
    expect(v.lga).toHaveLength(3)
    expect(v.facility).toHaveLength(3)
    expect(v.quarter).toEqual(['FY25Q4', 'FY26Q1', 'FY26Q2'])
  })

  it('narrows quarters to the chosen fiscal year', () => {
    expect(visibleOptions(OPTS, { fy: ['FY26'] }).quarter)
      .toEqual(['FY26Q1', 'FY26Q2'])
  })

  it('offers the quarters of ALL chosen years, not none', () => {
    expect(visibleOptions(OPTS, { fy: ['FY25', 'FY26'] }).quarter)
      .toEqual(['FY25Q4', 'FY26Q1', 'FY26Q2'])
  })

  it('narrows service LGA and facility to the chosen state', () => {
    const v = visibleOptions(OPTS, { state: ['Delta'] })
    expect(v.lga).toEqual(['Aniocha North'])
    expect(v.facility).toEqual(['Delta Clinic'])
  })

  it('unions across several chosen states', () => {
    const v = visibleOptions(OPTS, { state: ['Delta', 'Ekiti'] })
    expect(v.facility).toEqual(['Delta Clinic', 'Ekiti Clinic'])
  })

  it('does NOT narrow residence LGA by the treating state', () => {
    // A client treated in Delta may live in Edo. Cascading residence off the
    // service state would hide exactly those cross-border cases, which are the
    // ones transmission and outreach targeting care about.
    expect(visibleOptions(OPTS, { state: ['Delta'] }).lga_res)
      .toEqual(OPTS.lga_res)
  })

  it('offers both sexes even though the API publishes no list', () => {
    expect(visibleOptions(OPTS, {}).sex).toEqual(['Female', 'Male'])
  })

  it('returns empty lists rather than throwing before options arrive', () => {
    const v = visibleOptions(null, { state: ['Delta'] })
    expect(v.state).toEqual([])
    expect(v.facility).toEqual([])
  })
})
