# EAC / Treatment Failure Dashboard: Indicator Definitions, Data Analysis & Aggregation Plan

**Purpose**: Complete, self-contained specification for the Enhanced Adherence Counseling (EAC) treatment-failure monitoring dashboard and analysis pipeline.

**Version**: 3.0
**Date**: 14 July 2026
**Supersedes**: v2.1 (13 July 2026)
**Source**: 2024 Nigerian National Guidelines for HIV Prevention, Treatment and Care + operational cascade logic + findings from the v1.0 implementation against the 11 July 2026 export.
**Scope**: FY-aligned (Oct 1 – Sep 30), unsuppressed clients (VL ≥ 1,000 copies/ml only), multi-source line lists.
**Unique Identifier**: `S/N` — a de-identified pseudonym. No PatientID or hospital number is used or stored.

---

## 0. What changed in v3.1, and why

v2.1 was written before the pipeline was built. Building it surfaced defects that could not be seen from the spec alone. Every change below is a consequence of running the logic against real data, and each one is listed with the evidence that forced it.

| # | Change | Why |
|---|--------|-----|
| **0.1** | **The unit of analysis is a FAILURE EPISODE, not a client.** | 308 clients in the July export have more than one index VL. De-duplicating on `S/N` deletes 294 genuine second failures — the highest-priority switch candidates in the programme. |
| **0.2** | **The index cohort is an open cohort with quarterly enrolment.** Supersedes the single `Total_Unsuppressed` snapshot. | A single snapshot dated the same day as the line list makes cascade steps 7–10 **structurally empty**. Proven: of 2,169 snapshot clients, 266 had a follow-up VL and **all 266 were dated before their index VL**. Zero after. |
| **0.3** | **`S/N` is TEXT, everywhere, forever.** | Values need **12+ decimal places** to stay unique. At 8dp, 164 clients collide; at 6dp, 15,427. Any tool that reads it as a number — Excel included — silently breaks every join. |
| **0.4** | **Follow-up VL categories are recomputed from the raw numeric value.** The EMR status string is never trusted. | The May and June EAC exports are **success-censored**: the maximum `Followup_VL_Value` in both is **49.9**. Every recorded follow-up VL is a suppressed one. Re-suppression computes to 100%. |
| **0.5** | **Cascade denominators for steps 8 and 10 corrected.** | As specified, both exceeded 100% against real data. See §4.1. |
| **0.6** | **Duplicate index rows are classified, not dropped.** | The rule (§2.6) separates an erroneous duplicate row from a genuine new failure. |
| **0.7** | **Column matching is case-insensitive; schema drift is tolerated.** | The quarterly index sheet ships `CurrentViralLoad`; the treatment line list ships `currentViralLoad`. Case-sensitive matching yields an all-null column and a cohort of **zero**, silently. |
| **0.8** | **Parquet is the wire format.** | 5.7× smaller, **96× faster** to parse, and it carries dtypes — which is what structurally protects `S/N`. |
| **0.10** | **A current VL counts as a follow-up only if its VALUE differs from the index.** A later sample date alone is not enough. | The index VL comes from the unsuppressed register and the current VL from the treatment line list. Where no repeat test has been done, the treatment list still reports the index result as the client's current VL — and the two sources date it differently, so a sample-date test passes and the same result is counted twice. On the 15 Aug snapshot **247 of 2,089 follow-up VLs were the index result restated**. See §2.8. |
| **0.9** | **Architecture is a server-side web app.** Analysts do not upload workbooks. | An admin uploads once per cycle; everyone else reads. See §8. |

---

## 1. Clinical Context & Guidelines Summary
*(Dashboard Information / Methodology tab. Clinical content is unchanged from v2.1 and must not be altered.)*

### 1.1 Introduction and Rationale
Enhanced Adherence Counseling (EAC) is a critical component of the HIV continuum of care. It ensures that diagnosis is followed by retention and sustained virological suppression, thereby reducing morbidity, mortality, and transmission risk. EAC proactively addresses adherence challenges to **prevent treatment failure, HIV drug resistance, and opportunistic infections**. It is a **mandatory intervention** before any clinical decision to switch ART regimens.

### 1.2 Definition
**Enhanced Adherence Counseling (EAC)** is an intensive, individualized adherence support intervention for **non-stable recipients of care (RoC)** who have adherence issues, poor treatment response, or clinical/virological signs of treatment failure.

### 1.3 Core Recommendations

**Target Population** (any of the following):
- **Unsuppressed Viral Load**: VL ≥ 1,000 copies/ml
- **Suppressed but Detectable (Low-Level Viremia / LLV)**: VL 50–999 copies/ml
- **Clinical Failure**: New or recurrent WHO Stage 3 or 4 conditions after ≥6 months on effective ART

