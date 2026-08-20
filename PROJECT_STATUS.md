# ECEWS TF Monitor — Project Status & Handoff

**Last updated:** 18 Jul 2026
**Owner:** Es (Data Analytics Lead, ECEWS / SPEED Program — PEPFAR/CDC, Nigeria)
**Purpose:** Online, multi-user web app for HIV ART **treatment-failure (TF)** and
**EAC** monitoring across Delta, Osun, Ekiti. Admin uploads bi-weekly line lists;
everyone else reads.

This document is the single source of truth for picking the project up in Claude
Code or Cowork **without re-deriving anything**. The companion clinical/analytical
spec is `EAC_Indicator_Definitions_and_Data_Analysis_Plan_v3_1.md`.

---

## 1. How to run (local dev)

```bash
# from the repo root (folder containing docker-compose.yml)
docker compose up --build          # app on http://localhost:8080 (compose maps 8080->8000)
# schema changed? wipe the DB volume first:
docker compose down -v && docker compose up --build
```

Upload path in the UI: **Admin → upload the Parquet zip**, set **line-list date =
2026-07-11**, cohort mode is **snapshot** (the only mode now).

**Backend tests (fast, no Docker):**
```bash
cd backend
export PYTHONPATH=$PWD DATABASE_URL="postgresql://ecews:ecews@localhost:5432/ecews"
export ADMIN_PASSWORD=test1234 JWT_SECRET=test
service postgresql start
python3 -m pytest tests/ -q          # 43 tests, all passing
```

**ECEWS workbook password:** `1572`.
**Convert Excel → Parquet zip** (95 MB → 16 MB, ~96× faster ingest):
```bash
docker run --rm -v ${PWD}:/work ecews_tf_monitor-api \
  python /work/backend/scripts/to_parquet.py "/work/<file>.xlsx"
```

---

## 2. What the app does (pages)

| Page | State | Notes |
|---|---|---|
| **Overview** | ✅ Built & polished | Headline tiles + **time-to-event strip**, narrative + cohort card, EAC & outcome donuts (M/F, commenced) + per-state bars, monthly re-suppression trend (F/M, provisional last month) + quarterly cascade table, facility league, zero-EAC, **Methodology & data sources** panel |
| **Cascade** | ✅ Built & polished | Blue-ramp bars with F/M stack, step 61 Post-EAC VL, "cohort lost" chart, outcome doughnut; click a step → worklist. Slices by filters |
| **Deep dive** | ✅ Rebuilt as **descriptive infographic** | Who/What/When/Where — donuts + bars + monthly trend + **residence LGA choropleth** (geoBoundaries, greyed context states); flags + facility league footer |
| Time metrics | ✅ Redesigned | **Box-and-whisker** per indicator (own scale, guideline target lines), re-suppression KM, **era-split cumulative-incidence** curve of time-to-first-unsuppression. Time-to-switch = **not computable** |
| Treatment plans | ✅ | §6 decision engine, one plan per episode |
| **DTC review** | ✅ Built | Switch gap (awaiting vs switched, by state/regimen/months/CD4), repeat-unsuppression univariate ORs, intervention worklist. No switch date → shows *who*, not *why*. **New (19 Aug 2026):** *post-EAC sample collected, result not yet returned* — the laboratory queue, 273 outstanding, median 15 days, 30 beyond 60; and *viral load trajectory* — every episode still ≥1,000 on the follow-up VL whether or not EAC completed (398 clients, 2–4 dated results each), classified as rebound after suppression / persistently high / erratic / sharp rise |
| **Advanced analytics** | ✅ | **AOR forest plot + univariate/adjusted table** (hand-rolled logistic, χ²/trend/Mann–Whitney), **binary CD4** rate card (integer + VISITEC LFA merged), risk-scoring model (AUC 0.716) + calibration, mortality |
| Data quality | ✅ | ~22 checks per upload |
| Guidelines | ✅ | 2024 National Guidelines narrative + mapping to dashboard measures |
| Methodology | ✅ | Cohort definition + known gaps |
| Admin | ✅ | Upload (snapshot only), immutable snapshots; DQ/ingest banners; **Users & access** (create/disable users, roles). Admin-only tab |

**Auth:** roles admin / analyst / viewer. Non-admins see every page except Admin. Seeded:
`admin@ecews.org` (`ADMIN_PASSWORD`) and `viewer@ecews.org` (`VIEWER_PASSWORD`, default
`viewer1234`) for testing. Admin creates more via the Users panel. **Feedback** is a floating
FAB (bottom-right) → `feedback` table; admins list it via `/api/feedback`.

