# Decisions and incidents

The other documents say what this system *is*. This one says **why it is that
way, and what went wrong on the way there** — the reasoning that would otherwise
live only in commit messages and in one person's head.

Two sections:

- **[Standing rules](#standing-rules)** — decisions that still bind. Changing one
  of these is a decision, not a refactor.
- **[Incident log](#incident-log)** — what broke, how it was found, what stops it
  recurring. Dated, oldest last.

Companion documents: [`README.md`](../README.md) (what it is),
[`PROJECT_STATUS.md`](../PROJECT_STATUS.md) (where it stands),
[`TECHNICAL_DOSSIER.md`](../TECHNICAL_DOSSIER.md) (how it is built),
[`RUNBOOK_pipeline.md`](RUNBOOK_pipeline.md) (how to run it).

---

# Standing rules

## 1. No identifier is ever printed, logged, or pasted

**The rule.** Diagnostics report *counts, lengths and character shapes* — never a
PEPID, never a DATIM+PEPID key, never a name. A value becomes `AAA99999999`
before it reaches a screen. Anything shared with Anthropic, a ticket, or a chat
comes from the de-identified parquet and the logs, and nothing else.

**Why.** Real PEPIDs were printed to a terminal and committed to git (see
[Incident 8](#8-real-pepids-in-the-terminal-and-in-git-history)). Once an
identifier is in git it is in every clone, and content-addressed history means
deleting the file does not remove it.

**How it is enforced.** `diagnose_key.py` and `inspect_export.py` are built to
this rule and print shapes only. The pipeline's own failure messages were audited
for it — the key-check failure used to print a live key from the export and one
from the vault, and now prints their shapes (`4524fca`).

**Applying it.** When a run misbehaves, do not paste the export. Run
`diagnose_key.py`; its output is designed to be safe to paste into a ticket.

## 2. The key is `datimCode + pepId`, with no separator

**The rule.** `build_key()` builds the key from its parts. It never trusts the
export's own `Datim_PEPID` column, which is compared against the built value and
reported when it disagrees.

**Why the facility code cannot be dropped.** In the 5 September export **5,857
PEPIDs appear under more than one DATIM code**. Keying on `pepId` alone would
merge those into one S/N — one person's viral loads recorded against another.
The pipeline checks this every run and says so.

> **Open with the HI team (9 Sep 2026).** Why so many? The leading explanations
> are transfers not closed out at the sending site, and genuine duplicate
> enrolment. Es has a hypothesis to test. This does not affect the key — it is
> the reason the key is shaped this way — but it matters for the denominator.

## 3. A facility code's *format* is load-bearing, not just its value

Codes are 11 characters today. That is an observation, never an assumption: code
that hard-codes the width has been wrong twice. See
[Incident 10](#10-four-facilities-rewrote-their-datim-code) and
[Incident 11](#11-the-diagnostic-that-called-every-facility-new).

## 4. The unit of analysis is the failure episode, not the client

Keyed `(sn, idx_date, idx_vl)`. One client can fail, resuppress, and fail again;
counting S/Ns would collapse those into one and understate the burden. Any new
query that groups by `sn` alone is a bug unless it is deliberately counting
people, and then it should say so in its name.

## 5. `--migrate-keys` was a one-time changeover

It issued every client a new key and moved the old S/N to `S/N_legacy`
permanently — the only way to re-key the EAC sheets, which carry no other
identifier. Running it again would issue a *second* new key to all 180,000 and
orphan everything already published. The script refuses when `S/N_legacy` is
populated, and neither batch file can pass the flag. See
[Incident 12](#12-the-migration-command-was-still-copy-pasteable).

## 6. Exported CSVs carry only currently-active clients

**Decision, 22 Aug 2026** (`4b04ec4`). Line lists are worked by hand at facility
level. A client who has died, transferred out, or is otherwise terminal cannot
be acted on, so including them spends the team's time. Export filters on
`art_status == "active"`; a test covers the rule (`a0ec329`).

This applies to **exports**, not to analysis. Terminal outcomes stay in the
cohort, because the cascade has to account for them.

## 7. EAC sheets are not cumulative — carry every one, newest last

Clients drop off an EAC sheet once their cycle closes. Taking only the newest
loses them. The pipeline unions every sheet it is given, and the order matters:
the newest must be written last so its values win. They were once ordered
alphabetically, which is not chronological (`94e8afe`).

## 8. Encrypt the folder or the disk — never the vault file

**Decision, 2 Sep 2026** (`473457d`). `SN_Key.xlsx` was password-protected and
the pipeline stopped. The deeper problem was the fix: `msoffcrypto` can *remove*
protection but cannot apply it, so teaching the pipeline to read an encrypted
vault would have had it write the vault back **unprotected, under the same
name** — silently, with nothing on screen to say so.

The pipeline now reads an encrypted vault and **refuses to overwrite one**,
writing `SN_Key.UPDATED-<stamp>.xlsx` and stopping before anything publishes
(`dd6f6ec`). Protection belongs at the folder or disk layer.

## 9. Late-reported results are excluded unless asked for

The register has an agreed cut-off. Results dated on or before it that are absent
from the register are late facility reporting — real, but outside the window, so
they are held back by default and `--include-late` adds them. The weekly batch
file passes it; the count is reported either way, honestly (`8c088b0`).

---

# Incident log

## 1. Free-text from the EMR rendered into `innerHTML`
**22 Jul 2026 · `cb1d1ea`** — EMR free text was written into the page unescaped,
so a crafted value in a clinical note would execute. Escaped at the render
boundary; recorded in the dossier's limitations table (`8d2b32d`).

## 2. Appended register rows lost every column but `S/N`
**15 Aug 2026 · `0fb269d`** — Newly unsuppressed episodes were appended with only
their key populated, so every downstream field was blank for exactly the clients
who most needed following. Found by reading the appended rows rather than the
count.

## 3. EAC sheets written alphabetically
**15 Aug 2026 · `94e8afe`** — Alphabetical order is not chronological, so an
older sheet could overwrite a newer one. Now sorted by date and written
newest-last, and the run prints the resolved order so it can be eyeballed.

## 4. The first-ever and first-high viral loads reached nothing
**20 Aug 2026 · `1e9daeb`** — `First_Ever_VL_Value` and friends were read from the
export but never made it into the cohort: the `ecols` whitelist did not name
them, so they were dropped silently between ingest and analysis. The same
whitelist gap later hid `Followup_VL_Result_Date` ([Incident 6](#6-every-episode-had-a-null-follow-up-date)).

**Lesson.** A whitelist fails silently by design. When a column is "there but
empty", check the whitelist before checking the data.

## 5. A variable collision broke every script on the page
**22 Aug 2026 · `d38c690`** — A second `const wt` in the single inline script made
the whole file fail to parse, so *nothing* ran, including sign-in. The page was
not broken in the area being edited; it was broken everywhere.

**What stops it recurring.** `check_js.py` extracts the inline script, runs
`node --check`, and translates line numbers back to `index.html`. It runs in CI
as the `javascript` job. A parse error now fails the build instead of the login
page.

## 6. Every episode had a NULL follow-up date
**22 Aug 2026 · `25bffe3`** — `fu_date` was NULL for all 4,228 rows: the source
column was missing from the whitelist, and it was also being taken from the wrong
place. It is now derived from whichever source supplied `fu_vl`.

Two charts built against it were withdrawn rather than shipped, because on any
snapshot ingested before the fix they render as flat zero — indistinguishable
from a defect. See `PROJECT_STATUS.md` §5a.

## 7. Filter labels rendered blank
**28 Aug 2026 · `6cdcb35`** — After the multi-select rewrite the option menu showed
ticks with no text. Not a data problem: `.f label` (specificity 0,1,1) was
out-ranking `.ms-opt` (0,1,0) and applying the filter bar's caption styling to
the menu items. Scoped to `.ms-menu .ms-opt`, inherited properties reset, text
wrapped in a `<span>`.

## 8. Real PEPIDs in the terminal and in git history
**Late Aug 2026, same session as `a5dd678`** — Diagnostic output printed live
PEPIDs, and they reached git, in both an original commit and its fix.

**Response.** Docstrings and examples rewritten to synthetic placeholders; all 87
commits rewritten with `git filter-repo`; force-pushed; verified from a fresh
clone; the pre-purge bundle containing the original identifiers destroyed.

**Why it needed history rewriting.** Git is content-addressed. Deleting the file
in a later commit leaves the blob reachable in every clone and every fork.

This incident is the origin of [Standing rule 1](#1-no-identifier-is-ever-printed-logged-or-pasted).

## 9. The export's "index date" was the day blood was drawn
**6 Sep 2026 · `127aa53`** — The cascade page's downloadable CSV — the one
facilities use for correction — carried the **sample collection date** as the
index value rather than the date the result was received at the facility.
Confirmed rather than assumed: the column matched `lastDateOfSampleCollection`
on 95.4% of rows. Headers now name each date explicitly, so the two cannot be
confused again.

## 10. Four facilities rewrote their DATIM code
**5–9 Sep 2026 · `4524fca`** — A weekly run reported 3,594 new clients against a
usual ~1,100, with the key check down to 98.0%.

**Cause.** Four facilities had appended a seven-character suffix (shape
`_A999A_`) to their 11-character DATIM code. The key is built from that code, so
every client at those sites looked new.

**What would have happened.** **2,484 clients who already had a key would have
been issued a second one** and severed from their published history. Nothing
would have errored. The run was stopped before it published.

**Why the existing guard missed it.** The pipeline refused below a 50% key check.
This sat at 98% — a format change at four sites out of 95 does not move the
overall percentage far enough to trip a blanket floor.

**What stops it recurring.** `check_key_format()` compares facility codes rather
than percentages. A code the vault has never seen *that contains a code it knows*
— a known code with characters appended — is a hard stop naming the shape. A code
that is simply unfamiliar, with an ordinary shape, is a new site and only warns.
The blanket floor also moved from 50% to 95%.

**Resolution.** The suffix was corrected at source before the run went ahead. The
9 September export returned 99.4% and 1,110 new clients, which reconciles exactly
against the diagnosis: 1,104 genuinely new at known sites, plus the 6 of the 2,490
suffixed rows that were genuinely new.

## 11. The diagnostic that called every facility new
**9 Sep 2026 · `26bbc20`** — While confirming Incident 10, `diagnose_key.py`
reported "66 new DATIM codes". It was wrong, and it had been wrong on every run.

**Two faults pointing the same way.** It derived the vault's facilities by cutting
each key at a hard-coded 11 characters — the very assumption that had just failed
— and it compared the export's code *raw* against a vault that `norm_key()` had
already upper-cased. **Every code in the export is lower-case**, so nothing ever
matched and every facility was reported as new.

**Lesson.** A diagnostic used to investigate an incident is itself untested code,
and a plausible-looking number from it will be believed. This one produced a
figure ("66 new facilities") that was reported before it was checked.

## 12. The migration command was still copy-pasteable
**9 Sep 2026** — The one-time `--migrate-keys` command was run again, from the
runbook's Part 2, because Part 2 reads like instructions rather than history.

**Nothing happened**, which is the point: the script detected `S/N_legacy` was
populated and stopped before touching anything.

**What changed.** Part 2 now opens by saying it is history and pointing at Part 3;
Part 3 now leads with the two batch files, neither of which can pass the flag.
The refusal message is in the runbook's troubleshooting table.

**Lesson.** A dangerous command sitting in a document is a dangerous command. The
defence that worked was the one in the code, not the one in the prose.
