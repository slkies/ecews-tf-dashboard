"""Resolve identities that the vault maps to two different S/Ns.

A one-time correction, kept separate from deidentify.py deliberately: that
script refuses to run on an ambiguous vault, and that refusal is worth keeping
absolute. Repairing the vault should be something you choose to do, with a
backup and a record of what changed - not something that happens quietly
inside a routine run.

    python resolve_vault_duplicates.py --config secure.ini --dry-run
    python resolve_vault_duplicates.py --config secure.ini

WHICH S/N IS KEPT

  1. If exactly one of the two appears anywhere in the data we republish -
     the EAC sheets or the register - that one is kept. History decides;
     dropping a key that is in use would orphan those rows.

  2. Otherwise the EARLIEST ART start date is kept. This is not a guess: of
     the 93 ambiguous identities in the current vault, 15 are settled by rule
     1, and in 14 of those the surviving key is the earlier enrolment. The
     original registration is the one that stayed in use.

  3. If BOTH appear in the published data the script refuses. That is a real
     conflict - the same identity genuinely carried as two clients with
     separate histories - and merging it would silently fuse two people.
     There are none of these today; the check is there for the next vault.

The losing rows are written to SN_Key-MERGED.csv, and the vault is backed up
before anything is rewritten.
"""
from __future__ import annotations

import argparse
import configparser
import datetime as dt
import shutil
import sys
from pathlib import Path

import pandas as pd

KEY = "S/N"
VAULT_NEW = "Datim_PEPID"


def in_use_keys(cfg) -> set[str]:
    """Every S/N appearing in the sheets that get republished."""
    P = cfg["paths"]
    paths: list[Path] = []
    spec = P["eac"]
    paths += sorted(Path(spec).parent.glob(Path(spec).name)) \
        if any(c in spec for c in "*?[") else [Path(spec)]
    reg = Path(P["register"])
    if reg.exists():
        paths.append(reg)

    used: set[str] = set()
    for p in paths:
        s = pd.read_excel(p, dtype=str, usecols=[KEY])[KEY]
        s = s.astype(str).str.strip()
        used |= set(s.dropna())
        print(f"    {p.name:36s} {len(s):>8,} rows")
    return used


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the decisions; change nothing")
    a = ap.parse_args()

    cfg = configparser.ConfigParser()
    cfg.read(a.config)
    vpath = Path(cfg["paths"]["vault"])

    v = pd.read_excel(vpath, dtype=str)
    v["_k"] = v[VAULT_NEW].astype("string").str.strip().str.upper()
    counts = v.groupby("_k")[KEY].nunique()
    amb = set(counts[counts > 1].index)
    if not amb:
        print("  nothing ambiguous in this vault - nothing to do")
        return 0
    print(f"\n  {len(v):,} vault rows, {len(amb):,} ambiguous identit(ies)\n")

    print("  reading the sheets that get republished:")
    used = in_use_keys(cfg)
    print(f"    {len(used):,} distinct S/N in use\n")

    v["_use"] = v[KEY].astype(str).str.strip().isin(used)
    v["_d"] = pd.to_datetime(v.get("artStartDate"), errors="coerce")

    keep_idx, drop_idx, conflicts = [], [], []
    by_history = by_date = 0
    for k, g in v[v["_k"].isin(amb)].groupby("_k"):
        live = g[g["_use"]]
        if len(live) > 1:
            conflicts.append(k)
            continue
        if len(live) == 1:
            winner = live.index[0]
            by_history += 1
        else:
            # Earliest enrolment. NaT sorts last so a dated row always beats
            # an undated one; the index tie-break keeps this deterministic.
            winner = g.sort_values("_d", kind="stable",
                                   na_position="last").index[0]
            by_date += 1
        keep_idx.append(winner)
        drop_idx += [i for i in g.index if i != winner]

    if conflicts:
        rep = vpath.parent / f"{vpath.stem}-CONFLICT.csv"
        v[v["_k"].isin(conflicts)].drop(columns=["_k", "_use", "_d"]) \
            .to_csv(rep, index=False)
        print(f"  {len(conflicts)} identit(ies) have BOTH S/Ns in use in the published")
        print(f"  data. Merging them would fuse two separate histories into one.")
        print(f"  Listed in {rep.name}. Resolve these by hand first - nothing written.")
        return 1

    print(f"  decided by history (one S/N already in use): {by_history:>3}")
    print(f"  decided by earliest ART start date         : {by_date:>3}")
    print(f"  rows to drop                               : {len(drop_idx):>3}\n")

    dropped = v.loc[drop_idx].drop(columns=["_k", "_use", "_d"])
    kept = v.drop(index=drop_idx).drop(columns=["_k", "_use", "_d"])

    if a.dry_run:
        print(f"  dry run - vault untouched. Would go from {len(v):,} to {len(kept):,} rows.")
        print("\n  example decision:")
        k = sorted(amb)[0]
        ex = v[v["_k"] == k][[c for c in ("facilityName", VAULT_NEW, KEY,
                                          "artStartDate") if c in v.columns]]
        ex = ex.assign(decision=["KEEP" if i in keep_idx else "drop"
                                 for i in v[v["_k"] == k].index])
        print(ex.to_string(index=False))
        return 0

    backups = Path(cfg["paths"]["backups"])
    backups.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    pre = backups / f"{vpath.stem}-PRE-DEDUPE-{stamp}.xlsx"
    shutil.copy2(vpath, pre)
    print(f"  vault backed up as {pre.name}")

    rec = vpath.parent / f"{vpath.stem}-MERGED.csv"
    dropped.to_csv(rec, index=False)
    print(f"  dropped rows recorded in {rec.name}")

    kept.to_excel(vpath, index=False)
    print(f"  vault rewritten: {len(v):,} -> {len(kept):,} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