Filters propagate everywhere: **FY (FY25/FY26)**, enrolment quarter, state, LGA,
facility, sex, age band, treatment plan. **LGA/facility dropdowns cascade off the
selected state; "Unknown" is hidden from state & age-band pickers** (still counts under
All). Row-level scoping is enforced (a Delta viewer cannot read Osun; asserted in e2e).

---

## 3. Locked analytical rules (do not silently change)

These are settled decisions, each verified against the real 11 July export. The
spec (`..._v3_1.md`) is authoritative; this is the short list.

1. **Unit of analysis = FAILURE EPISODE**, key `(S/N, index_VL_date, index_VL_value)`
   — never S/N alone. 308 clients have >1 episode; collapsing on S/N deletes them.
   **Rates use episodes as the denominator.**
2. **Cohort = quarterly open cohort** from the cumulative Total Unsuppressed register.
   `event` mode is **retired**.
3. **S/N is TEXT end-to-end** (needs 12+ dp to stay unique). Excel re-save breaks joins.
4. **No VL-validity window.** The 12-month rule was **expunged** (§2.10) — it deleted
   563 real FY25Q4 episodes and destroyed the register's history. Episode age is
   expressed by the FY quarter, never by exclusion.
5. **FY25Q4 floor:** everything received on/before 30 Sep 2025 → FY25Q4 (a floor, not
   a filter — nothing dropped). Kills phantom FY22/23/24 buckets.
6. **All viral loads come from the CLINICAL line lists, never the EAC sheet** (§2.12).
   Follow-up VL = the client's **next VL after the index result was received** (any
   later VL, from Total Unsuppressed or the Treatment list, whichever sampled first).
   - Neutralises success-censoring (May/June sheets read for session dates only).
   - Follow-up coverage rose 20.8% → **47.2%**.
   - A repeat failure resolves automatically as a failed switch on the earlier episode.
7. **Dates:** quarter/cohort by **date result received at facility**; follow-up by
   **sample collection date**, after the index result was received. **A sample and a
   result are separate facts** (19 Aug 2026): the sample date says a post-EAC sample
   exists; the result columns say a result exists. While a sample is at the lab the
   line list carries the new sample date but the index result, so counting the date
   as a result double-counted the index — 247 of 2,089. Sample coverage and
   re-suppression are unchanged; 241 episodes move to **awaiting result**, and
   switch-eligible falls 599 → 370. See Plan v3.1 §2.8.
8. **EAC dated before index = "not yet commenced"** — retained in cohort, counted as
   no-EAC (not dropped).
