# ECEWS SPEED · Treatment Failure Monitor

A web application for tracking clients from a documented unsuppressed viral load
through EAC, to a switch to an optimised regimen or a return to suppression.

An admin uploads the bi-weekly workbook **once**. Everyone else signs in and reads
the dashboard. No one else touches a spreadsheet.

Implements `EAC_Indicator_Definitions_and_Data_Analysis_Plan v2.1` (§3–§7).

---

## Run it

```bash
cp .env.example .env        # then edit the secrets
docker compose up --build
```

Open http://localhost:8000 and sign in with the seeded admin
(`admin@ecews.org` / whatever you set as `ADMIN_PASSWORD`). **Change it immediately.**

Go to **Admin → Upload**, drop the workbook, and the dashboard populates.

### Use Parquet, not Excel

The workbook is a bad wire format: 95 MB, two minutes to parse, and Excel will
silently mangle `S/N` if anyone opens and saves it. Convert once per cycle on the
machine that produces the export:

```bash
python backend/scripts/to_parquet.py July_11_Line_List.xlsx
# -> July_11_Line_List.parquet.zip
```

Upload that instead. Same numbers, verified identical:

| | Excel | Parquet |
|---|---|---|
| Size | 95.4 MB | **16.6 MB** (5.7x smaller) |
| Parse + build | 124.5 s | **1.3 s** (96x faster) |
| Cohort | 2,706 | 2,706 |
| `S/N` integrity | at risk on any re-save | **carried as text in the schema** |

The Admin tab accepts `.xlsx`, `.parquet`, or a `.zip` of parquets, so you can move
over whenever you like.

### Tests

```bash
cd backend && pytest tests/ -q          # 31 tests: decision tree, temporal rules,
                                        # censoring guard, key precision
```

---

## Architecture

```
Browser ──► FastAPI ──► PostgreSQL
   │           │
   │           └── pandas: cohort build, cascade, KM, decision tree
   └── Chart.js, no build step, single HTML file
```

- **Upload → immutable snapshot.** Every upload is stored whole and one is flagged
  `is_current`. You can always answer "what did the dashboard say on 11 July?"
- **Row-level scoping.** A viewer with `scope_state='Delta'` cannot read Osun, even
  by hand-editing the query string. Verified in the test suite.
- **Bi-weekly now, daily later.** `POST /api/uploads` is an ordinary HTTP endpoint —
  point a cron job or an EMR export at it and the refresh becomes automatic. Nothing
  in the design assumes a human is doing the upload.

### Endpoints

| | |
|---|---|
| `POST /api/login` | returns a JWT |
| `POST /api/uploads` | admin only; parses the workbook, builds the cohort |
| `GET /api/summary` | headline numbers |
| `GET /api/cascade` | spec §4, steps 1–10 |
| `GET /api/time-metrics` | spec §5 |
| `GET /api/survival` | Kaplan–Meier |
| `GET /api/plans` | spec §6 decision tree |
| `GET /api/breakdown/{dim}` | state, lga, facility, sex, age_band, regimen_line, vl_magnitude, fy_quarter |
| `GET /api/clients?flag=…` | worklists (spec §3) |
| `GET /api/export?flag=…` | the same, as CSV |
| `GET /api/dq` | data-quality findings |

All read endpoints accept `state`, `lga`, `facility`, `sex`, `age_band`, `quarter`, `plan`.

---

## Three things the data forced on the design

### 1. The index cohort is anchored on the event, not on current status

Spec §2.1 defines the index cohort as the `Total Unsuppressed` snapshot, which is
built on **current** VL ≥ 1,000. But a post-EAC VL *becomes* the current VL:

- re-suppressed → current VL < 1,000 → **the client leaves the cohort**
- still failing → that VL *is* the index → **no later result exists**

Of the 2,169 clients in the snapshot, 266 have a follow-up VL and **all 266 are
dated before their index VL**. Cascade steps 7–10 compute to exactly zero. The
outcome half of the cascade is empty by construction.

So the cohort is anchored on the **index event** — the triggering high VL, which the
EAC list preserves even after a client re-suppresses — unioned with the unsuppressed
clients who have no EAC record at all.

Upload with `cohort_mode=snapshot` to reproduce the literal spec behaviour and watch
the cascade collapse. Default is `event`.

### 2. Two EAC exports are success-censored

In `EAC Line List_23rd May` and `EAC Line List_20th June`, the maximum value in
`Followup_VL_Value` is **49.9**. Every recorded follow-up VL is a suppressed one;
unsuppressed results were never written to the column.

Re-suppression computes to **100%** in both. Trend them against a complete export and
the dashboard invents a viral-rebound epidemic that never happened.

Ingestion detects this automatically (a sheet with 200+ results and none ≥ 50) and
**excludes it from outcomes**, loudly. EAC *initiation* is unaffected and stays
comparable across all lists.

**Fix at source:** ask the HI team to re-export May and June with unsuppressed
follow-up VLs included, or retire those lists.

### 3. `S/N` is text, forever

The values need **12+ decimal places** to stay unique. Round to 8dp and 164 clients
collide; 6dp and 15,427 do. Anything that reads them as a number — Excel included —
silently breaks every join.

They are read, stored, and compared as `TEXT` end to end. Keep them as text in every
export.

---

## Known data defects (raised, not yet fixed at source)

| Defect | Effect | Ask |
|---|---|---|
| Success-censored May/June follow-up VL | Outcomes unusable in those lists | Re-export or retire |
| No switch date anywhere in the export | Step 10 cannot be attributed to the current EAC cycle; reported against the whole cohort instead | Add `Switch_Date` |
| Post-EAC result with no sample date | Step 8 reported against EAC1, not samples | Populate `Followup_VL_Sample_Collection_Date` |
| State casing: `Delta / DELTA / Osun / OSUN / EKITI` | Normalised on ingest | One-line SQL fix, still open since February |
| `EAC_Cycle_Number` = `1/0/1900` | Excel serial corruption | Cast as integer on export |
| Blank `S/N` | Rows unlinkable, dropped | Populate or drop at source |

---

## Deployment

Any Docker host. `docker compose up` is the whole thing.

- **Managed:** Render / Railway / Fly.io — point at this repo, add a Postgres add-on,
  set the env vars.
- **Self-hosted:** any VPS with Docker. Put Caddy or nginx in front for TLS.

Set, at minimum:

```
JWT_SECRET=<long random string>
ADMIN_PASSWORD=<strong>
DB_PASSWORD=<strong>
CORS_ORIGINS=https://your-domain
```

### Before it goes live

- [ ] Rotate `JWT_SECRET` and the admin password
- [ ] TLS termination
- [ ] Create real users with `scope_state` set for state teams
- [ ] Nightly `pg_dump`
- [ ] Point the bi-weekly export at `POST /api/uploads` to automate the refresh