**Process – Four-Step Approach**:
1. **Structured Assessment**: Formal evaluation of current ART adherence.
2. **Barrier Exploration (ABCDE Framework)**:
   - **A** – Adherence problems (missed doses, timing, etc.)
   - **B** – Bugs (intercurrent / opportunistic infections)
   - **C** – Correct ART Dosage (especially weight-based dosing in children)
   - **D** – Drug–Drug Interactions
   - **E** – Resistance (potential HIV drug resistance)
3. Collaborative identification of solutions.
4. Joint development of an individualized adherence intervention plan.

**Duration & Frequency**: Minimum of **3 structured sessions over a 3-month period**.

**Service Modality**: For clients with LLV (50–999 copies/ml), sessions may be **in-person or virtual** (telephone, etc.).

### 1.4 Expected Outcomes and Monitoring
- **Repeat VL**: Only after **3 consecutive months of documented good adherence** (>95% doses taken) following EAC completion.
- **Multidisciplinary Switch Committee**: Required if repeat VL remains ≥1,000 copies/ml (doctor + nurse + adherence counselor).
- **Persistent LLV Management**:
  - VL 200–999 copies/ml → High risk of failure → recommend switch to second-line.
  - VL 50–199 copies/ml → High likelihood of re-suppression → continue frequent monitoring.
- **Documentation**: Use standard PMM tools – **EAC Form** and **EAC Monitoring Register**.

### 1.5 Key References (2024 National Guidelines)
| Section | Topic | Page(s) |
|---------|-------|---------|
| 3.6.2 | Monitoring Children & Adolescents (EAC Triggers) | 35 |
| 3.7.2 | Management of HIV Treatment Failure (EAC Steps) | 37 |
| 3.7.4 | Management of Suppressed but Detectable VL (ABCDE) | 41 |
| 3.8.1 | Criteria for Switch to Third-line ART | 41 |
| 3.10.4 | Aim & Focus of EAC for Special Populations | 63–64 |
| 8.1.3 | Differentiated ART Service Delivery (Virtual EAC) | 187 |
| 9.2.1 | Patient Management & Monitoring Tools (EAC Forms) | 227 |

---

## 2. Data Sources, Schema Assumptions & Matching Rules

### 2.1 The unit of analysis is a FAILURE EPISODE

**This is the single most important definition in the document. Get it wrong and the dashboard deletes its most important clients.**

A client may fail, complete EAC, re-suppress, and **fail again**. That is two index events, two EAC responses, two trips through the cascade. It is one *client* but **two episodes**.

> **Primary key = `(S/N, Index_VL_Result_Date, Index_VL_Value)`** — never `S/N` alone.

Evidence from the 11 July 2026 export:

| | count |
|---|---|
| Rows in `Total_Unsuppressed` | 3,816 |
| Distinct clients | 3,489 |
| **Distinct failure episodes** | **3,797** ← the correct denominator |
| Clients with a repeat failure | 308 |

Observed repeat-failure trajectories:

```
6,620 (May 25)   →  1,880,000 (Feb 26)
2,274 (Jun 25)   →      6,423 (Jan 26)
75,831 (Jul 25)  →      2,080 (Jun 26)
```

De-duplicating on `S/N` would erase 294 of these. They are precisely the clients a switch committee must see.

**Denominator convention**: rates are computed **per episode** ("73.2% of failures received EAC"). Distinct client counts are reported alongside so no headline double-counts a person. If a programme figure must be person-based, use the `clients` field, not `n`.

### 2.2 The index cohort is an OPEN COHORT with quarterly enrolment

**Supersedes the single-snapshot definition in v2.1 §2.1.**

#### The defect this fixes

A snapshot of "clients whose **current** VL ≥ 1,000", drawn on the same date as the treatment line list, cannot support the outcome half of the cascade. A post-EAC VL **becomes** the current VL, so:

- **re-suppressed** → current VL < 1,000 → **the client leaves the cohort**
- **still failing** → that VL **is** the index → **no later result exists**

Empirically confirmed against the original `Total_Unsuppressed` (2,169 clients): 266 had a follow-up VL row, and **all 266 were dated before their index VL. Zero after.** Cascade steps 7–10 computed to exactly zero. The outcome arm was empty *by construction* — not a bug, but an inevitable consequence of defining a cohort by a field that is overwritten by the very outcome being measured.

#### The construction

Build the index list **quarterly**, freezing each index event at the quarter in which it occurred:

- **Q1 cohort** = all active clients unsuppressed as at 31 Dec
- **each subsequent quarter** appends *newly* unsuppressed clients
- an episode's index VL is never overwritten by a later result

Because the index is frozen, a post-EAC VL can now land *after* it. Running `cohort_mode=snapshot` against the quarterly list yields **949 post-EAC results** where the single snapshot yielded **0**.

Each episode carries an **enrolment quarter**, which is the correct stratifier for the cascade — see §4.2.

### 2.3 Primary Data Sources

