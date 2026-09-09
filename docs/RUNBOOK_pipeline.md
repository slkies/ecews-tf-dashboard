# Running the de-identification pipeline

The whole procedure, written for someone who is not a programmer. Commands go in
**PowerShell** — Start menu, type `PowerShell`, Enter. Paste a line, press Enter.

The ones that change something take `--dry-run` first, which reads everything,
tells you what it would do, and writes nothing. **The weekly run is
[Part 3](#part-3--every-week-after-this) — or just double-click
`2 - Run pipeline.bat`.** Part 1 and Part 2 are history, kept for audit.

Every command here is safe to run twice: the script refuses rather than repeating
something that must not be repeated. That refusal is a guard, not a licence — if
you see one, read it, and check
[If something goes wrong](#if-something-goes-wrong) before trying again.

Why the pipeline behaves the way it does, and what went wrong to make it that
way, is in [`DECISIONS_AND_INCIDENTS.md`](DECISIONS_AND_INCIDENTS.md).

---

## Where everything lives

    C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files

Outside the repository, which is the point: the repo syncs to GitHub, and
anything inside it is one careless `git add` from being published. The
`.gitignore` and the CI check are backstops — the real defence is that patient
data never sits in that folder at all.

| File | What it is |
|---|---|
| `SN_Key.xlsx` | the vault — 180,153 identities |
| `ECEWS_Treatment_Linelist_8th August 2026.xlsx` | raw weekly export, **password-protected**, 180,528 rows × 132 cols |
| `TF_Dashboard_Dataset.xlsx` | the original workbook the EAC sheets came out of |
| `eac\*.xlsx` | the five EAC lists, one file each |
| `Total_Unsuppressed.xlsx` | the cumulative register |
| `secure.ini` | paths and the export password |

**The vault is the single most valuable file here.** Lose it and every
historical S/N becomes unresolvable *and* the next run issues new keys to
everyone, cutting the cohort off from its own history. The scripts back it up
before every write, but keep a copy of your own somewhere else too.

**The treatment sheets inside the workbook are not used.** They have had
`pepId` and `datimCode` deleted, so they cannot be matched to the vault. The raw
weekly export is the input now — and leave every column in it. Removing the
identifying ones is the script's job; deleting them by hand beforehand is what
let `uniqueId` and `dob` through last time.

---

# Part 1 — one-time setup

These four steps happen once, ever. **Steps 1–3 are already done** (15 Aug
2026); they are recorded here so the procedure is complete.

## ✔ Step 1 — prepare the folder

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\setup_secure.py"
```

Works in place — moves nothing. Adds `eac`, `backups`, `output` and `logs`,
splits the five EAC sheets and the register out of the workbook, writes
`secure.ini`. Reads a 319 MB file, so it takes several minutes.

## ✔ Step 2 — add the password

Open `secure.ini` in Notepad, replace `PUT-THE-PASSWORD-HERE` under `[secrets]`
with the export's password. That file now holds a real credential and must stay
outside the repository.

## ✔ Step 3 — resolve duplicate identities

The vault mapped 93 identities to two S/Ns each — same PEPID, same facility,
different ART start dates. A reused patient ID, or a re-enrolment recorded as a
new client. The pipeline refuses to run until these are settled.

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\resolve_vault_duplicates.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --dry-run
```

Then again without `--dry-run`. **Result: 180,246 → 180,153 rows.** Backup at
`backups\SN_Key-PRE-DEDUPE-*.xlsx`, dropped rows in `SN_Key-MERGED.csv`.

Where one of the two S/Ns was already in use it kept that one (15 cases). The
other 78 had no history at all, so they kept the earliest ART start date — which
is what the evidence supported: of the 15 settled by history, 14 kept the
*earlier* enrolment. **None had both S/Ns in use**, so no client's history was
fused with another's.

## Step 4 — recover the EAC rows with no S/N

307 rows across the five EAC sheets have a blank S/N. They are not corrupt —
every other column is populated — they simply lost the key when the sheets were
de-identified by hand. Without it those clients vanish from the cascade as
though they had never enrolled.

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\recover_unkeyed_eac.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --dry-run
```

It matches each blank row against the treatment list on **facility + DOB + ART
start date + sex**, and where that identifies exactly one client, fills the S/N
in from the vault.

**149 of the 307 recover automatically, with zero ambiguous matches.** Run it
again without `--dry-run` to apply; the EAC sheets are backed up first.

Only unique matches are used. A signature matching two clients is left alone —
guessing would file one patient's viral loads under another, which is worse than
a dropped row.

### The remaining 158

They are written to `EAC_UNRECOVERED.csv`, which is produced even on a dry run,
with the sheet name and row number:

| Sheet | Rows to look up |
|---|---:|
| EAC Line List_23rd May | 28 |
| EAC Line List_20th June | 28 |
| EAC Line List_4th July | 20 |
| EAC Line List_10th July | 41 |
| EAC Line List_24th July | 41 |

These are not in the 8 August treatment export at all — most will have
transferred out, died, or been removed from the active list since their EAC
cycle.

**Yes, a recovered `Datim_PEPID` will work — it is exactly the vault key.** The
CSV has an empty `Datim_PEPID` column. Look the client up in the original EAC
export, paste their code in, save the CSV, and run the script again. Codes you
supply take precedence over any inference, and anything you have typed is
carried forward if you run it more than once. A code that is not in the vault is
reported rather than silently ignored.

This step is optional. Skipping it costs 307 EAC rows out of ~237,000.

---

# Part 2 — the key migration (once, ever)

> **This part is history. It has already been done and must never be repeated.**
> The commands below carry `--migrate-keys`, which issues every client a new
> key. Running it a second time would issue a *second* new key to all 180,000
> and orphan everything already published. The script now refuses, but do not
> rely on that — **for the weekly run, go to [Part 3](#part-3--every-week-after-this),
> or just double-click `2 - Run pipeline.bat`.**
>
> Kept only so the changeover can be audited.

Every existing client is issued a new secure key. The old S/N moves to
`S/N_legacy` and stays there permanently — it is the only way to re-key the EAC
sheets, which carry no other identifier.

## Step 5 — the rehearsal

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --migrate-keys --include-late --dry-run
```

Takes about 8 minutes, most of it decrypting and reading a 132-column export.

### What a good run looks like

```
vault: 180,153 existing mappings
KEY MIGRATION: issuing a new key to all 180,153 clients
ECEWS_Treatment_Linelist_8th August 2026.xlsx: decrypted in memory
treatment list: 180,528 rows x 132 cols
key check: 99.8% of the export matches the vault
vault: 307 new client(s) assigned a key
EAC list  ... five lines, one per sheet ...
register: N newly unsuppressed episode(s) appended
validation passed: no prohibited column survives, every row keyed
```

**Check three things:**

1. **`key check: 99.8%`** — the most important number on the screen. It is the
   share of the export that matched a client already in the vault. If it were
   low, the key format would have changed and the run would be about to issue
   new keys to nearly everyone, severing the whole cohort from its history. The
   script refuses below 50%; anything under about 95% is worth stopping for.
2. **Five EAC sheets listed.** That list is not cumulative — clients drop out
   once a cycle closes — so all five must be carried forward. The union is what
   recovers 293 cohort clients who appear in no recent sheet.
3. **`validation passed`.** If it fails it names the column or the count it
   objected to and publishes nothing.

## Step 6 — the real run

Same command, `--dry-run` removed:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --migrate-keys --include-late
```

Writes the new vault (backing up the old one first), updates the register, and
produces `output\TF_Dashboard_Dataset_YYYY-MM-DD.parquet.zip`. That file is
de-identified and safe to upload.

### About `--include-late`

The register covers results received up to **3 July**. 133 clients are active,
unsuppressed, and had a result received on or before that date but are missing
from the register — late facility reporting. They are outside the agreed cut-off
so they are not added by default; `--include-late` adds them.

Without the flag the run appends 276 newly unsuppressed episodes. With it, those
133 as well.

## Step 7 — publish

Dashboard → **Admin** tab → upload the `.parquet.zip`.

Doing this by hand the first few times is deliberate: you see exactly what lands
before automating it. Once you trust the run, fill in the `[upload]` section of
`secure.ini` and the pipeline will refresh the dashboard itself.

### One consequence to expect

Snapshots already in the dashboard stay on the old keys, so the comparison page
cannot match episodes across the changeover — the first comparison spanning it
reads as though the whole cohort was replaced. That is the migration, not a
fault. Everything after compares normally. If you would rather not see the
discontinuity, delete the pre-migration snapshots once you are satisfied.

---

# Part 3 — every week after this

**Use `--migrate-keys` once and never again.** It is for the single changeover.
Running it twice would issue everyone *another* new key and orphan everything
published under the first. The script refuses if it detects the migration has
already happened — but do not rely on that; just leave the flag off.

1. Drop the new raw treatment export into the folder. The script takes the most
   recently modified file matching `*Treatment*`.
2. When a new EAC list arrives (fortnightly), add it to `eac\` — **add**, do not
   replace.
3. Rehearse, then run. **The simplest way is to double-click, in `backend\scripts\`:**

   - **`1 - Rehearse pipeline.bat`** — reads everything, writes nothing.
   - **`2 - Run pipeline.bat`** — the real thing, once the rehearsal looks right.
     It already includes late-reported results.

   Neither can pass `--migrate-keys`, so neither can make the mistake that
   section warns about. Prefer them over typing a command.

If you would rather drive it from a terminal, the same routine is one command:

```powershell
cd "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts"
```

```powershell
.\weekly.ps1
```

`weekly.ps1` is the whole routine in one command. It checks the inputs before
starting — that the password is filled in, that a treatment export exists and
how old it is, that the EAC folder and the vault are present — and stops with a
plain reason rather than a stack trace.

It rehearses by default and changes nothing. Add `-Go` to run for real, and
`-IncludeLate` to sweep up late-reported results:

```powershell
.\weekly.ps1 -Go -IncludeLate
```

It never passes `--migrate-keys` — that was the one-time changeover. When it
finishes it prints the exact file to upload.

4. Upload the file it names, on the Admin tab.

### The long form

If you would rather run the pipeline directly:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --dry-run
```

From here on, existing clients keep their key and only genuinely new clients get
a new one.

---

## Protecting the data at rest

**Decision, 29 Aug 2026: encrypt the folder or the disk, not the vault file.**

`SN_Key.xlsx` was password-protected on 29 August and the pipeline stopped: it
could not read it, and — the part that mattered more — once taught to read it,
writing the vault back would have produced a **plaintext file under the same
name**. `msoffcrypto` removes protection; it cannot apply it. Nothing on screen
would have said the encryption was gone.

The pipeline now refuses that write and hands you an unencrypted
`SN_Key.UPDATED-*.xlsx` to re-protect by hand. That is safe but weekly manual
work, and a manual step in a weekly job is a step that eventually gets skipped.

**A file an automated job must rewrite every week is the wrong unit to
encrypt.** The folder is the right boundary, and it protects the exports, the
register and the outputs at the same time — all of which carry the same data
the vault does.

Two ways, both on Windows 11 Pro:

**BitLocker on the drive — preferred.** Whole-disk, transparent to every
script, and the recovery key can be escrowed with ECEWS IT or a Microsoft
account. Needs IT to permit it. Protects everything, including the raw exports.

**EFS on the folder — the fallback.** Right-click the folder → Properties →
Advanced → *Encrypt contents to secure data*. Per-user, transparent to scripts,
no password to remember or type.

> **If you use EFS, back up the certificate the same day.** EFS keys are tied
> to the Windows user profile. Lose the profile without an exported key and the
> folder is unrecoverable — and the vault is the one file in this system that
> cannot be rebuilt from anything else. Run `certmgr.msc` → Personal →
> Certificates → the one issued for *Encrypting File System* → right-click →
> All Tasks → Export → include the private key → store the `.pfx` somewhere
> that is not that folder.

`vault_password` remains supported in `secure.ini`. Nothing needs it once the
vault is a plain workbook again, but it costs nothing to keep and means a
future encrypted vault reads rather than crashes.

## If something goes wrong

Every run writes a log to `logs\deid-YYYY-MM-DD.log`. Send me that file.

| Message | What it means |
|---|---|
| `maps N identities to more than one S/N` | Run `resolve_vault_duplicates.py` (Step 3). |
| `is password-protected` | The password in `secure.ini` is missing or wrong. |
| `only X% of the treatment list matches the vault` | The key format changed. **Stop and tell me** — do not force it. About 99% is normal; the run refuses below 95%. |
| `facility code(s) are a code the vault already knows with extra characters appended` | A facility has started writing its DATIM code a different way — exactly what happened on 5 September. These are **not** new clients. **Stop and tell me.** Ask the HI team what changed at those sites. |
| `N facility code(s) the vault has never seen` | A warning, not a stop. A genuinely new site looks like this. Check the count of rows is plausible for a new facility. |
| `Keys have already been migrated` | You passed `--migrate-keys`. Leave it off — see [Part 3](#part-3--every-week-after-this). Nothing was written. |
| `treatment list has no 'currentArtStatus' column` | A column was renamed or dropped. Matching is case-insensitive, so it is genuinely absent. |
| `dropping N row(s) with no S/N` | Not an error. Blank in the source; Step 4 recovers what it can. |
| `VALIDATION FAILED - nothing published` | An identifying column survived. Nothing was written; the message names it. |

Every one of these stops *before* anything is published. The pipeline is built to
refuse rather than publish something it is unsure about.

### When the key check drops, run the diagnostic

Do **not** paste the export, or a key, to anyone. Run this instead:

```powershell
cd "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files"
```

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\diagnose_key.py" --config secure.ini
```

It answers the only question that matters — *are these really new clients, or is
the export writing existing ones a different way?* — using counts, lengths and
character shapes. It prints no identifier and its output is safe to paste into a
ticket or a chat.

What to look for:

- **`would match ignoring punctuation/spacing`** above zero — the export changed
  formatting. These are existing clients about to get a second key.
- **`at codes the vault already knows`** carrying most of the unmatched rows —
  normal. New people at familiar facilities.
- **`at DATIM codes the vault has never seen`** — either a new site, or a code
  that has been rewritten. The `unrecognised code shape` lines tell you which.
- **`EXPORT'S OWN Datim_PEPID vs datimCode+pepId · disagreeing rows`** above zero
  — the export's own key column disagrees with its parts. Worth asking about.

This happened on 5 September 2026 and is written up in full in
[`DECISIONS_AND_INCIDENTS.md`](DECISIONS_AND_INCIDENTS.md#10-four-facilities-rewrote-their-datim-code).

## What the pipeline removes

Direct identifiers: `patientId`, `pepId`, `Datim_PEPID`, `PEPID_Datim`,
`patientHospitalNo`, `previousId`, `surname`, `firstname`, `phoneNo`, `address`,
`uniqueId`, `uniquePatientId`, `dob`/`DOB`.

Sensitive but not identifying, and unused by the dashboard: `causeOfDeath`,
`vaCauseOfDeath`, `facilityTransferredTo`.

Matching is case-insensitive, and the same list applies to every sheet. It is
also checked again after removal — the run fails and publishes nothing if
anything on the list survives, or if a column merely *looks* like an identifier.
