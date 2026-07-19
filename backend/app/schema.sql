-- ECEWS SPEED · Treatment Failure Monitor
-- S/N is TEXT everywhere. It needs 12+ decimal places to stay unique;
-- storing it as a float collides ~164 clients at 8dp and silently breaks joins.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer',   -- admin | analyst | viewer
  scope_state   TEXT,                              -- NULL = all states
  scope_facility TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every workbook upload becomes an immutable, dated snapshot.
CREATE TABLE IF NOT EXISTS uploads (
  id           SERIAL PRIMARY KEY,
  filename     TEXT NOT NULL,
  as_of        DATE NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|processing|ready|failed
  cohort_mode  TEXT NOT NULL DEFAULT 'event',
  n_cohort     INTEGER,
  n_treatment  INTEGER,
  n_eac        INTEGER,
  warnings     JSONB DEFAULT '[]',
  error        TEXT,
  is_current   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS uploads_one_current
  ON uploads(is_current) WHERE is_current;
-- Source line lists (sheet name carries its date) + kind/rows, for the
-- Overview "methodology & data sources" panel. Added post-v1; safe on existing DBs.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]';

-- One row per client per upload: the fully-derived cohort.
CREATE TABLE IF NOT EXISTS cohort (
  id              BIGSERIAL PRIMARY KEY,
  upload_id       INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sn              TEXT NOT NULL,
  state           TEXT, lga TEXT, facility TEXT,
  sex             TEXT, age NUMERIC, age_band TEXT, paed BOOLEAN,
  art_status      TEXT, regimen_line TEXT, regimen TEXT,
  days_on_art     NUMERIC, dsd TEXT,
  marital         TEXT, job TEXT, education TEXT, first_cd4 NUMERIC,

  idx_vl          NUMERIC, idx_date DATE, recv_date DATE, idx_samp DATE,
  vl_magnitude    TEXT, fy_quarter TEXT,

  eac_valid       BOOLEAN, eac_prior_cycle BOOLEAN,
  eac1 BOOLEAN, eac2 BOOLEAN, eac3 BOOLEAN,
  eac_extended BOOLEAN, eac_completed BOOLEAN, eac_truncated BOOLEAN,
  sessions        INTEGER, cycles INTEGER, dtc_review BOOLEAN,

  post_sample     BOOLEAN, post_result BOOLEAN,
  s1_date         DATE,
  fu_vl           NUMERIC, fu_date DATE,
  resuppressed BOOLEAN, undetectable BOOLEAN, llv BOOLEAN,
  still_unsuppressed BOOLEAN, switched BOOLEAN,

  time_to_eac       INTEGER,
  eac_lead_time     INTEGER,
  time_to_resupp    INTEGER,
  months_unsuppressed NUMERIC,

  treatment_plan  TEXT,
  episode         TEXT,
  repeat_failure  BOOLEAN,
  on_second_line  BOOLEAN,
  switch_eligible BOOLEAN,
  awaiting_switch BOOLEAN,
  fu_samp         DATE,
  enrol_quarter   TEXT,
  fy              TEXT,
  -- A client may have several failure episodes (fail -> EAC -> re-suppress ->
  -- fail again). The key is the episode, never the client.
  UNIQUE (upload_id, episode)
);
-- Socio-demographics + baseline CD4. Added post-v1; safe on existing DBs.
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS marital   TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS job       TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS education TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS first_cd4 NUMERIC;
-- Truncation split into its two distinct cohorts (sample before EAC1 vs mid-cycle).
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS eac_trunc_pre BOOLEAN;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS eac_trunc_mid BOOLEAN;
-- Post-EAC VL (sessions 1-3 + sample on/after S3) and extra descriptives.
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS post_eac_vl BOOLEAN;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS pregnancy TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS who_stage TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS bmi NUMERIC;
-- Residence (free-text in the EMR; matched to LGA boundaries at map time).
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS lga_res   TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS state_res TEXT;
-- Binary CD4 (integer + VISITEC LFA merged), age group, time-to-VL indicators.
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS cd4_band  TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS age_group TEXT;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS time_to_first_vl     INTEGER;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS time_to_first_unsupp INTEGER;
-- Prior-switch cohort (already 2nd/3rd line at index) + ART-start year (era).
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS prior_switch BOOLEAN;
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS art_year     INTEGER;

CREATE INDEX IF NOT EXISTS cohort_upload   ON cohort(upload_id);
CREATE INDEX IF NOT EXISTS cohort_geo      ON cohort(upload_id, state, lga, facility);
CREATE INDEX IF NOT EXISTS cohort_plan     ON cohort(upload_id, treatment_plan);
CREATE INDEX IF NOT EXISTS cohort_quarter  ON cohort(upload_id, fy_quarter);
CREATE INDEX IF NOT EXISTS cohort_enrol    ON cohort(upload_id, enrol_quarter);
CREATE INDEX IF NOT EXISTS cohort_fy       ON cohort(upload_id, fy);

-- User feedback captured from the in-app button.
CREATE TABLE IF NOT EXISTS feedback (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  email      TEXT,
  page       TEXT,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-sheet data-quality findings, surfaced in the dashboard.
CREATE TABLE IF NOT EXISTS dq_findings (
  id         SERIAL PRIMARY KEY,
  upload_id  INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  sheet      TEXT,
  check_name TEXT NOT NULL,
  severity   TEXT NOT NULL,            -- critical|high|medium|low|clear
  n_records  INTEGER NOT NULL DEFAULT 0,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS dq_upload ON dq_findings(upload_id);