| Source | Description | Sheet name | Primary use |
|---|---|---|---|
| Treatment Line List | Full active client list: latest VL, regimen, ART status | `Treatment Line List_<date>` | Demographics, regimen, ART status |
| **Quarterly Unsuppressed List** | **Open cohort. All clients with VL ≥ 1,000, enrolled by quarter, index event frozen** | `Total Unsuppressed` | **Index cohort (denominator #1)** |
| EAC Line List | Clients who have started EAC (Sessions 1–6) | `EAC Line List_<date>` | EAC sessions, follow-up VL |

**Key Principle (unchanged, and now enforced in code)**: never use the EAC Line List alone for the denominator of Total Unsuppressed. It is *cumulative* — it contains everyone who ever had a high VL, including those who re-suppressed long ago. Using it as the denominator understates EAC coverage dramatically (it produced a spurious "72% never commenced EAC" during development; the true figure against the correct cohort is 73–82%).

### 2.4 `S/N` is TEXT. Always.

`S/N` is a stable pseudonym and joins cleanly — verified at 100% match to the treatment line list, with sex and facility agreeing 100% and DOB 99.97%.

But it is a raw float requiring **12+ decimal places** to remain unique:

| Rounded to | Colliding clients |
|---|---|
| 10 dp | 1 |
| 8 dp | 164 |
| 6 dp | 15,427 |
| 4 dp | 169,969 |

> **Store, transmit, and compare `S/N` as TEXT end to end.** Anyone who opens the workbook in Excel and saves it can silently destroy every join, with no error and no warning. This is the principal argument for Parquet (§2.8).

### 2.5 Matching & Temporal Logic Rules

1. **Client matching**: exact match on `S/N` as a **string**. Log and report all unmatched records.
2. **EAC Cycle Validity (critical)**: an EAC cycle links to an index VL **only if `Session_1_Date >= Index_VL_Result_Date`**. If earlier, it belongs to a previous cycle → **exclude** from this cascade. *(191 episodes affected in July.)*
3. **Multiple unsuppressed results**: each is its **own episode** (§2.1). Do not collapse to the most recent.
4. **Multiple / overlapping EAC cycles**: analyse the cycle validly linked to *that episode's* index VL. Flag any client with **>2 EAC cycles still unsuppressed** for Drug Therapeutic Committee review.
5. **Missing dates**: treat any missing `Session_n_Date` as "not yet done". Never impute.
6. **Date formats**: convert to date objects. Handle Excel serial corruption (`1/0/1900`, `1900-01-01`) as null, not as a date.
7. **Negative time intervals**: a valid EAC1 can never have a negative Time to EAC Commencement. Any negative value is a data-quality error → **exclude and flag**. Never store as a negative.
8. **Column names are matched case-insensitively.** The quarterly sheet ships `CurrentViralLoad`; the line list ships `currentViralLoad`. Exact matching produces an all-null column and a cohort of zero — a silent, total failure.
9. **Schema drift is expected.** Field names change between exports (`Current_High_VL_*` → `First_High_VL_*` + `EAC_Triggering_High_VL_*`). Resolve each field from an ordered list of candidate names; never assume one is present.

### 2.6 Duplicate index rows: classification rule

A repeated `S/N` in the index list is **not automatically an error**. Classify it:

> **A VL result is identified by `Result_Date` + `Result_Value`.**
> - **Both identical** → the same lab result written twice → **collapse to one row**
> - **Either differs** → a **new index event** → **keep both as separate episodes**

**Sample-collection metadata must NOT be used for this test.** Several rows share an identical result date and value while differing on `LastDateOfSampleCollection` and `DateResultReceivedFacility`. Those are the same result with inconsistent sample metadata — a separate export bug — not a second failure. Using sample dates as the discriminator over-counts new events by roughly 20×.

Result on the July export:

| Classification | Clients |
|---|---|
| **Genuine new index event** | **294** |
| Same VL result, row duplicated | 17 (8 exact; 9 with differing sample dates) |

### 2.7 Follow-up VL categories are RECOMPUTED. The EMR status string is not trusted.

In `EAC Line List_23rd May` and `EAC Line List_20th June`, the **maximum value in `Followup_VL_Value` is 49.9**. Every recorded follow-up VL is a suppressed one; unsuppressed and LLV results were never written to the column.

Consequences if used naively:
- re-suppression computes to **100%** in both lists
- trending them against a complete export produces a **fabricated viral-rebound epidemic** (3,217 spurious "Suppressed → LLV" and 1,582 "Suppressed → Unsuppressed" transitions)

**Rules:**
1. Derive `Undetectable / LLV / Unsuppressed` **only** from the raw numeric VL value.
2. **Automatically detect success-censoring**: an EAC sheet with ≥200 recorded follow-up VLs and **no value ≥ 50** is censored. Exclude it from all outcome analysis and say so, loudly, on the dashboard.
3. **EAC *initiation* remains comparable across all lists** — `Session_1_Date` is populated correctly everywhere. Only outcome fields are affected.

**Action for the HI team**: re-export May and June with unsuppressed follow-up VLs included, or retire those lists.

### 2.8 A later sample date does not prove a new test. The VALUE must differ.

An episode's follow-up VL is the client's next viral load after the index result
reached the facility. It can come from the client's next failure episode in the
register, or from the current VL on the treatment line list.

The second source needed a guard it did not have. Where a client has had **no
repeat test since**, the treatment line list still reports the index result as
their current VL. The two sources date that result differently — the register on
when it was received at the facility, the treatment list on last sample
collection — so a test of "was it sampled after the index was received?" passes,
and the same result is counted a second time as a follow-up.

Measured on the 15 August 2026 snapshot, rebuilding the same file three ways:

| Rule | post_result | re-suppressed | still unsuppressed | follow-up = index |
|---|---:|---:|---:|---:|
| Sample date only *(previous)* | 2,089 | 1,455 | 634 | **247** |
| **Value must differ** *(adopted)* | 1,843 | 1,455 | 388 | **1** |
| Value + sample date + result date | 1,774 | 1,391 | 383 | 1 |

**The value is the test.** It removes 246 of the 247 duplicates on its own.
Adding the two date conditions removes 5 more and costs **64 genuine
re-suppressions** — clients who did have a repeat test with a different result,
but whose sample or report date matched the index or was missing. The same
inconsistency that makes the dates unreliable evidence *for* a new test makes
them unreliable evidence against one; the value is not ambiguous.

Consequences of the previous rule, now corrected:

- **post-EAC VL coverage was overstated** — 315 episodes counted a follow-up
  that had not happened
- **the switch backlog was overstated** — switch-eligible falls from 599 to 366,
  because 238 of those clients had no repeat VL on which to base a switch
- **a decision looked evidenced when nothing had been repeated**

A client with one viral load is not a client whose viral load is unchanged. The
first needs a repeat test; the second needs a regimen decision. The dashboard
now separates them.

### 2.8 Wire format: Parquet, not Excel

| | Excel (.xlsx) | **Parquet** |
|---|---|---|
| Size | 95.4 MB | **16.6 MB** |
| Parse + cohort build | 124.5 s | **1.3 s** |
| Cascade output | *identical* | *identical* |
| `S/N` integrity | at risk on any re-save | **carried as TEXT in the schema** |

Speed is the lesser reason. **Parquet carries dtypes**, so `S/N` cannot be silently coerced to a float. Excel is precisely the tool that breaks it.

Convert once per cycle on the machine producing the export (`scripts/to_parquet.py`). The ingestion endpoint accepts `.xlsx`, `.parquet`, or a `.zip` of Parquet sheets, so migration can be gradual.

### 2.9 Analysis Window

- **Fiscal Year**: 1 Oct – 30 Sep. Q1 Oct–Dec · Q2 Jan–Mar · Q3 Apr–Jun · Q4 Jul–Sep.
- **No VL-validity window. No episode is ever excluded for being old.** See §2.10.
- **First bucket is FY25Q4**: every result received on or before **30 Sep 2025** is
  assigned to FY25Q4. This is a floor, not a filter — nothing is dropped, and the
  phantom FY22/FY23/FY24 buckets (1–2 episodes each) disappear.
- All cascade indicators must support **enrolment-quarter** and FY filters.
- **Refresh cadence**: bi-weekly. The upload endpoint is an ordinary HTTP POST, so a cron job or EMR export can drive it — daily refresh needs no redesign.

**Scope**: only the ≥ 1,000 copies/ml cohort. LLV (50–999) is out of scope as an *entry* criterion, but is reported as an *outcome* category.

### 2.10 There is NO 12-month VL-validity rule — and there never should be

A build in July 2026 briefly dropped episodes whose sample was collected more than
12 months before the line-list date. **That rule was wrong and has been expunged.**
It is recorded here only so that nobody re-invents it.

Why it was wrong:

- **Total Unsuppressed is a cumulative register, not a current-state snapshot.**
  Newly-unsuppressed clients are appended; earlier ones are never removed. That is
  the point of the sheet.
- An old unsuppressed result is **not stale data**. It is a real failure episode that
  should have entered EAC in FY25Q4 or FY26Q1, worked through the cascade, and
  produced a follow-up VL. Discarding it discards precisely the client we most need
  to follow.
- The register exists to answer questions that **require** history: did this client
  re-suppress? did the suppression hold? did they fail again in a later quarter?
  A validity window makes those questions unanswerable.
- Empirically, the rule deleted **563 episodes, 563 of which belonged in FY25Q4.**

**Rule: episode age is expressed by the fiscal quarter, never by exclusion.**

### 2.11 Which date does which job

| Question | Date used | Source |
|---|---|---|
| Which quarter does this episode belong to? | **Date result received at facility** | Total Unsuppressed |
| Could the facility have acted on it? | same — a client cannot start EAC on a result the facility has not received | Total Unsuppressed |
| Is this VL a follow-up to that episode? | **Sample collection date**, must be **after the index result was received** | Treatment line list |
| Has EAC been completed? | Sessions 1, 2 & 3 all recorded AND ≥30 days elapsed since `Session_3_Date` (team review, 17 Jul 2026) | EAC line list |
| Is there a post-EAC VL? | Sessions 1–3 recorded AND a VL **sample collected on/after** `Session_3_Date`, irrespective of the 30-day rule | EAC line list + clinical line lists |

**All viral loads — index and follow-up — come from the clinical line lists. None
are read from the EAC sheet.** See §2.12.

### 2.12 Follow-up viral loads come from the clinical line lists

The EAC sheet's `Followup_VL_*` columns are **no longer read**. Every VL is taken
from Total Unsuppressed (failures) or the Treatment line list (current VL).

An episode's **follow-up VL is the client's next viral load after the index result
reached the facility.** It can come from one of two places, whichever was sampled
first:

1. the client's **next failure episode** in Total Unsuppressed (by definition ≥ 1,000
   — they failed again); or
