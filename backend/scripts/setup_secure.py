"""One-time setup for the secure pipeline folder.

Run this once, before the first `deidentify.py` run. It:

  1. creates C:\\ECEWS_Secure and its subfolders,
  2. splits the existing TF_Dashboard_Dataset workbook into the separate
     files the pipeline expects (one file per EAC sheet, plus the register),
  3. writes a secure.ini pointing at all of it,
  4. tells you what is still missing and why.

It never deletes anything and never overwrites a file that already exists,
so running it twice is safe.

    python setup_secure.py --dataset "C:\\...\\TF_Dashboard_Dataset.xlsx"
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

# The workbook holds several kinds of sheet. Only two kinds move into the
# secure folder as files: the EAC sheets (all of them - the list is not
# cumulative, so the dashboard unions every one) and the register.
#
# The treatment sheets deliberately do NOT come across. The pipeline needs
# `pepId` and `datimCode` to build the vault key, and those columns were
# removed from the workbook by hand. The raw weekly export has them; that is
# what the pipeline reads from now on.
REGISTER_SHEET = "Total Unsuppressed"
EAC_PREFIX = "EAC"
TREAT_PREFIX = "Treatment"

INI = """\
# Written by setup_secure.py. Edit if your paths differ.
#
# Keep this file, and everything it points at, OUTSIDE the repository folder.

[paths]
vault    = {root}\\vault\\SN_Key.xlsx
backups  = {root}\\vault\\backups

treatment = {root}\\incoming\\ECEWS_Treatment_Linelist.xlsx
# A glob: every EAC sheet must be carried forward, not just the newest.
eac       = {root}\\incoming\\eac\\*.xlsx

register = {root}\\Total_Unsuppressed.xlsx

output = {root}\\output
logs   = {root}\\logs

# Uncomment and fill in to have the run end with the dashboard refreshed.
# Until then the run stops after writing the parquet, and you upload it
# yourself on the Admin tab - which is the safer way to start.
#
# [upload]
# base_url = https://your-ecews-host
# username = pipeline
# password = set-a-real-one
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, type=Path,
                    help="the existing TF_Dashboard_Dataset.xlsx")
    ap.add_argument("--root", type=Path, default=Path(r"C:\ECEWS_Secure"),
                    help="secure folder to create (default C:\\ECEWS_Secure)")
    a = ap.parse_args()

    if not a.dataset.exists():
        print(f"  dataset not found: {a.dataset}")
        return 1

    root = a.root
    print(f"\n  secure folder: {root}")
    for sub in ("vault", "vault/backups", "incoming", "incoming/eac",
                "output", "logs"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    print("  folders created\n")

    xl = pd.ExcelFile(a.dataset)
    eac = [s for s in xl.sheet_names if s.startswith(EAC_PREFIX)]
    treat = [s for s in xl.sheet_names if s.startswith(TREAT_PREFIX)]

    # Splitting a large workbook is slow - minutes, not seconds. Say so, and
    # report each sheet as it lands so a long run does not look like a hang.
    print(f"  splitting {len(eac)} EAC sheet(s) + the register out of the")
    print("  workbook. This reads a very large file - expect several minutes.\n")

    written, skipped = 0, 0
    jobs = [(s, root / "incoming" / "eac" / f"{s}.xlsx") for s in eac]
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
        ini.write_text(INI.format(root=str(root)), encoding="utf8")
        print(f"\n  wrote {ini}")

    print(f"\n  {written} file(s) written, {skipped} left alone")

    # What the user still has to supply by hand. Both are things only they
    # can provide, so be explicit rather than letting the pipeline fail later
    # with a stack trace.
    print("\n  STILL NEEDED before the first run:")
    print(f"    1. the vault  ->  {root}\\vault\\SN_Key.xlsx")
    print("       Copy it from wherever you keep it offline. Without it the")
    print("       pipeline mints new keys for everyone and the cohort loses")
    print("       its history.")
    print(f"    2. the raw treatment export  ->  {root}\\incoming\\ECEWS_Treatment_Linelist.xlsx")
    print("       It must still have pepId and datimCode. The copy in the")
    print(f"       workbook does not ({len(treat)} treatment sheet(s) found, none moved).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
