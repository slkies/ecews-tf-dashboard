# Running the de-identification pipeline

This is the whole procedure, written for someone who is not a programmer. You
run two commands. Everything else is copying files into the right folder and
reading what the script tells you.

The commands go in **PowerShell**. Open the Start menu, type `PowerShell`, press
Enter. A blue window appears; you type a line and press Enter.

---

## The three things you need first

| | What | Where it comes from |
|---|---|---|
| 1 | `SN_Key.xlsx` — the vault | Wherever you keep it offline. **Only you have this.** |
| 2 | The raw weekly treatment export | NMRS/DHIS export, **before** you delete any columns |
| 3 | `TF_Dashboard_Dataset.xlsx` | Already on this machine, in the repo folder |

**On item 2:** the pipeline needs the `pepId` and `datimCode` columns to look a
client up in the vault. The treatment sheet inside the workbook has had those
deleted, so it cannot be used. Export fresh and leave every column in — the
script removes the identifying ones itself, which is the point of it.

**On item 1:** the vault is the single most valuable file in the system. If it
is lost, every historical S/N becomes unresolvable *and* the next run issues
new keys to everyone, cutting the cohort off from its own history. Before you
start, copy it somewhere else as well. The script keeps backups, but a second
copy made by you, before an irreversible step, costs nothing.

---

## Step 1 — build the secure folder (once, ever)

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\setup_secure.py" --dataset "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\TF_Dashboard_Dataset.xlsx"
```

This creates `C:\ECEWS_Secure\`, splits the five EAC sheets and the register out
of the workbook into separate files, and writes `secure.ini` with the paths
already filled in.

It reads a 319 MB workbook, so **expect several minutes**. It prints each sheet
as it finishes, so you can tell it is working and not stuck.

It never deletes and never overwrites, so if you run it twice nothing is harmed.

### Why a separate folder outside the repo

The repository syncs to GitHub. Anything inside it is one careless `git add`
away from being published. The `.gitignore` and the CI check are backstops —
the actual defence is that patient data never sits in that folder at all.

## Step 2 — put the two files you supply into place

    C:\ECEWS_Secure\vault\SN_Key.xlsx                      <- the vault
    C:\ECEWS_Secure\incoming\ECEWS_Treatment_Linelist.xlsx <- raw export

The names must match exactly. If yours differ, either rename the file or open
`C:\ECEWS_Secure\secure.ini` in Notepad and change the path.

## Step 3 — the rehearsal

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config C:\ECEWS_Secure\secure.ini --migrate-keys --dry-run
```

`--dry-run` means **change nothing**. It reads everything, works out what it
would do, prints it, and writes not a single file. Nothing you do at this step
can damage anything. Run it as many times as you like.

`--migrate-keys` is the one-time key change: every existing client is issued a
new secure string, the old S/N is kept in a column called `S/N_legacy`, and the
existing dataset is re-keyed through it.

### What a good rehearsal looks like

```
treatment list: 180,141 rows x 110 cols
EAC list  EAC Line List_23rd May    52,104 rows x  49 cols
   ... one line per EAC sheet, five in total ...
register: N newly unsuppressed episode(s) appended
validation passed: no prohibited column survives, every row keyed
dry run - vault not written, no file produced
```

**Check three things:**

1. **Five EAC sheets are listed.** That list is not cumulative — clients drop
   out once a cycle closes — so all five must be carried forward. The union is
   what recovers 293 cohort clients who appear in no recent sheet.
2. **Validation passed.** If it fails it names the column it objected to and
   publishes nothing. That is the safety net working, not a breakage.
3. **No line saying rows "cannot be linked".** A warning here means a client
   carries an S/N found in neither the current nor the legacy mapping. Expect
   up to about 7 of these on the register — clients who have since left the
   programme. Many more than that, stop and tell me before going further.

## Step 4 — the real run

Same command, `--dry-run` removed:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config C:\ECEWS_Secure\secure.ini --migrate-keys
```

This writes the new vault (backing up the old one first), updates the register,
and produces `C:\ECEWS_Secure\output\TF_Dashboard_Dataset_YYYY-MM-DD.parquet.zip`.

That file is de-identified and safe to upload.

## Step 5 — publish

Open the dashboard, go to the **Admin** tab, upload the `.parquet.zip`.

Doing this by hand the first few times is deliberate: you see exactly what
lands before automating it. Once you trust the run, fill in the `[upload]`
section of `secure.ini` and the pipeline will refresh the dashboard itself.

---

## Every week after this

**Use `--migrate-keys` once and never again.** It is for the single changeover.
Running it a second time would issue everyone *another* new key and break the
link to the data you already published. The script refuses if it detects the
migration has already happened — but do not rely on that; just leave the flag
off.

The weekly routine is:

1. Drop the new raw treatment export into `C:\ECEWS_Secure\incoming\`,
   replacing the old one.
2. When a new EAC list arrives (fortnightly), add it to
   `C:\ECEWS_Secure\incoming\eac\` — **add**, do not replace.
3. Run:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config C:\ECEWS_Secure\secure.ini --dry-run
```

4. If it looks right, run it again without `--dry-run`, then upload.

From here on, existing clients keep their key and only genuinely new clients
get a new one.

---

## One consequence to expect after the migration

The snapshots already loaded in the dashboard stay on the old keys. The
comparison page cannot match episodes across the changeover, so the first
comparison spanning it will read as though the whole cohort was replaced.

That is the migration, not a fault. Everything after that point compares
normally. If you would rather not see the discontinuity at all, delete the
pre-migration snapshots once you are satisfied with the first run.

## If something goes wrong

Every run writes a log to `C:\ECEWS_Secure\logs\deid-YYYY-MM-DD.log`. Send me
that file and I can tell you what happened.

The two failures worth recognising yourself:

- **"treatment list needs both 'pepId' and 'datimCode'"** — you used an export
  with columns deleted. Export again, keep everything.
- **"VALIDATION FAILED - nothing published"** — an identifying column survived.
  Nothing was written. The message names the column.

Both fail *before* anything is published. The pipeline is built to stop rather
than to publish something it is unsure about.