2. the **current VL on the Treatment line list** (any value).

Three consequences, all desirable:

- **Success-censoring is neutralised.** The May and June EAC sheets record only
  suppressed follow-up VLs (max 49.9). That column is now never read, so those sheets
  are usable for session dates and cannot bias outcomes. No sheet needs excluding.
- **Follow-up VL coverage rises from 20.8% to 47.2%** — the EAC sheet was simply
  missing most results that the clinical lists already held.
- **A repeat failure resolves itself.** For a client who fails twice, the second
  episode's index VL *is* the first episode's follow-up result. Episode 1 therefore
  reads as still-unsuppressed and switch-eligible **automatically** — no special case.
  The register already knew the first switch never happened.

A follow-up VL is **any** later VL. It is *not* conditional on EAC having occurred, so
it is reported against the **full episode cohort (#1)**, never against the EAC
denominator. (Reporting it against #2 produced rates above 100% and was a defect.)

---

## 3. Pre-Cascade Analysis (Deep Dive Page)

1. **Socio-demographic profile** — by sex, age band, facility, LGA/state, ART duration, regimen class, pregnancy status, WHO stage. Cross-tab by VL magnitude (1,000–9,999 / 10,000–99,999 / ≥100,000).

2. **Historical trends** — new unsuppressed results by quarter; % unsuppressed among all VL tests; facility heat map.

3. **Deep-dive flags** — each is a downloadable facility worklist:

| Flag | Definition |
|---|---|
| `no_eac` | VL ≥ 1,000, no valid EAC record |
| `eac_incomplete` | Session 1 done, course not completed |
| `awaiting_vl` | EAC completed, no post-EAC VL result |
| `awaiting_switch` | Post-EAC VL ≥ 1,000, not switched |
| `long_unsuppressed` | Unsuppressed > 6 months |
| `dtc_review` | > 2 EAC cycles, still unsuppressed |
| `truncated` | Post-EAC sample drawn before the session series finished |
| `prior_cycle` | EAC session predates the index VL (excluded per §2.5 rule 2) |
| **`repeat_failure`** | **A second (or later) failure episode — highest switch priority** |

---

## 4. Cascade Analysis – Core Indicators

*Computed on the index cohort of **failure episodes** (VL ≥ 1,000).*

| # | Indicator | Numerator logic | Denominator |
|---|---|---|---|
| 1 | **Total Unsuppressed** | Count of distinct **episodes** | – |
| 2 | **EAC Commenced (EAC1)** | `Session_1_Date >= Index_VL_Result_Date` AND not null | #1 |
| 3 | EAC Session 2 | `Session_2_Date` not null (among EAC1) | #2 |
| 4 | EAC Session 3 | `Session_3_Date` not null (among EAC1) | #2 |
| 5 | Extended EAC | Any session ≥ 4 | #2 |
| 6 | EAC Completed | Sessions 1, 2 & 3 all not null AND ≥30 days elapsed since `Session_3_Date` | #2 |
| 6b | Post-EAC VL Sample | Sessions 1–3 not null AND a VL sample collected on/after `Session_3_Date` (no 30-day rule) | #4 |
| 7 | Follow-up VL Sample | Sample collected **after the index result was received** | **#1** |
| 8 | **Follow-up VL Result** | Next VL after the index result was received, from the **clinical line lists** (§2.12) | **#1** *(not #2 — a follow-up VL does not require EAC)* |
| 9a | Re-suppressed | Follow-up VL < 1,000 | #8 |
| — | · Undetectable | Follow-up VL < 50 | #8 |
| — | · LLV | 50 ≤ Follow-up VL < 1,000 | #8 |
| 9b | Still Unsuppressed | Follow-up VL ≥ 1,000 | #8 |
| 10 | **Switched to 2nd/3rd line** | `currentRegimenLine` contains 2nd/3rd line (Treatment line list) | **#9b** — *every episode still ≥ 1,000* |
| — | · **Awaiting switch** | #9b AND still on first line | #9b |

### 4.0 EAC dated before the index VL = "not yet commenced"

An EAC session dated **before** the index VL belongs to an earlier cycle. It is not
this episode's counselling.

**Those episodes are NOT excluded from the cohort.** They are counted as
**"no EAC on record yet"** — because that is exactly what they are. (191 episodes in
the July export.) An earlier build dropped them from the cascade; that was wrong,
because it shrank the denominator and flattered the EAC coverage rate.

### 4.1 Two denominator corrections

Both denominators specified in v2.1 exceeded 100% against real data.

**Step 8 — was `#7` (samples), now `#2` (EAC1).**
Some post-EAC results carry no `Followup_VL_Sample_Collection_Date`, so results (696) exceeded samples (691) and the ratio read 100.7%. Reporting against EAC1 — always a true superset — is honest. *The missing sample dates are logged as a data-quality finding rather than hidden by a denominator.*

**Step 10 — was `#9b` (still unsuppressed), now `#1` (cohort).**
`Switched_To_Second_Line` reflects only the client's **current regimen line**. There is **no switch date anywhere in the export**, so it also counts switches made in earlier cycles. Against 47 currently-failing clients it yielded **162%**.

> **Blocking data gap**: without a `Switch_Date` / `Regimen_Change_Date`, step 10 cannot be attributed to the current EAC cycle, and **Time to Switch (§5) is not computable at all.** This is the highest-value single field the HI team could add.

### 4.2 Report the cascade BY ENROLMENT QUARTER

A pooled cascade understates performance, because recently-enrolled episodes have not had time to complete it. Stratifying by enrolment quarter makes the follow-up clock visible:

| Quarter | n | EAC | post-EAC VL | re-suppressed |
|---|---|---|---|---|
| FY25Q2 | 164 | 76.2% | 98 | 96.9% |
| FY25Q3 | 339 | 75.8% | 163 | 93.9% |
| FY25Q4 | 694 | 70.3% | 285 | 93.7% |
| FY26Q1 | 817 | 85.7% | 288 | 92.7% |
| FY26Q2 | 872 | 80.5% | **81** | 91.4% |
| FY26Q3 | 838 | **53.8%** | **0** | — |

FY26Q3's 53.8% EAC coverage is **not a collapse** — it is a cohort only weeks old. Read down the post-EAC column and the maturation curve is obvious. **Any headline figure must state its enrolment quarter, or it will be misread.**

### 4.3 Assumptions & flags

- If `Session_3_Date` exists, assume Sessions 1–2 occurred even if their dates are missing. **Flag for data-quality review.**
- Second-line status is taken from `Current_Regimen_Line` on the treatment line list.
- **Truncation flag**: sample collected after Session 1 but before Session 2, or after Session 2 but before Session 3 → "EAC cycle truncated" → deep-dive flag.

---

## 5. Time-Dependent Indicators

| Indicator | Formula | Unit | Notes |
|---|---|---|---|
| Time to EAC Commencement | `Session_1_Date – Index_VL_Result_Date` | Days | Valid EAC1 only. **No negatives by design** — exclude and flag. |
| EAC Lead Time | `Post_EAC_Sample_Date – Session_1_Date` | Days | |
| Months Unsuppressed | `(As_Of_Date – Index_VL_Result_Date) / 30.44` | Months | |
| Time to Re-suppression | `Post_EAC_Result_Date – Session_1_Date` | Days | **Kaplan–Meier**; censor the non-re-suppressed. |
| ~~Time to Switch~~ | ~~`Switch_Date – Post_EAC_Unsuppressed_Result_Date`~~ | — | **NOT COMPUTABLE.** No switch date exists in the export (§4.1). |

**Censoring is mandatory.** Clients who have not yet re-suppressed are **right-censored, not dropped**. Dropping them flatters the programme.

**Visualisation**: boxplots/violins for distributions; Kaplan–Meier for time to re-suppression; heat map of median Time to EAC by facility/LGA.

---

## 6. Treatment Plan Decision Logic

Assign **exactly one** priority-ordered plan per **episode**:

```
IF ART_Status IN ("IIT","Stopped","LTFU","Lost to Follow-up","Dead","Discontinued Care") THEN
    "E. Track Client"
ELSE IF Post_EAC_VL >= 1000 AND EAC_Completed THEN
    "F. Refer to Switch Committee, Do CD4, Update Register & EMR"
ELSE IF Post_EAC_VL < 1000 THEN
    "D. Repeat VL in 6 months, continue adherence counselling"
ELSE IF Index_VL within last 6 months AND No EAC record THEN
    "A. Commence EAC, update register and EMR"
ELSE IF Index_VL within last 6 months AND EAC started but not completed THEN
    "B. Complete EAC, update register and EMR"
ELSE IF Index_VL older than 6 months THEN
    "C. Take Post-EAC Sample, update register and EMR"
ELSE
    "Review Manually"
```

**Output**: count and % by plan; downloadable line list (`S/N` + plan + supporting flags); facility-level action lists.

> **Open item**: "Review Manually" catches ~14% of episodes — mostly stale index VLs with no post-EAC result. The tree is a clinical artefact and should be extended by the programme team, not by the implementer.

---

## 7. Advanced Analytics

### 7.1 Predictive model: probability of re-suppression
- **Target**: binary — re-suppressed (post-EAC VL < 1,000) vs not.
- **Features**: age, sex, index VL magnitude, time to EAC commencement, sessions completed, missed pickups, ART duration, regimen line, facility.
- **Approach**: logistic regression (interpretable, and the odds ratios are what programme staff act on) or gradient-boosted trees. Report **AUC, a calibration plot, and feature importance** — a model without calibration should not drive clinical worklists.
- **Output**: risk score for every episode still in the cascade; a high-risk list for intensified support.
- **Caveat**: fit only on episodes with a post-EAC result. That is a *selected* subset (only ~31% get a repeat VL), so the model is conditioned on being tested. State this on the dashboard.

### 7.2 Mortality analysis
- Crude mortality rate; time to death from index VL and from EAC1.
- Kaplan–Meier stratified by EAC completion and VL magnitude; Cox model if powered.

**Stack**: Python (pandas + lifelines / scikit-learn).

---

## 8. Architecture & Dashboard Structure

### 8.1 Architecture (implemented)

```
Browser ──► FastAPI ──► PostgreSQL
   │           │
   │           └── pandas: cohort build, cascade, KM, decision tree
   └── Chart.js, single self-contained HTML file, no build step
```

- **Analysts do not upload workbooks.** An **admin** uploads once per cycle; everyone else signs in and reads. Roles: `admin` (upload, manage users) · `analyst` (read all, export) · `viewer` (read, **row-scoped to their state/facility**).
- **Row-level scoping is enforced server-side.** A Delta-scoped viewer requesting `?state=Osun` receives Delta. Asserted in the test suite.
- **Every upload is an immutable snapshot**, one flagged `is_current`. You can always answer "what did the dashboard show on 11 July?"
- **Deployment**: Docker Compose. Any Docker host, or a managed platform with a Postgres add-on.

### 8.2 Pages

1. **Overview** — headline cascade numbers, filters (enrolment quarter, state, LGA, facility, age, sex)
2. **Cascade** — the 10 indicators drawn as loss bars; drill-down tables
3. **Deep Dive & Epidemiology** — demographics, trends, actionable flags
4. **Time Metrics** — distributions + Kaplan–Meier
5. **Treatment Plans & Actions** — decision engine + facility worklists
6. **Advanced Analytics** — risk model, mortality
7. **Data Quality** — every check in §9, run on each upload
8. **Methodology** — clinical context, data dictionary, assumptions, version history

**Implementation notes**
- Every percentage must expose its numerator and denominator on hover.
- The Data Quality tab is **not optional** — it is how the HI team learns what to fix.
- Design for bi-weekly refresh; the endpoint already supports daily.

---

## 9. Data Quality Checks (run automatically on every upload)

| Check | Severity | July 2026 count |
|---|---|---|
| Success-censored follow-up VL column | **Critical** | 2 sheets (May, June) |
| Missing client key (`S/N`) | **Critical** | 87 rows |
| Switch recorded without a switch date | **High** | all |
| EAC session dated before the index VL | High | 191 |
| Implausible viral load (> 10,000,000) | High | 5 |
| > 2 EAC cycles, still unsuppressed (DTC) | High | — |
| **Client has a repeat failure episode** | Medium | **308** |
| EAC completed, no post-EAC VL | Medium | 514+ |
| EAC cycle truncated | Medium | 40 |
| Post-EAC result with no sample date | Medium | — |
| Inconsistent state casing | Medium | 5 variants |
| Excel date corruption in `EAC_Cycle_Number` | Medium | 22 |
| Duplicate index rows (same VL result) | Medium | 17 |

### 9.1 Standing asks of the HI / EMR team

| # | Ask | Impact if unfixed |
|---|---|---|
| 1 | **Add `Switch_Date` / `Regimen_Change_Date`** | Time to Switch is not computable; step 10 cannot be attributed to a cycle |
| 2 | **Re-export May & June EAC lists with unsuppressed follow-up VLs**, or retire them | Outcome trending is impossible across those periods |
| 3 | **Export `S/N` as TEXT** | Joins break silently on any Excel re-save |
| 4 | Fix state casing (`Delta/DELTA/Osun/OSUN/EKITI`) | Normalised on ingest; open since February |
| 5 | Cast `EAC_Cycle_Number` as integer (currently `1/0/1900`) | Values unusable |
| 6 | Populate `Followup_VL_Sample_Collection_Date` | Step 7 understated |
| 7 | Populate or drop blank-`S/N` rows | 87 records unlinkable |

---

## 10. Implementation Checklist

- [x] Ingest `.xlsx` / `.parquet` / `.zip`, resolving columns case-insensitively and tolerating schema drift
- [x] Read, store and compare `S/N` as **TEXT**
- [x] Build the index cohort as **failure episodes**, keyed on `(S/N, Index_VL_Date, Index_VL_Value)`
- [x] Classify duplicate index rows per §2.6 (result date + value)
- [x] Detect and quarantine success-censored EAC sheets
- [x] Recompute VL categories from raw numeric values
- [x] Apply the strict temporal validity rule (§2.5 rule 2)
- [x] Compute all cascade flags as booleans
- [x] Compute time-to-event variables; exclude and flag negatives; **censor properly**
- [x] Apply the Treatment Plan decision tree
- [x] Kaplan–Meier for time to re-suppression
- [x] Downloadable line lists per cascade step and per plan
- [x] Data Quality report
- [x] Role-based access with **row-level scoping**
- [x] **Unit tests**: decision tree, temporal matching, negative-value exclusion, censoring guard, key precision, episode keying, schema drift *(37 tests)*
- [ ] Predictive model wired to the API *(built client-side; move server-side)*
- [ ] Mortality / Cox analysis
- [ ] Automate refresh: point the export at `POST /api/uploads`

---

## 11. Resolved Decisions

1. **Unit of analysis**: the **failure episode**, not the client. Rates are per episode; client counts reported alongside.
2. **Index cohort**: **quarterly open cohort**. The single same-day snapshot is retired — it makes the outcome cascade structurally empty.
3. **Duplicates**: classified by **result date + result value**. Sample metadata is *not* a discriminator.
4. **`S/N`**: TEXT, always, everywhere.
5. **VL categories**: recomputed from raw values. The EMR status string is not trusted across exports.
6. **Switching**: numerator = `currentRegimenLine` contains **2nd or 3rd line** on the
   Treatment line list. Denominator = **every episode whose follow-up VL is still
   ≥ 1,000** (#9b). The export carries **no switch date**, so *time-to-switch remains
   uncomputable* — it is deferred, not estimated. Attribution of a switch to a
   specific episode also awaits that date.
6b. **Repeat failures are failed switches.** A client with a later failure episode has,
   by construction, a follow-up VL ≥ 1,000 on the earlier episode. That episode is
   therefore switch-eligible and — if still on first line — **awaiting switch**, whether
   or not EAC was ever recorded. This is not an inference layered on top of the data;
   it falls directly out of §2.12.
7. **LLV**: out of scope as an entry criterion; reported as an outcome category.
8. **Statistical stack**: Python (pandas + lifelines).
9. **Refresh**: bi-weekly, architecture ready for daily.
10. **Wire format**: Parquet preferred; Excel still accepted.

---

## 12. Version History

| Version | Date | Changes |
|---|---|---|
| 2.1 | 13 Jul 2026 | De-identification rule (`S/N`), negative-time rule, clinical decisions integrated |
| 3.0 | 14 Jul 2026 | **Unit of analysis → failure episode. Index cohort → quarterly open cohort (fixes structurally-empty outcome arm). `S/N` as TEXT. Success-censoring detection. Duplicate classification rule. Denominator corrections (steps 8, 10). Case-insensitive columns / schema drift. Parquet wire format. Server-side architecture with row-level scoping. Cascade stratified by enrolment quarter. Data-quality checks and standing asks of the HI team.** |

| **3.1** | **14 Jul 2026** | **12-month VL-validity rule EXPUNGED (§2.10) — it deleted 563 real FY25Q4 episodes and destroyed the register's history. FY25Q4 floor introduced (a floor, not a filter). All viral loads now read from the clinical line lists, never the EAC sheet (§2.12) — success-censoring neutralised, follow-up coverage 20.8% → 47.2%. Follow-up VL = next VL after the index result was received; reported against #1, not #2. Repeat failure resolves automatically as a failed switch on the earlier episode. Switching denominator = every episode still ≥ 1,000; numerator = 2nd/3rd line. EAC dated before index = "not yet commenced", retained in the cohort (§4.0). `event` cohort mode retired; `as_of` anchored to the line-list date.** |

---

**End of Specification (v3.1)**

Every change in this version is traceable to evidence from a real export. Where the data contradicted the specification, the data won and the reasoning is recorded — so that a future reader can tell a deliberate decision from an accident.
