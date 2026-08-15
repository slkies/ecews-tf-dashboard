"""Recover the EAC rows that carry no S/N.

307 rows across the five EAC sheets have a blank S/N. They are not corrupt -
every other column is populated - they simply lost the key when the sheet was
de-identified by hand. Without it the pipeline has to drop them, and a client
in an EAC cycle disappears from the cascade as though they were never enrolled.

They can be matched back. The treatment list carries facilityName, dob,
artStartDate and sex alongside datimCode and pepId, and the EAC sheets carry
the same four fields. Where that combination identifies exactly ONE client in
the treatment list, the identity is recovered and the S/N filled in from the
vault.

    python recover_unkeyed_eac.py --config secure.ini --dry-run
    python recover_unkeyed_eac.py --config secure.ini

Only unique matches are used. A signature matching two or more clients is left
alone - guessing would attach one patient's viral loads to another, which is
worse than a dropped row. Anything not recovered is written to
EAC_UNRECOVERED.csv with its sheet name, so it can be looked up by hand in the
original export.

Run this BEFORE the key migration, so the recovered rows carry the same keys
as the rest of the sheet and migrate with them. It also works afterwards - the
pipeline recognises rows already on current keys - but before is tidier.
"""
from __future__ import annotations

import argparse
import configparser
import datetime as dt
import shutil
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from deidentify import (KEY, VAULT_NEW, build_key, norm_key,  # noqa: E402
                        read_excel_any)

# The four fields both exports carry, and the name each uses for them.
TREAT_FIELDS = ["facilityName", "dob", "artStartDate", "sex"]
EAC_FIELDS = ["FacilityName", "DOB", "ART_Start_Date", "Sex"]