9. **Switching:** numerator = on **2nd/3rd line** in the Treatment list; denominator =
   **every episode whose follow-up VL is still ≥ 1,000** (#9b). **No switch date in the
   export → time-to-switch is not computable** (deferred).
10. `as_of` **anchors to the line-list date, not today** (the old rolling window is why
    the count drifted 2,845→2,832 across days).
11. **EAC completed vs Post-EAC VL (team review, 17 Jul 2026):** *Completed EAC* =
    sessions 1+2+3 recorded **plus ≥30 days** since session 3 → **46.6% (1,294)**.
    *Post-EAC VL* = sessions 1–3 **plus a VL sample on/after session 3**, no 30-day rule →
    **748** (cascade step 61). New gap flag `awaiting_vl` = completed but no post-EAC
    sample (**550**). Follow-up VL (any later VL) stays as-is for QC; converges as EMR EAC
    upload → 100%.
12. **Truncation is two cohorts:** `trunc_pre` = sample before session 1, cycle never
    started (**273**, negative lead time — its own worklist + high-severity DQ finding);
    `trunc_mid` = sampled after S1/S2 but before S3 (**416**). Neither invalidates the
    cascade (flag-only, per team).
13. **Nomenclature:** "repeat failure" → **repeat unsuppression episode**; "Awaiting
    switch" → **Awaiting DTC review** (display only; column/flag names unchanged).
14. **Switch gap (team review, 19 Jul):** a genuine switch needs the regimen line **at the
    index VL** (Total Unsuppressed `CurrentRegimenLine`) to have been 1st line. 524 still
    ≥1,000 splits three ways: **awaiting DTC review 484** (1st@index, still 1st),
    **prior switch 29** (already 2nd/3rd @index — cannot re-switch without resistance
    testing, need DTC drug-history + VL review), **genuinely switched 11** (1st@index → now
    2nd/3rd). Flags: `awaiting_switch`, `prior_switch`, `switched`. The old "37 switched"
    conflated the 29 prior-switch clients.
15. **CD4 is binary** (`cd4_band` <200 vs ≥200), merging the old quantitative assay with
    the new VISITEC LFA (`CD4_LFA_Result`); both valid. Coverage 33% → **47%**.
16. **Pregnancy** is reported on a **female denominator** (males set to N/A upstream).
17. **Time-to-VL** from `ART_Start_Date`: first-ever VL and first-**unsuppressed** VL.
    **Confounded by ART-start ERA** (routine VL scaled up with Test-and-Treat ~2017/18):
    ART→first-VL median 0.5 yr for ≥2018 starters vs 4.0 yr for ≤2017 (detection lag, not
    delay). Time-metrics has an **era-stratified cumulative-incidence curve** of time to
    first unsuppression (`/unsupp-curve`); never pool the two eras.

**Recurring bug to guard #1:** after a merge, `fillna(False)` on an object-dtype boolean
leaves object dtype and breaks the `~` operator. Always chain `.fillna(False).astype(bool)`.

**Recurring bug to guard #2 (found & fixed 16 Jul):** never hold a `Series` across
`sort_values().reset_index()` in `build_cohort` — pandas re-aligns on index labels and
silently pairs each row with a *different* row. A stale `s1` corrupted EAC lead time
(showed 2.8 mo; really **~4.9 mo / 169 d median**) and the truncation counts. Re-bind
from `df[...]` at point of use. Tell-tale: two indicators that are arithmetically
impossible together (146 episodes "negative lead" AND "completed").

---

## 4. Current headline figures (11 Jul 2026 export, all episodes)

**Title:** ECEWS-SPEED Treatment Failure Monitoring Dashboard.

**Repeat unsuppression (labels corrected 19 Jul):** **294 clients** unsuppressed >1 time,
accounting for **602 episodes** (294 first + 308 repeats). "308" = repeat *occurrences*, NOT
clients — the old headline mislabelled it. `repeats`=308, `repeat_clients`=294.

| Metric | Value |
|---|---|
| Episodes / clients / repeat-occurrences | **3,797 / 3,489 / 308** (294 repeat clients) |
| Quarters | FY25Q4 1,201 · FY26Q1 826 · FY26Q2 824 · FY26Q3 938 · FY26Q4 8 |
| Cohort | 67.0% female · 10.5% adolescents · 3.8% under-10 · median 77 mo on ART · 96.0% first-line |
| EAC commenced | 73.2% (2,779) — **1,018 never started** |
| EAC completed (S1+2+3 + 30d) | **46.6% (1,294)** |
| Post-EAC VL sample (step 61) | 748 · gap `awaiting_vl` = **550** |
| Follow-up VL done (QC) | **47.2%** (1,793) — 2,004 with no later VL |
| Re-suppressed | 70.8% (1,269) · F 71.4% / M 69.5% · Delta 68.6% / Ekiti 74.6% / Osun 74.5% |
| Time-to-event medians | to-EAC 25 d · **EAC lead 169 d** · to-resupp 169 d · months unsupp 7.7 |
| Still ≥ 1,000 (DTC-eligible) | **524** |
| Switched to 2nd/3rd line | 37 (7.1%) |
| **Awaiting DTC review** | **487** ← the number most likely to be challenged in review |

**Deep-dive inference (re-suppression, adjusted):** adolescents 10–19 AOR **0.53** (0.35–0.80),
Osun AOR **1.31** (1.02–1.70), longer on ART AOR **0.94/yr**. Baseline CD4 descriptive only
(33% coverage) but gradient sig: <200 60.3% → ≥500 76.5% (χ² p=0.007).

Zero-EAC facilities (volume ≥ 20, zero sessions on record — entry issue, follow up):
**Okwe 129 · Otu Jeremi 61 · Umutu 34 · Ijero 28 · Iwo 28.**

---

## 5. Repo layout

```
ecews/
├── PROJECT_STATUS.md                                   ← this file
├── EAC_Indicator_Definitions_and_Data_Analysis_Plan_v3_1.md   ← the spec
├── docker-compose.yml
├── README.md
└── backend/
    ├── Dockerfile, requirements.txt, .env.example
    ├── app/
    │   ├── indicators.py   ← core engine: build_cohort(), cascade(), time_metrics(),
    │   │                      kaplan_meier(), breakdown(), profile() [who/what/when/where],
    │   │                      deep_dive() [hand-rolled OR/AOR/χ²/trend/Mann–Whitney],
    │   │                      resuppression_model(), mortality(), _plan(), _lga_res_map()
    │   ├── main.py         ← FastAPI; /overview /cascade /summary /breakdown/{dim}
    │   │                      /plans /time-metrics /survival /risk /mortality /deep-dive
    │   │                      /profile /dq /clients /filters (cascading) /uploads /login
    │   ├── ingest.py       ← _read() (xlsx/parquet/zip), dq_checks(), ingest_workbook()
    │   ├── schema.sql      ← users, uploads (+sources), cohort (+socio-demo/CD4/residence
    │   │                      /post_eac_vl/trunc_pre/mid via ALTER…IF NOT EXISTS), dq_findings
    │   └── security.py     ← JWT + bcrypt (passlib dropped)
    ├── scripts/to_parquet.py
    ├── static/index.html            ← whole frontend (login, 10 pages, filters, charts)
    ├── static/nga_lga_3states.geojson      ← 71 LGA polygons (Delta/Osun/Ekiti)
    └── static/nga_context_states.geojson   ← 11 neighbouring states (grey map context)
```

**Backend changes need `docker compose up --build`** (no source mount — code is COPYed
into the image). **Indicator/ingest changes also need re-uploading** the workbook (cohort
columns are computed at ingest). New cohort columns use `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` in schema.sql, so no `down -v` is required. `.env` sets `ADMIN_PASSWORD=blindalley`.

**Frontend hardening:** the Overview renderer is wrapped in a guard that degrades any
render error to a single visible message in one card — a lost identifier can no longer
blank the page. (This replaced the recurring "X is not defined" full-page crash.)

---

## 5b. Open questions with the HI team

1. **`First_High_VL_Value` does not mean what its name says.** It has a hard floor
   at **50, not 1,000** — the lowest values present are 50.0, 50.1, 50.2 — so it is
   the first *detectable* viral load, not the first unsuppressed one. 62.5% of it is
   low-level viraemia, median 292, and that proportion is stable across every sheet
   that carries the column (62.5 / 62.5 / 63.9 / 62.5%), which makes it a definition
   rather than a defect.

   The trajectory colouring is unaffected — green below 1,000, red at or above,
   matching the suppression threshold used everywhere else and in PEPFAR reporting.
   What is affected is the **label**: the tooltip reads "First high VL", which a
   clinician will take to mean ≥1,000. **Left unchanged pending HI's definition**
   (19 Aug 2026) rather than renamed on our own inference.

   Also flagged: **68 rows have `First_High_VL` lower than `First_Ever_VL`**, which
   should not be possible under any reading of the two columns.

2. **Drug history, IIT history, appointment compliance and visit dates** are to come
   from a separate file that Es will supply. Deliberately not taken from the current
   line lists: `dateofFirstTldPickup` looked like a switch marker and is not — the
   whole first-line cohort was transitioned to TLD as programme policy, so it would
   have flagged a switch for almost everyone. Branch to be opened when the dataset
   arrives.

## 6. What's next (agreed direction)

1. **Repeat-unsuppression / DTC-review page** (agreed, not yet built). Shape:
   (a) cohort profile of the 308 repeat-unsuppression clients vs the rest;
   (b) associations for *repeat unsuppression* (outcome = unsuppressed again — a different
   denominator/model from re-suppression, which is why it can't share Deep dive);
   (c) the switch gap — the 524 still ≥1,000 / 487 awaiting DTC review, who & where;
   (d) exportable intervention worklist for the switch committee / DTC pathway.
   **Limitation to state on the page:** no switch date and no "reason not switched" field,
   so we show *who* is awaiting review and what correlates, not *why* they weren't switched.
2. **Interactive cards** (click-to-filter → global re-slice; click bar → worklist).
   Recommended, deferred to build alongside the v4 redesign so handlers aren't wired twice.
3. **Contiguous-state map context** ✅ done (grey neighbours behind the LGA choropleth).
4. Roll the new design language (sidebar layout from the approved v4 prototype) into the
   real frontend — deferred until per-page indicators are settled so we don't restyle twice.

**Open asks to the HI/EMR team (blocking better analysis):**
- **Switch date / "reason not switched"** — highest-value missing fields; unlock
  time-to-switch and true switch-gap root-cause.
- Improve **baseline CD4 coverage** (33%) — may be a strong switch-triage predictor.
- Fix **EAC session dates out of order** (S2/S3 before S1) and populate
  `Followup_VL_Sample_Collection_Date` consistently.
- Fix `EAC_Cycle_Number` (arrives as `1/0/1900`).
- 87 blank-S/N rows; state casing (Delta/DELTA/Osun/OSUN/EKITI).

---

## 7. Workflow preferences (Es)

- Plan → confirm → execute; explicit sign-off before major builds.
- Positives-first, then gaps, then actionable next steps.
- Granular LGA/facility breakdowns; eligibility-based denominators; 1-decimal rounding.
- **No hallucinated figures** — cross-check every number against the data.
- pptxgenjs native editable charts only (for slide deliverables; no image embeds).
