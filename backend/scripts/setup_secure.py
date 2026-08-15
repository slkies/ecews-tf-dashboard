"""One-time setup for the pipeline folder.

Run this once, before the first `deidentify.py` run. It works IN PLACE in the
folder where you already keep the data - it does not move your files. It:

  1. adds the subfolders the pipeline needs (eac, backups, output, logs),
  2. splits the EAC sheets and the register out of the TF_Dashboard_Dataset
     workbook into separate files, because the pipeline reads one file per
     EAC list and the dashboard unions them all,
  3. writes secure.ini pointing at everything, including the files already
     sitting there,
  4. reports anything still missing.

It never deletes and never overwrites, so running it twice is safe.

    python setup_secure.py
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

# Where the data already lives. Outside the repository, which is the point:
# the repo syncs to GitHub, and anything inside it is one careless `git add`
# from being published.
DEFAULT_ROOT = Path(r"C:\Users\eesar\Downloads\Public_Health_Work\Data\TF_Dashboard Files")

REGISTER_SHEET = "Total Unsuppressed"
EAC_PREFIX = "EAC"
TREAT_PREFIX = "Treatment"

INI = """\
# Written by setup_secure.py. Edit if your paths change.
#
# Keep this file, and everything it points at, OUTSIDE the repository folder.

[paths]
vault    = {root}\\SN_Key.xlsx
backups  = {root}\\backups

treatment = {treatment}
# A glob: the EAC list is not cumulative - clients drop out as cycles close -
# so every sheet must be carried forward, not just the newest.
eac       = {root}\\eac\\*.xlsx

register = {root}\\Total_Unsuppressed.xlsx

output = {root}\\output
logs   = {root}\\logs

# The weekly export arrives password-protected. Put the password here and the
# pipeline decrypts it in memory - the plaintext never touches the disk.
# This is a real credential: this file must stay out of the repository.
[secrets]
treatment_password = PUT-THE-PASSWORD-HERE

# Uncomment to have the run end with the dashboard refreshed. Until then the
# run stops after writing the parquet and you upload it on the Admin tab,
# which is the safer way to start.
#
# [upload]
# base_url = https://your-ecews-host
# username = pipeline
# password = set-a-real-one
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                    help="folder holding SN_Key.xlsx and the line lists")
    ap.add_argument("--dataset", type=Path, default=None,
                    help="the TF_Dashboard_Dataset workbook "
                         "(default: TF_Dashboard_Dataset.xlsx inside --root)")
    a = ap.parse_args()

    root = a.root
    if not root.is_dir():
        print(f"  folder not found: {root}")
        return 1
    dataset = a.dataset or root / "TF_Dashboard_Dataset.xlsx"
    print(f"\n  working in: {root}")

    for sub in ("eac", "backups", "output", "logs"):
        (root / sub).mkdir(exist_ok=True)
    print("  subfolders ready: eac, backups, output, logs")

    # The treatment export is named with its date, so match on a pattern
    # rather than a fixed name and take the most recent.
    treats = sorted(root.glob(f"*{TREAT_PREFIX}*.xls*"),
                    key=lambda p: p.stat().st_mtime, reverse=True)
    treatment = treats[0] if treats else root / "ECEWS_Treatment_Linelist.xlsx"
    if treats:
        print(f"  treatment list: {treatment.name}")
        if len(treats) > 1:
            print(f"                  ({len(treats) - 1} older one(s) ignored)")

    if not dataset.exists():
        print(f"\n  dataset not found: {dataset}")
        return 1

    xl = pd.ExcelFile(dataset)
    eac = [s for s in xl.sheet_names if s.startswith(EAC_PREFIX)]
    treat_sheets = [s for s in xl.sheet_names if s.startswith(TREAT_PREFIX)]

    print(f"\n  splitting {len(eac)} EAC sheet(s) + the register out of")
    print(f"  {dataset.name}. It is large - expect several minutes.\n")

    written = skipped = 0
    jobs = [(s, root / "eac" / f"{s}.xlsx") for s in eac]
    if REGISTER_SHEET in xl.sheet_names:
        jobs.append((REGISTER_SHEET, root / "Total_Unsuppressed.xlsx"))

    for sheet, dest in jobs:
        if dest.exists():
            print(f"    exists, left alone   {dest.name}")
            skipped += 1
            continue
        df = xl.parse(sheet, dtype=str)
        df.to_excel(dest, index=False)
        print(f"    {len(df):>7,} rows  ->  {dest.name}")
        written += 1

    ini = root / "secure.ini"
    if ini.exists():
        print(f"\n  secure.ini already exists, left alone")
    else:
        ini.write_text(INI.format(root=str(root), treatment=str(treatment)),
                       encoding="utf8")
        print(f"\n  wrote {ini.name}")
    print(f"\n  {written} file(s) written, {skipped} left alone")

    print("\n  BEFORE THE FIRST RUN:")
    print(f"    1. Open {ini.name} and put the treatment list's password in")
    print("       the [secrets] section. The export is encrypted and cannot")
    print("       be read without it.")
    print(f"    2. Copy SN_Key.xlsx somewhere else as a safety net. The script")
    print("       backs it up, but a copy you made yourself, before an")
    print("       irreversible step, costs nothing.")
    # The workbook's own treatment sheets cannot be used: the vault key is
    # built from pepId and datimCode, and those were deleted by hand.
    if treat_sheets:
        print(f"\n  Note: the {len(treat_sheets)} treatment sheet(s) inside the workbook are NOT")
        print("  used. They have had pepId and datimCode deleted, so they cannot")
        print("  be matched to the vault. The raw weekly export is the input now.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
