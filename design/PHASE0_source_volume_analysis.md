# Phase 0 deliverable 4 — source volume analysis

**Question posed:** before implementing watermark/change-detection logic,
quantify what is actually driving dataset growth — superseded treatment line
lists, duplicate historical sheets, repeated records, or genuinely new data.

**Answer:** superseded sheets. Not accumulated history, and not repeated
records. **48% of the current archive can be removed at source with no
analytical loss**, which removes the case for incremental ingestion as a
volume measure.

Measured on `TF_Dashboard_Dataset` (24 July 2026): 320 MB workbook, 42.5 MB
Parquet archive.

---

## 1. What the archive contains

| Sheet | Rows | Compressed | Share | Read by the app? |
|---|---:|---:|---:|---|
| Treatment Line List_24th July | 180,153 | 12.0 MB | 28.1% | **Yes** |
| Treatment Line List_11th July | 179,970 | 9.7 MB | 22.7% | No — superseded |
| Treatment Line List_18th July | 180,036 | 8.5 MB | 20.0% | No — superseded |
| EAC Line List_10th July | 52,358 | 2.7 MB | 6.4% | Yes |
| EAC Line List_4th July | 50,367 | 2.6 MB | 6.2% | Yes |
| EAC Line List_24th July | 49,965 | 2.6 MB | 6.1% | Yes |
| EAC Line List_23rd May | 42,478 | 2.1 MB | 4.9% | Yes, but see §3 |
| EAC Line List_20th June | 42,095 | 2.1 MB | 4.9% | Yes, but see §3 |
| Total Unsuppressed | 3,816 | 0.3 MB | 0.7% | Yes |

## 2. Treatment line lists — 18.2 MB, 43% of the archive, never read

The treatment line list is a **current-state snapshot**: ART status, regimen,
last pickup, current viral load. Only the newest is meaningful, and the
application reads only the newest. The 11 July and 18 July sheets are carried
in every export and never opened.

**Recommendation: stop exporting superseded treatment line lists.** One sheet
per cycle. This is an instruction to the HI team, not an engineering change,
and it recovers 43% of the archive immediately.

## 3. EAC line lists — mostly earning their place, one is not

The EAC list is **not cumulative**: clients drop out once their cycle closes.
The application therefore unions all EAC sheets, newest first, so a client's
session history is not lost when they leave a later export. That union is
worth **293 cohort clients** who appear in no recent sheet.

Contribution of each sheet, in union order:

| Sheet | Clients | New at this point | Of which in the cohort |
|---|---:|---:|---:|
| 24th July | 49,918 | 49,918 | 3,089 |
| 10th July | 52,246 | 3,836 | 283 |
| 4th July | 50,280 | 779 | 7 |
| 20th June | 42,065 | 41 | **3** |
| 23rd May | 42,138 | 7 | **0** |

**The 23 May sheet contributes nothing** — every client it carries is already
present in a later sheet. It can be dropped: 2.1 MB for zero analytical loss.

The 20 June sheet contributes 3 cohort clients for 2.1 MB. Retaining or
dropping it is a judgement call; we would keep it for now and review once a
retirement rule exists (§5).

## 4. Duplicate and repeated records

Checked and **not a material contributor**. Exact duplicate rows within a sheet
are collapsed at ingest — 19 rows in the current dataset. The apparent
duplication *between* EAC sheets is the union working as designed, not waste:
the same client legitimately appears in several sheets, and only the newest row
is used.

## 5. Recommendation

**Immediate, at source — no code change:**

| Action | Recovered |
|---|---|
| Drop the two superseded treatment line lists | 18.2 MB |
| Drop the 23 May EAC list | 2.1 MB |
| **Total** | **20.3 MB — 48% of the archive** |

Analytical loss: none.

**Then establish a retirement rule for EAC sheets.** The pattern above is
clear: a sheet stops contributing once every client it holds has appeared in a
later export. A simple rule — *retain EAC lists back to the point where an
older sheet adds no cohort clients, review each cycle* — would keep the export
from growing indefinitely without risking the 293 clients the union currently
recovers.

**On incremental ingestion.** With superseded sheets removed, the export is
roughly 22 MB and the load completes in a few minutes. We would not recommend
building change-detection and upsert reconciliation to manage that. If volume
becomes a problem later, the first question should again be *what is in the
file*, not *how do we process more of it faster*.

---

## Appendix — method

Figures were read directly from the Parquet archive: per-member compressed
size, row and column counts, and set arithmetic on the client key (`S/N`) to
establish each EAC sheet's unique contribution, intersected with the Total
Unsuppressed register to isolate the effect on the analysed cohort. "Read by
the app" reflects the sheet-selection logic in `ingest.py`: newest treatment
list by sheet order, all EAC lists unioned newest-first, Total Unsuppressed as
the cohort register.