def signature(df: pd.DataFrame, fields: list[str]) -> pd.Series:
    """facility | DOB | ART start | sex, normalised so the two exports agree."""
    fac, dob, art, sex = fields
    return (df[fac].astype("string").str.strip().str.upper() + "|"
            + pd.to_datetime(df[dob], errors="coerce").dt.strftime("%Y-%m-%d") + "|"
            + pd.to_datetime(df[art], errors="coerce").dt.strftime("%Y-%m-%d") + "|"
            + df[sex].astype("string").str.strip().str.upper().str[:1])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be recovered; change nothing")
    a = ap.parse_args()

    cfg = configparser.ConfigParser()
    cfg.read(a.config)
    P = cfg["paths"]
    S = cfg["secrets"] if cfg.has_section("secrets") else {}

    vault = pd.read_excel(Path(P["vault"]), dtype=str)
    vlut = dict(zip(norm_key(vault[VAULT_NEW]), vault[KEY].astype(str)))
    print(f"\n  vault: {len(vlut):,} identities")

    print("  reading the treatment list...")
    t = read_excel_any(Path(P["treatment"]), S.get("treatment_password"), dtype=str)
    missing = [c for c in TREAT_FIELDS if c not in t.columns]
    if missing:
        raise SystemExit(f"treatment list has no {missing} - cannot match")

    t["_m"] = signature(t, TREAT_FIELDS)
    counts = t["_m"].value_counts()
    # Unique signatures only. A signature shared by two clients cannot identify
    # either of them, and attaching the wrong S/N would file one patient's
    # viral loads under another.
    unique = set(counts[counts == 1].index)
    shared = set(counts[counts > 1].index)
    lut = t[t["_m"].isin(unique)].set_index("_m")[["datimCode", "pepId"]]
    print(f"  {len(t):,} rows, {len(unique):,} unique signatures, "
          f"{len(shared):,} shared\n")

    # Keys recovered by hand, if the sheet has been filled in and saved. The
    # CSV this script writes carries an empty Datim_PEPID column and the row
    # number, so looking a client up in the original export and pasting the
    # code back in is all that is needed - no editing of the EAC sheets.
    report = Path(P["register"]).parent / "EAC_UNRECOVERED.csv"
    supplied: dict[str, dict[int, str]] = {}
    if report.exists():
        prev = pd.read_csv(report, dtype=str)
        if "Datim_PEPID" in prev.columns and "row" in prev.columns:
            filled = prev[prev["Datim_PEPID"].notna()
                          & prev["Datim_PEPID"].astype(str).str.strip().ne("")]
            for sheet, g in filled.groupby("EAC_sheet"):
                supplied[sheet] = dict(zip(g["row"].astype(int),
                                           g["Datim_PEPID"].astype(str).str.strip()))
            if len(filled):
                print(f"  {len(filled)} key(s) supplied by hand in {report.name}\n")

    spec = P["eac"]
    paths = sorted(Path(spec).parent.glob(Path(spec).name)) \
        if any(c in spec for c in "*?[") else [Path(spec)]

    unrecovered, total, recovered = [], 0, 0
    for p in paths:
        d = read_excel_any(p, S.get("eac_password"), dtype=str)
        sn = d[KEY].astype("string").str.strip()
        blank = sn.isna() | sn.eq("")
        if not blank.any():
            continue
        total += int(blank.sum())

        b = d[blank]
        got = 0

        # 1. Keys filled in by hand take precedence. Looking the client up in
        #    the original export and reading off their Datim_PEPID is the most
        #    reliable evidence available - better than any inference from
        #    matching fields - so it wins wherever it is supplied.
        for i, key in supplied.get(p.stem, {}).items():
            if i not in b.index:
                continue
            hit = vlut.get(norm_key(pd.Series([key])).iloc[0])
            if hit:
                d.loc[i, KEY] = hit
                got += 1
            else:
                print(f"      row {i}: {key} is not in the vault - check the code")

        # 2. Then infer the rest from facility + DOB + ART start + sex.
        still = [i for i in b.index
                 if not isinstance(d.loc[i, KEY], str) or not d.loc[i, KEY].strip()]
        sig = signature(b.loc[still], EAC_FIELDS)
        for i, s in zip(still, sig):
            if s not in unique:
                continue
            row = lut.loc[s]
            k = norm_key(build_key(pd.Series([row["datimCode"]]),
                                   pd.Series([row["pepId"]]))).iloc[0]
            hit = vlut.get(k)
            if hit:
                d.loc[i, KEY] = hit
                got += 1
        recovered += got

        left = b.loc[[i for i in b.index
                      if not isinstance(d.loc[i, KEY], str) or not d.loc[i, KEY].strip()]]
        if len(left):
            keep = [c for c in ("State", "LGA", "FacilityName", "PatientHospitalNo",
                                "Sex", "DOB", "ART_Start_Date", "Current_Regimen",
                                "Current_High_VL_Value", "First_High_VL_Value")
                    if c in left.columns]
            out = left[keep].copy()
            out.insert(0, "row", left.index)
            out.insert(0, "EAC_sheet", p.stem)
            # Left empty on purpose: look the client up in the original export,
            # paste their code here, save, and run this script again.
            out.insert(2, "Datim_PEPID",
                       [supplied.get(p.stem, {}).get(i, "") for i in left.index])
            out["why"] = [("signature matches several clients"
                           if s in shared else "not found in the treatment export")
                          for s in signature(left, EAC_FIELDS)]
            unrecovered.append(out)

        print(f"  {p.stem:28s} {int(blank.sum()):>4} unkeyed -> "
              f"{got:>4} recovered, {int(blank.sum()) - got:>3} left")

        if not a.dry_run and got:
            backups = Path(P["backups"])
            backups.mkdir(parents=True, exist_ok=True)
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.copy2(p, backups / f"{p.stem}-PRE-RECOVERY-{stamp}.xlsx")
            d.to_excel(p, index=False)

    print(f"\n  {total} unkeyed row(s), {recovered} recovered "
          f"({recovered / total:.0%})" if total else "\n  nothing unkeyed")

    if unrecovered:
        allrows = pd.concat(unrecovered, ignore_index=True)
        # Written even on a dry run: it is a report, not a change to the data,
        # and it is the thing needed to do the manual lookup in the first place.
        allrows.to_csv(report, index=False)
        print(f"  {len(allrows)} left over, listed in {report.name}")
        print("\n  why they could not be matched:")
        for why, n in allrows["why"].value_counts().items():
            print(f"    {n:>4}  {why}")

    if a.dry_run:
        print("\n  dry run - no sheet was modified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
