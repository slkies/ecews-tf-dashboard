/** The /api/overview and /api/time-metrics payloads, as the page consumes them. */

export interface ProgressRow {
  quarter: string
  n: number
  eac1: number
  completed: number
  retested: number
  resuppressed: number
  eac1_pct: number | null
  completed_pct: number | null
  retest_pct: number | null
  resupp_pct: number | null
}

export interface StateRow {
  state: string
  n: number
  eac1: number
  completed: number
  post: number
  resupp: number
  eac1_pct: number | null
  resupp_pct: number | null
}

export interface FacilityRow {
  facility: string | null
  n: number
  eac1: number
  completed: number
  eac1_pct: number | null
  completed_pct: number | null
}

export interface Demo {
  female: number; female_pct: number | null
  male: number; male_pct: number | null
  paeds: number; paeds_pct: number | null
  adolescents: number; adolescents_pct: number | null
  median_months_art: number | null
  first_line: number; first_line_pct: number | null
  second_line: number; second_line_pct: number | null
  median_time_to_eac: number | null
  median_lead_months: number | null
}

export interface ResuppCell { n: number; resupp: number; pct: number | null }

export interface Source {
  name: string
  kind: 'total' | 'treatment' | 'eac' | (string & {})
  rows: number
  censored?: boolean
}

export interface Overview {
  n: number
  clients: number
  repeats: number
  repeat_clients: number
  as_of: string | null
  warnings?: string[] | null

  eac1: number; eac1_pct: number | null
  never_eac: number
  completed: number; completed_pct: number | null
  post_eac_vl: number
  retested: number; retest_pct: number | null
  awaiting_retest: number
  resuppressed: number; resupp_pct: number | null
  still_unsuppressed: number
  switch_eligible: number
  switched: number
  prior_switch: number
  switch_pct: number | null
  awaiting_switch: number
  repeat_failure: number

  progress: ProgressRow[]
  weekly: { months: string[]; female: number[]; male: number[] }
  resupp_trend: {
    months: string[]
    female: (number | null)[]; male: (number | null)[]
    female_n: number[]; male_n: number[]
  }
  demo: Demo
  disagg: {
    sex: Record<string, ResuppCell>
    state: Record<string, ResuppCell>
  }
  by_state: StateRow[]
  by_volume: FacilityRow[]
  /** Top facilities by EAC completion, among those with at least min_vol episodes. */
  best: FacilityRow[]
  min_vol: number
  /** Facilities carrying real volume with no EAC session on record. */
  zero_eac: { facility: string | null; n: number }[]
  sources?: Source[] | null
  filename?: string
}

/** One time-to-event distribution from /api/time-metrics. */
export interface Dist {
  n: number
  median: number
  q1: number
  q3: number
  mean: number
  min: number
  max: number
  wlo: number
  whi: number
}

export interface TimeMetrics {
  time_to_eac?: Dist | null
  eac_lead_time?: Dist | null
  time_to_resuppression?: Dist | null
  months_unsuppressed?: Dist | null
  time_to_first_vl?: Dist | null
  time_to_first_unsupp?: Dist | null
}
