/** The /api/overview payload. Only the parts the page renders are declared. */

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

export interface VolumeRow {
  facility: string
  state?: string
  n: number
  eac1?: number
  completed?: number
  completed_pct?: number | null
  eac1_pct?: number | null
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
  by_volume: VolumeRow[]
  filename?: string
  sources?: unknown
}
