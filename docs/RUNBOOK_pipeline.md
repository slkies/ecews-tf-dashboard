# Running the de-identification pipeline

This is the whole procedure, written for someone who is not a programmer. You
run two commands. Everything else is editing one line in a text file and
reading what the script tells you.

The commands go in **PowerShell**. Open the Start menu, type `PowerShell`, press
Enter. A blue window appears; you paste a line and press Enter.

---

## Where everything lives

    C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files

Outside the repository, which is the whole point: the repo syncs to GitHub, and
anything inside it is one careless `git add` from being published. The
`.gitignore` and the CI check are backstops — the real defence is that patient
data never sits in that folder at all.

All three files you need are already there:

| | File | Note |
|---|---|---|
| 1 | `SN_Key.xlsx` | the vault — 180,246 clients |
| 2 | `ECEWS_Treatment_Linelist_8th August 2026.xlsx` | the raw weekly export, **password-protected** |
| 3 | `TF_Dashboard_Dataset.xlsx` | holds the 5 EAC sheets and the register |

**You need the password for item 2.** The export is encrypted — correctly so, it
is raw PII. The pipeline decrypts it in memory and never writes the plaintext to
disk, but it cannot read it at all without the password. You put that into
`secure.ini` yourself; it is not something to send to anyone, including me.

**Copy `SN_Key.xlsx` somewhere else before you start.** It is the single most
valuable file in the system: lose it and every historical S/N becomes
unresolvable *and* the next run issues new keys to everyone, cutting the cohort
off from its own history. The script keeps backups, but a copy you made
yourself, before an irreversible step, costs nothing.

**The treatment sheets inside the workbook are not used.** They have had `pepId`
and `datimCode` deleted, so they cannot be matched to the vault. The raw weekly
export is the input from now on — and leave every column in it, since removing
the identifying ones is the script's job. Deleting them by hand beforehand is
what let `uniqueId` and `dob` through last time.

---

## Step 1 — prepare the folder (once, ever)

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\setup_secure.py"
```

This works **in place** — it moves nothing. It adds four subfolders (`eac`,
`backups`, `output`, `logs`), splits the five EAC sheets and the register out of
the workbook into separate files, and writes `secure.ini` pointing at all of it.

It reads a 319 MB workbook, so **expect several minutes**. It prints each sheet
as it finishes, so you can tell it is working rather than stuck.

It never deletes and never overwrites, so running it twice harms nothing.

## Step 2 — add the password

Open `secure.ini` (in that same folder) with Notepad and replace
`PUT-THE-PASSWORD-HERE` with the treatment export's password:

    [secrets]
    treatment_password = ...

That file now holds a real credential. It sits outside the repository and must
stay there.

## Step 3 — the rehearsal

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --migrate-keys --dry-run
```

`--dry-run` means **change nothing**. It reads everything, works out what it
would do, prints it, and writes not a single file. Nothing you do at this step
can damage anything, so run it as often as you like.

`--migrate-keys` is the one-time key change: every existing client is issued a
new secure string, the old S/N is kept in a column called `S/N_legacy`, and the
existing dataset is re-keyed through it.

### What a good rehearsal looks like

```
vault: 180,246 existing mappings
ECEWS_Treatment_Linelist_8th August 2026.xlsx: decrypted in memory
treatment list: 180,141 rows x 110 cols
key check: 99.x% of the export matches the vault
EAC list  EAC Line List_23rd May    52,104 rows x  49 cols
   ... one line per EAC sheet, five in total ...
register: N newly unsuppressed episode(s) appended
validation passed: no prohibited column survives, every row keyed
dry run - vault not written, no file produced
```

**Check four things:**

1. **The key check is high** — 95%+. This is the most important number on the
   screen. It is the share of the export that matched a client already in the
   vault. If it were low, the key format would have changed and the run would be
   about to issue new keys to nearly everyone. The script refuses below 50%, but
   anything under about 95% is worth stopping to understand.
2. **Five EAC sheets are listed.** That list is not cumulative — clients drop out
   once a cycle closes — so all five must be carried forward. The union is what
   recovers 293 cohort clients who appear in no recent sheet.
3. **Validation passed.** If it fails it names the column it objected to and
   publishes nothing. That is the safety net working, not a breakage.
4. **No line saying rows "cannot be linked".** That means a client carries an
   S/N found in neither the current nor the legacy mapping. Expect up to about 7
   on the register — clients who have since left the programme. Many more than
   that, stop and tell me.

## Step 4 — the real run

Same command, `--dry-run` removed:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --migrate-keys
```

This writes the new vault (backing up the old one first), updates the register,
and produces `output\TF_Dashboard_Dataset_YYYY-MM-DD.parquet.zip`.

That file is de-identified and safe to upload.

## Step 5 — publish

Open the dashboard, go to the **Admin** tab, upload the `.parquet.zip`.

Doing this by hand the first few times is deliberate: you see exactly what lands
before automating it. Once you trust the run, fill in the `[upload]` section of
`secure.ini` and the pipeline will refresh the dashboard itself.

---

## Every week after this

**Use `--migrate-keys` once and never again.** It is for the single changeover.
Running it a second time would issue everyone *another* new key and break the
link to everything already published. The script refuses if it detects the
migration has already happened — but do not rely on that; just leave the flag
off.

The weekly routine:

1. Drop the new raw treatment export into the folder. The script picks the most
   recently modified file matching `*Treatment*`, so you can leave the old one
   in place or remove it.
2. When a new EAC list arrives (fortnightly), add it to the `eac` subfolder —
   **add**, do not replace.
3. Run:

```powershell
python "C:\Users\eesar\Downloads\Public_Health_Work\EAC\ECEWS_TF_Monitor\backend\scripts\deidentify.py" --config "C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files\secure.ini" --dry-run
```

4. If it looks right, run it again without `--dry-run`, then upload.

From here on, existing clients keep their key and only genuinely new clients get
a new one.

---

## One consequence to expect after the migration

The snapshots already loaded in the dashboard stay on the old keys. The
comparison page cannot match episodes across the changeover, so the first
comparison spanning it will read as though the whole cohort was replaced.

That is the migration, not a fault. Everything after that point compares
normally. If you would rather not see the discontinuity, delete the
pre-migration snapshots once you are satisfied with the first run.

## If something goes wrong

Every run writes a log to `logs\deid-YYYY-MM-DD.log`. Send me that file and I
can tell you what happened.

The failures worth recognising yourself:

- **"maps N identities to more than one S/N"** — the same client is carried
  twice in the vault. The script writes `SN_Key-AMBIGUOUS.csv` listing exactly
  which rows, so you can decide each one. There are currently **91** of these.
- **"is password-protected"** — the password in `secure.ini` is missing or
  wrong.
- **"only X% of the treatment list matches the vault"** — the key format
  changed. Stop and tell me; do not force it.
- **"treatment list has no 'currentArtStatus' column"** — a column was renamed
  or dropped in the export. Matching is case-insensitive, so this means it is
  genuinely absent.
- **"VALIDATION FAILED - nothing published"** — an identifying column survived.
  Nothing was written. The message names the column.

Every one of these stops *before* anything is published. The pipeline is built
to refuse rather than to publish something it is unsure about.
