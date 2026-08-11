# Response: Automated De-identification and Scalable Dashboard Data Architecture

**To:** ECEWS development team
**From:** Data Analytics Lead, ECEWS/SPEED Programme
**Date:** 11 August 2026
**Re:** Technical Handoff Note — proposed de-identification and data architecture
**Application reviewed at commit:** `f5e33fc`

---

## 1. Position

The handoff note is endorsed in principle. Its central requirement —
**personally identifying information confined to a secure transformation
boundary, with the dashboard receiving only pseudonymised data** — is the right
design, and the three-layer separation in §9 is the right shape for it.

This response is not a counter-proposal. It exists to do three things before
design work begins:

1. record what the application **already implements**, so effort is not spent
   rebuilding it;
2. raise **one design question that would break the dashboard's primary
   function** if answered the way the note currently implies;
3. set out **three points where we would recommend differently**, each stated
   as a decision for the team rather than a conclusion.

Every factual claim below was verified against the running system; the
verification is in the appendix.

---

## 2. Already implemented — please do not rebuild

Several requirements in the note describe the system as it stands today.

| Requirement (note §) | Status | Where |
|---|---|---|
| PII never reaches the dashboard (§1) | **In place.** Identifiers are removed upstream; the application only ever receives the pseudonymous `S/N` | Dossier §0.3 |
| Dashboard has no access to the raw dump (§2, §10) | **In place.** The workbook is parsed in memory and discarded; only derived rows are stored | Dossier §3.8 |
| Existing individuals keep a consistent key across refreshes (§1, §3) | **In place and verified.** All 3,489 clients retained the same key between the 18-July and 24-July snapshots | Appendix A |
| Analytical datastore, multi-user, access-controlled (§8 Option C) | **In place.** PostgreSQL 16, role-based access, row-level scoping by state/facility | Dossier §2, §4 |
| Automated validation before publication (§6) | **In place.** 18 data-quality checks plus a per-sheet expected-column audit run on every load | Dossier §3.6 |
| Fail-safe on bad input (§6) | **In place.** A load that cannot be parsed is marked failed and the previous snapshot remains live | Dossier §3.7 |
| Processing / audit log (§6, §4) | **In place.** Append-only audit trail covering authentication, patient-data access, exports and uploads | Dossier §6.1 |

**The genuine gap is §5 — the de-identification itself.** That step is currently
manual and happens outside the system, upstream of anything the application
controls. Automating it is the work worth doing, and the note is right to make
it the centre of the proposal.

---

## 3. Blocking design question: re-identification for action

This is the most important item in this response.

§10 states that the dashboard environment "must never require access to the
identity vault". As a security boundary that is correct. But it collides with
what the dashboard is actually for.

The dashboard's principal output is **actionable worklists**: in the current
snapshot, 495 episodes awaiting Drug Therapeutic Committee review, 754 that have
never commenced EAC, and 176 requiring client tracking. These exist so that a
facility can act on **specific named patients**. A worklist that cannot be
resolved back to a patient is a reporting artefact, not an operational tool.

Today this works because `S/N` originates in the source system, so a facility
can resolve it in its own EMR. If the pipeline replaces it with a key known
only to the vault, that resolution path closes and the worklists stop being
usable at the point of care.

**This must be answered before Phase 1 begins:**

1. **Who** is permitted to re-identify — facility staff, state teams,
   programme staff?
2. **By what route** — resolution inside the EMR, a vault query, a controlled
   export?
3. **Under what authorisation**, and **is each resolution logged**?

This is a governance decision rather than a technical one, and it is currently
absent from the note. Depending on the answer, the persistent key may need to
remain resolvable *within the facility's own environment* even though the
dashboard itself cannot resolve it — which is a materially different design
from a fully opaque key.

---

## 4. Points where we would recommend differently

### 4.1 Incremental upsert would remove snapshot immutability (§7)

Every load is currently kept as an **immutable, dated snapshot**. This is not
incidental: it is how the question *"what did the dashboard show on 24 July?"*
is answered, it is stated as an auditability guarantee in the technical
dossier, and it has already earned its place operationally.

A recent worked example: completed EAC appeared to fall from 1,438 to 1,428
across a refresh, which reads as clients un-completing a counselling cycle —
something that cannot happen. Comparing the retained snapshots showed the cause
was an as-of date two days earlier, shortening the 30-day maturation window.
On a like-for-like date, completions had risen by three. That diagnosis was
only possible because both snapshots still existed.

Incremental upsert into a mutable table gives this up.

**Recommendation:** adopt incremental processing for the **staging** layer,
where it reduces work, and retain **immutable published snapshots** as the
dashboard's source. The two are compatible: reconcile incrementally, publish a
dated snapshot.

