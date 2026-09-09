"""Why did the key check fall, and are these clients really new?

A run that mints keys for clients who already have one severs them from their
own history, and nothing downstream reports an error - the cohort simply looks
partly new. So when `key check` drops or the new-client count jumps, the
question is always the same: is this a real intake, or is the export writing
the same people a different way?

This answers it without printing a single identifier. Everything below is a
count, a length, or a pattern class.

    python diagnose_key.py --config secure.ini

Output is safe to paste into a chat or a ticket.
"""
from __future__ import annotations

import argparse
import configparser
import re
import sys
import warnings
from collections import Counter
from pathlib import Path

import pandas as pd

warnings.filterwarnings("ignore", category=UserWarning)

sys.path.insert(0, str(Path(__file__).parent))
from deidentify import (KEY, VAULT_NEW, build_key,  # noqa: E402
                        norm_key, read_excel_any)


def shape(v: str) -> str:
    """A value reduced to its character classes. 'DEL048' -> 'AAA999'.

    Enough to see that one export writes 11 characters where another writes 12,
    or that padding has appeared, without carrying anything that identifies a
    person.
    """
    out = []
    for ch in str(v):
        out.append("9" if ch.isdigit() else "A" if ch.isalpha() else ch)
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    a = ap.parse_args()
    cfg = configparser.ConfigParser()
    cfg.read(a.config)
    P = cfg["paths"]
    S = cfg["secrets"] if cfg.has_section("secrets") else {}

    print("\n  Counts and shapes only. No identifier is printed.\n")

    vault = read_excel_any(Path(P["vault"]), S.get("vault_password"),
                           key="vault_password", dtype=str)
    known = set(norm_key(vault[VAULT_NEW]).dropna())
    print(f"  vault: {len(vault):,} rows, {len(known):,} distinct keys")

    spec = P["treatment"]
    paths = sorted(Path(spec).parent.glob(Path(spec).name),
                   key=lambda p: p.stat().st_mtime, reverse=True) \
        if any(c in spec for c in "*?[") else [Path(spec)]
    t = read_excel_any(paths[0], S.get("treatment_password"),
                       key="treatment_password", dtype=str)
    print(f"  export: {paths[0].name}")
    print(f"          {len(t):,} rows x {len(t.columns)} columns\n")

    datim, pep = t["datimCode"], t["pepId"]
    built = norm_key(build_key(datim, pep))
    matched = built.isin(known)
    print(f"  key check: {matched.mean():.1%} matched  "
          f"({int((~matched).sum()):,} unmatched)\n")

    # ── is the difference formatting, or are these new people? ────────
    # Strip everything that is not a letter or digit and compare again. If the
    # unmatched suddenly match, the export changed how it writes the code and
    # these are existing clients about to be issued a second key.
    loose_known = {re.sub(r"[^A-Z0-9]", "", k) for k in known}
    loose_built = built.map(lambda v: re.sub(r"[^A-Z0-9]", "", str(v)))
    recovered = (~matched) & loose_built.isin(loose_known)
    print("  UNMATCHED ROWS, explained")
    print(f"    would match ignoring punctuation/spacing : {int(recovered.sum()):,}")
    print(f"    still unmatched (a genuinely new key)    : "
          f"{int(((~matched) & ~recovered).sum()):,}\n")

    # ── new facility, or new clients at existing facilities? ──────────
    # A DATIM code the vault has never seen is a site joining the programme,
    # and its clients are legitimately new. Existing sites suddenly producing
    # hundreds of new clients are not.
    # The code precedes the PEPID in the key, but its width is not ours to
    # assume - it has changed before, and a hard-coded slice quietly reports
    # every site as new. Cut the vault keys at whatever widths this export
    # actually uses, and compare upper-cased: norm_key upper-cases the vault,
    # the export does not, so a raw comparison never matches.
    unm = t[~matched.values]
    if len(unm):
        d_all = t["datimCode"].astype("string").str.strip().str.upper()
        widths = set(d_all.dropna().str.len())
        vault_datims = {k[:n] for k in known for n in widths}
        d_unm = unm["datimCode"].astype("string").str.strip().str.upper()
        new_site = ~d_unm.isin(vault_datims)
        print("  WHERE THE UNMATCHED SIT")
        print(f"    at DATIM codes the vault has never seen : {int(new_site.sum()):,}")
        print(f"    at codes the vault already knows        : {int((~new_site).sum()):,}")
        print(f"    distinct new DATIM codes                : {d_unm[new_site].nunique():,}")
        print(f"    distinct known DATIM codes involved     : {d_unm[~new_site].nunique():,}\n")

    # ── the export's own concatenation vs the one we build ────────────
    if VAULT_NEW in t.columns:
        given = norm_key(t[VAULT_NEW])
        diff = (given != built) & given.notna() & built.notna()
        print(f"  EXPORT'S OWN {VAULT_NEW} vs datimCode+pepId")
        print(f"    disagreeing rows: {int(diff.sum()):,}")
        if int(diff.sum()):
            g, b = given[diff], built[diff]
            same_loose = (g.map(lambda v: re.sub(r"[^A-Z0-9]", "", str(v)))
                          == b.map(lambda v: re.sub(r"[^A-Z0-9]", "", str(v))))
            print(f"      differ only by punctuation/spacing : {int(same_loose.sum()):,}")
            print(f"      differ in substance               : "
                  f"{int((~same_loose).sum()):,}")
            print(f"      export value longer               : "
                  f"{int((g.str.len() > b.str.len()).sum()):,}")
            print(f"      export value shorter              : "
                  f"{int((g.str.len() < b.str.len()).sum()):,}")
        print()

    # ── shapes, to see a format change at a glance ────────────────────
    for label, col in (("datimCode", datim), ("pepId", pep)):
        s = col.astype("string").dropna()
        pad = int((s != s.str.strip()).sum())
        print(f"  {label}: {s.nunique():,} distinct, "
              f"{pad:,} with leading/trailing spaces")
        top = Counter(s.str.strip().map(shape)).most_common(4)
        for pat, n in top:
            print(f"    {pat:<18} {n:>8,}")
        print()

    print("  Safe to share.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
