"""Describe a raw export WITHOUT revealing anything about a patient.

The source keeps changing shape - dob became DOB, lga became LGA, patientId
became patient_id - and each change needed someone to look at the file. Looking
at a raw export means looking at patients, so this prints the shape and nothing
else: column names, how many rows carry a value, how many distinct values, and
date ranges for date columns.

It never prints a cell. Not one, not as an example, not truncated. For columns
that could identify a person it does not even print a distinct count, because
"180,433 distinct" on a name column tells you something about the cohort.

    python inspect_export.py --config secure.ini --which treatment
    python inspect_export.py --config secure.ini --which eac

Output is safe to paste into a chat, an email, or a ticket.
"""
from __future__ import annotations

import argparse
import configparser
import sys
import warnings
from pathlib import Path

import pandas as pd

# pandas warns once per column that it could not infer a date format.
# On a 130-column export that buries the table this script exists to
# print - and output nobody can read is output nobody checks.
warnings.filterwarnings("ignore", category=UserWarning)

sys.path.insert(0, str(Path(__file__).parent))
from deidentify import (EAC_PII_COLUMNS, PII_COLUMNS,  # noqa: E402
                        SENSITIVE_COLUMNS, norm_col, read_excel_any)

# Anything matching these is described by presence only - never counted,
# never sampled. Broader than the removal list on purpose: this is about what
# gets shown to a human, so it errs towards saying less.
SENSITIVE_HINTS = ("name", "surname", "first", "phone", "address", "dob",
                   "birth", "pep", "datim", "hospital", "unique", "patient",
                   "nin", "email", "contact", "next of kin", "guardian")


def sensitive(col: object) -> bool:
    n = norm_col(col)
    if n in {norm_col(c) for c in PII_COLUMNS + SENSITIVE_COLUMNS + EAC_PII_COLUMNS}:
        return True
    return any(h.replace(" ", "") in n for h in SENSITIVE_HINTS)


def describe(df: pd.DataFrame, label: str) -> None:
    print(f"\n  {label}")
    print(f"  {len(df):,} rows x {len(df.columns)} columns\n")
    print(f"  {'column':<40} {'filled':>9} {'distinct':>10}  notes")
    print(f"  {'-'*40} {'-'*9} {'-'*10}  {'-'*28}")
    for c in df.columns:
        s = df[c]
        filled = int(s.notna().sum())
        if sensitive(c):
            print(f"  {str(c)[:40]:<40} {filled:>9,} {'-':>10}  IDENTIFIER - not described")
            continue
        note = ""
        d = pd.to_datetime(s, errors="coerce")
        if d.notna().sum() > len(s) * 0.5 and d.notna().any():
            note = f"dates {d.min():%Y-%m-%d} to {d.max():%Y-%m-%d}"
        else:
            n = pd.to_numeric(s, errors="coerce")
            if n.notna().sum() > len(s) * 0.5 and n.notna().any():
                note = f"numeric, median {n.median():,.0f}"
        print(f"  {str(c)[:40]:<40} {filled:>9,} {s.nunique():>10,}  {note}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--which", choices=("treatment", "eac", "register"),
                    default="treatment")
    ap.add_argument("--all", action="store_true",
                    help="describe every file matching, not just the newest. "
                         "Each one has to be decrypted, so this is slow.")
    a = ap.parse_args()

    cfg = configparser.ConfigParser()
    cfg.read(a.config)
    P = cfg["paths"]
    S = cfg["secrets"] if cfg.has_section("secrets") else {}
    spec = P[a.which]
    pw_key = f"{a.which}_password"

    paths = sorted(Path(spec).parent.glob(Path(spec).name),
                   key=lambda p: p.stat().st_mtime, reverse=True) \
        if any(c in spec for c in "*?[") else [Path(spec)]
    if not paths:
        raise SystemExit(f"nothing matched {spec}")
    # Newest only unless asked otherwise: describing six EAC files means
    # decrypting six EAC files, and the newest is what changed shape.
    if not a.all:
        paths = paths[:1]

    print(f"\n  Shape only. No cell value from these files is printed.")
    for p in paths:
        df = read_excel_any(p, S.get(pw_key), key=pw_key, dtype=str)
        describe(df, p.name)
    print("\n  Safe to share.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
