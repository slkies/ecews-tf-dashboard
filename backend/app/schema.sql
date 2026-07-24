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

-- Sign-in handle. Added after launch: an email tells an administrator reading
-- the usage panel far less than a name does. Email is still required, but it is
-- now contact and identity rather than the way in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- Backfill from the email local part for accounts that predate usernames, with
-- a numeric suffix where two addresses share one, so the unique index below can
-- actually be created. This runs once; afterwards the WHERE clause matches
-- nothing. It only de-duplicates within the backfilled set, which is correct
-- because on the one run that does any work every row is in that set.
WITH derived AS (
  SELECT id,
         split_part(email, '@', 1) AS base,
         row_number() OVER (PARTITION BY lower(split_part(email, '@', 1))
                            ORDER BY id) AS rn
  FROM users
  WHERE username IS NULL OR btrim(username) = ''
)
UPDATE users u
   SET username = CASE WHEN d.rn = 1 THEN d.base ELSE d.base || d.rn END
  FROM derived d
 WHERE u.id = d.id;

-- Case-insensitive: "Es" and "es" must not be two different people.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

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
-- When the client left care (Outcomes_Date, or pickup+refill+28d for LTFU).
ALTER TABLE cohort ADD COLUMN IF NOT EXISTS exit_date DATE;

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

-- Security audit trail. Records authentication and every access to, or change
-- of, patient-level data: who, what, when, from where.
--
-- email is denormalised on purpose. The audit trail has to stay readable after
-- an account is deleted, so user_id nulls out but the address written at the
-- time survives. Rows are append-only; nothing in the application updates or
-- deletes them.
CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email    TEXT,
  action   TEXT NOT NULL,   -- login.success | login.failure | login.blocked
                            -- | export.csv | clients.view
                            -- | upload.create | upload.delete | upload.prune
                            -- | user.create  | user.toggle
  detail   TEXT,
  ip       TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts    ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_user  ON audit_log(user_id, ts DESC);
-- Supports the lockout query, which counts recent failures for one address.
CREATE INDEX IF NOT EXISTS audit_login ON audit_log(email, action, ts DESC);

-- Lightweight usage tracking: one row per authenticated API request.
--
-- Deliberately SEPARATE from audit_log. That table is a security record and
-- must stay readable and un-noisy; this one is high-volume operational data
-- answering "is the dashboard being used, by whom, and for what". It cascades
-- on user delete for the same reason - usage statistics about a removed account
-- are not evidence, whereas their audit trail is.
CREATE TABLE IF NOT EXISTS usage_log (
  id      BIGSERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  path    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage_log(user_id, ts);
CREATE INDEX IF NOT EXISTS usage_ts      ON usage_log(ts DESC);

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