### 4.2 The growth diagnosis should be re-tested before it is engineered around (§7)

§7 assumes the Parquet grows because history accumulates and is therefore
reprocessed repeatedly. Inspection suggests a simpler cause.

The workbook now carries **three treatment line lists** (11 July, 18 July,
24 July) and **five EAC lists**. The application reads only the newest
treatment list — the earlier two are never analysed. Each is roughly 180,000
rows.

Removing superseded treatment sheets from the export is a one-line instruction
to the HI team and recovers most of the volume, with none of the complexity of
change-detection, watermarking and upsert reconciliation.

**Recommendation:** confirm the composition of the growth before building an
incremental pipeline to manage it. If the growth is superseded sheets, fix it
at source first and re-measure.

### 4.3 DuckDB (§8 Option B) would be a regression for this application

DuckDB is well suited to single-analyst analytical work. This application has
concurrent users, role-based row scoping, brute-force lockout, an append-only
audit trail and per-request usage recording — all multi-writer, transactional
concerns that PostgreSQL handles and DuckDB is not designed for.

**Recommendation:** Option C, which is already in place. Parquet remains
appropriate as the **exchange and archival** format, exactly as §8 suggests.
Option B need not be evaluated further.

---

## 5. Gaps to close

Beyond §3 above, the following are not addressed in the note and will need
positions before implementation.

- **Migration cost of a new key.** The current `S/N` is a random decimal rather
  than a cryptographic token, and is known to collide at eight decimal places —
  approximately 164 clients — which is why it is handled as text throughout.
  §3's recommendation is therefore a genuine improvement. But changing the key
  invalidates every worklist and CSV already distributed, and any local tracking
  built on it. A cutover plan is required, most likely carrying both keys
  through one transition cycle.
- **Testing the pipeline.** De-identification logic cannot be exercised in a
  test environment that holds no PII. A synthetic identifier fixture will be
  needed, or the pipeline tested inside the secure boundary.
- **Vault retention and deletion.** How long mappings persist, and what happens
  on a deletion request.
- **Identity resolution at source.** Behaviour when the source system merges,
  splits or duplicates a patient record — the persistent key must follow a
  defensible rule.
- **Quasi-identifier policy versus analytical need (§5).** Coarsening exact
  dates and ages would disable several current indicators: time to EAC
  commencement, EAC lead time, time to re-suppression and the survival curves
  all require exact dates. The note's own three-layer model resolves this —
  keep exact values in Layer 2, coarsen only in the Layer 3 aggregates — and we
  would ask that this be made explicit, since a blanket coarsening rule applied
  at ingest would silently remove functionality.

---

## 6. Proposed Phase 0

We recommend two questions are answered before Phase 1 is scoped, because the
answers determine whether this is a hardening exercise or a rebuild.

**Q1. Where does `S/N` originate, and does an identity mapping already exist?**

The key is already persistent across refreshes and is not sequential. If it is
generated and retained in the HI team's environment, then an identity vault
exists in substance and the work is to formalise, secure and document it —
significantly less than building one.

**Q2. Who may re-identify, and by what route?** (§3 above.)

With those settled, Phase 1 as described in the note is endorsed: automate the
cleaning, key reconciliation and PII removal, validate, and emit a
de-identified dataset to the existing dashboard. That sequencing gives
immediate reduction in manual effort without application redevelopment, and we
support it.

---

## Appendix A — Verification

Claims in §2 were checked against the running application at commit `f5e33fc`:

- **Key persistence.** Intersecting the client keys of the 18-July snapshot
  with the 24-July snapshot returns 3,489 — the full client count. No client
  was assigned a new key across the refresh.
- **Key format.** Values are random decimals in `[0,1)` carried as text, e.g.
  `0.00024886211364749666`. Twelve or more decimal places are required for
  uniqueness; at eight places approximately 164 clients collide.
- **Key exposure.** `S/N` is included in the client worklist and CSV export
  columns, which is what currently makes the worklists actionable (§3).
- **Snapshot retention.** Seven loads are retained and independently
  queryable, which is what permitted the completed-EAC diagnosis in §4.1.
- **Raw data handling.** The uploaded workbook is parsed in memory and is not
  written to durable storage. Uploads above 1 MB spool briefly to
  container-local temporary storage for the duration of the request — noted in
  dossier §3.8 and relevant to the §10 boundary.

## Appendix B — Reference documents

- `TECHNICAL_DOSSIER.md` — architecture, data flow, security controls
- `EAC_Indicator_Definitions_and_Data_Analysis_Plan_v3_1.md` — indicator
  definitions, including those that depend on exact dates (§5 above)
- `design/FRONTEND_MODULE_SPLIT.md` — unrelated to this note; front-end
  maintainability proposal
