#!/usr/bin/env python3
"""
Raw export -> de-identified dashboard dataset, in one run.

    python deidentify.py --config secure.ini
    python deidentify.py --config secure.ini --dry-run     # change nothing

WHAT THIS REPLACES

The de-identification was done by hand: look each client up in SN_Key.xlsx,
carry the S/N across, delete the columns holding names, phone numbers and
identifiers, then convert. That worked, but a manual step is a step that can be
skipped - and checking the last export showed exactly that. `uniqueId`, a
stable per-patient key, and `dob`, a full date of birth, were still present in
a file that had been treated as de-identified. Neither reached the dashboard
database, which stores only its own derived columns, but both were in the file.

That is the case for automating this: not effort, but the fact that a script
checks every column every time and refuses to publish when something is wrong.

THE THREE RULES THIS SCRIPT WILL NOT BREAK

1. An existing client NEVER receives a new S/N. Their key is looked up, never
   regenerated. Regenerating would silently sever every client from their own
   history, and nothing downstream would report an error - the cohort would
   simply appear to be all-new.

2. The vault is backed up before it is written, every run. It is the only thing
   linking a dashboard record to a patient. Lose it and no worklist can ever be
   acted on again, and the next run mints new keys for everyone.

3. Validation FAILS CLOSED. If a prohibited column survives, or a client ends
   up without a key, nothing is written. A pipeline that publishes when unsure
   is worse than one that stops.
"""
from __future__ import annotations

import argparse
import configparser
import datetime as dt
import io
import logging
import re
import secrets
import shutil
import sys
import zipfile
from pathlib import Path

import pandas as pd

log = logging.getLogger("deid")

# ── what must never leave the secure environment ──────────────────────
# Direct identifiers, plus the two that survived the manual process.
PII_COLUMNS = [
    "patientId", "pepId", "Datim_PEPID", "PEPID_Datim", "patientHospitalNo",
    "previousId", "surname", "firstname", "phoneNo", "address",
    "uniqueId", "uniquePatientId", "dob",
]
# Not identifying, but sensitive and unused by the dashboard.
SENSITIVE_COLUMNS = ["causeOfDeath", "vaCauseOfDeath", "facilityTransferredTo"]

# The EAC export is already keyed on S/N; only the date of birth needs removing.
EAC_PII_COLUMNS = ["DOB"]

KEY = "S/N"
VAULT_NEW = "Datim_PEPID"      # current ordering, matches the line list
VAULT_OLD = "PEPID_Datim"      # retained for historical continuity
LEGACY = "S/N_legacy"          # the pre-migration key - see migrate_keys()


def norm_key(s: pd.Series) -> pd.Series:
    """Upper-case and strip. A key differing only by case or padding is the
    same patient, and treating it otherwise mints a duplicate S/N."""
    return s.astype("string").str.strip().str.upper()


def new_sn() -> str:
    """
    Cryptographically secure, unguessable, and not enumerable.

    Existing keys are random decimals - fine for uniqueness but they collide at
    eight decimal places, which is why S/N is carried as text everywhere. New
    keys are hex tokens, so old and new are distinguishable on sight during the
    transition. Both are opaque to the dashboard, which never interprets them.
    """
    return secrets.token_hex(16)


# ── vault ─────────────────────────────────────────────────────────────
class Vault:
    """The identity mapping. Read, extended, written back with a backup."""

    def __init__(self, path: Path):
        self.path = path
        self.df = pd.read_excel(path, dtype=str)
        for col in (VAULT_NEW, KEY):
            if col not in self.df.columns:
                raise SystemExit(
                    f"{path.name} has no '{col}' column. Found: "
                    f"{', '.join(self.df.columns)}")
        self.df["_k"] = norm_key(self.df[VAULT_NEW])
        dupes = self.df["_k"].duplicated().sum()
        if dupes:
            raise SystemExit(
                f"{path.name} maps {dupes} key(s) to more than one S/N. "
                "That is ambiguous and must be resolved by hand before any "
                "run - the script will not guess which mapping is correct.")
        self.lookup = dict(zip(self.df["_k"], self.df[KEY]))
        self.added: list[dict] = []
        log.info("vault: %s existing mappings", f"{len(self.lookup):,}")

    def resolve(self, keys: pd.Series) -> pd.Series:
        """Existing keys are reused; unseen ones get a new S/N."""
        k = norm_key(keys)
        out = k.map(self.lookup)
        missing = out.isna() & k.notna()
        for key in k[missing].dropna().unique():
            sn = new_sn()
            self.lookup[key] = sn
            # Write both orderings. The vault is the only record of who a key
            # belongs to, and leaving the legacy column blank on new rows would
            # make it progressively less usable for anyone reading it directly.
            datim, _, pep = key.partition("_")
            self.added.append({VAULT_NEW: key,
                               VAULT_OLD: f"{pep}_{datim}" if pep else None,
                               KEY: sn})
        if len(self.added):
            out = k.map(self.lookup)
            log.info("vault: %s new client(s) assigned a key", f"{len(self.added):,}")
        return out

    def legacy_map(self) -> dict[str, str]:
        """
        Old key -> new key. Not a convenience: the EAC export carries S/N but
        neither pepId nor datimCode, so once keys are migrated the ONLY way to
        re-key that sheet is through this mapping. Losing the legacy column
        would orphan every EAC record.
        """
        if LEGACY not in self.df.columns:
            return {}
        d = self.df.dropna(subset=[LEGACY])
        return dict(zip(d[LEGACY].astype(str).str.strip(), d[KEY].astype(str)))

    def migrate_keys(self, backup_dir: Path, dry_run: bool) -> int:
        """
        Issue every existing client a new cryptographically secure key, once.

        The old key moves to S/N_legacy and stays there permanently. Two things
        depend on it: re-keying the EAC export, which has no other identifier,
        and resolving worklists already distributed under the old key.

        What this DOES break, unavoidably: snapshots already in the dashboard
        are keyed on the old value, so the comparison page cannot match
        episodes across the migration boundary. It will read as though the
        entire cohort was replaced. Snapshots either side remain internally
        correct, and every comparison after this point works normally.
        """
        if LEGACY in self.df.columns and self.df[LEGACY].notna().any():
            raise SystemExit(
                "Keys have already been migrated - S/N_legacy is populated. "
                "Running again would issue a SECOND new key to every client "
                "and orphan everything issued under the first.")

        n = len(self.df)
        log.warning("KEY MIGRATION: issuing a new key to all %s clients", f"{n:,}")
        if dry_run:
            log.warning("  dry run - vault untouched")
            return n

        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        pre = backup_dir / f"{self.path.stem}-PRE-MIGRATION-{stamp}.xlsx"
        shutil.copy2(self.path, pre)
        log.warning("  pre-migration vault saved as %s", pre.name)

        self.df[LEGACY] = self.df[KEY]
        self.df[KEY] = [new_sn() for _ in range(n)]
        if self.df[KEY].duplicated().any():        # 128-bit, but check anyway
            raise SystemExit("generated a duplicate key - aborting")
        self.lookup = dict(zip(self.df["_k"], self.df[KEY]))

        tmp = self.path.with_suffix(".tmp.xlsx")
        self.df.drop(columns=["_k"]).to_excel(tmp, index=False)
        tmp.replace(self.path)
        log.warning("  %s clients re-keyed; old keys kept in %s", f"{n:,}", LEGACY)
        return n

    def save(self, backup_dir: Path) -> None:
        if not self.added:
            log.info("vault: unchanged, nothing to write")
            return
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(self.path, backup_dir / f"{self.path.stem}-{stamp}.xlsx")
        merged = pd.concat([self.df.drop(columns=["_k"]),
                            pd.DataFrame(self.added)], ignore_index=True)
        # Write beside the original and swap, so an interrupted write cannot
        # leave a half-written vault where the real one used to be.
        tmp = self.path.with_suffix(".tmp.xlsx")
        merged.to_excel(tmp, index=False)
        tmp.replace(self.path)
        log.info("vault: %s rows written, backup kept", f"{len(merged):,}")


# ── validation: the gate before anything is published ─────────────────
def validate(sheets: dict[str, pd.DataFrame]) -> list[str]:
    """Every reason this dataset must not be published. Empty list = safe."""
    problems: list[str] = []
    banned = {c.lower() for c in PII_COLUMNS + SENSITIVE_COLUMNS + EAC_PII_COLUMNS}

    for name, df in sheets.items():
        for col in df.columns:
            if str(col).lower() in banned:
                problems.append(f"{name}: prohibited column '{col}' still present")
        if KEY not in df.columns:
            problems.append(f"{name}: no '{KEY}' column")
            continue
        sn = df[KEY].astype("string")
        if sn.isna().any() or sn.str.strip().eq("").any():
            n = int(sn.isna().sum() + sn.str.strip().eq("").sum())
            problems.append(f"{name}: {n:,} row(s) have no {KEY}")
        # A stray identifier that slipped in under a name not on the list.
        for col in df.columns:
            lower = str(col).lower()
            if any(w in lower for w in ("surname", "firstname", "phone",
                                        "address", "hospitalno")):
                problems.append(f"{name}: '{col}' looks like an identifier")
    return problems


def check_key_collisions(df: pd.DataFrame) -> None:
    """
    A PEPID appearing under two DATIM codes proves the facility code is load
    bearing. Collapsing the key to pepId alone would merge two patients into
    one S/N - one person's viral loads recorded against another.
    """
    if not {"pepId", "datimCode"} <= set(df.columns):
        return
    g = df.dropna(subset=["pepId"]).groupby("pepId")["datimCode"].nunique()
    shared = int((g > 1).sum())
    if shared:
        log.warning("%s PEPID(s) appear under more than one DATIM code - the "
                    "facility code is REQUIRED in the key", f"{shared:,}")
    else:
        log.info("no PEPID appears under two DATIM codes in this export")


# ── register: newly unsuppressed clients ──────────────────────────────
def append_new_unsuppressed(register: pd.DataFrame, treat: pd.DataFrame,
                            vl_threshold: int = 1000) -> tuple[pd.DataFrame, int]:
    """
    Add active clients whose viral load came back at or above the threshold
    AFTER the register's current coverage date.

    Episodes are keyed on (S/N, result date, value), never on S/N alone: a
    client who re-suppresses and fails again is a NEW episode and one of the
    highest-priority switch candidates. De-duplicating on the person would
    quietly discard exactly those.
    """
    date_col = "dateResultReceivedFacility"
    if date_col not in treat.columns:
        raise SystemExit(f"treatment list has no '{date_col}' column")

    reg_dates = pd.to_datetime(register.get(date_col), errors="coerce")
    watermark = reg_dates.max() if reg_dates.notna().any() else pd.NaT
    log.info("register covers results received up to %s",
             watermark.date() if pd.notna(watermark) else "(empty register)")

    vl = pd.to_numeric(treat.get("currentViralLoad"), errors="coerce")
    got = pd.to_datetime(treat[date_col], errors="coerce")
    active = treat.get("currentArtStatus", pd.Series("", index=treat.index)) \
        .astype("string").str.strip().str.lower().eq("active")

    fresh = got > watermark if pd.notna(watermark) else got.notna()
    cand = treat[active & (vl >= vl_threshold) & fresh].copy()

    # A late-arriving result dated before the watermark would be skipped in
    # silence; say so rather than let it vanish.
    late = int((active & (vl >= vl_threshold) & got.notna() &
                (got <= watermark)).sum()) if pd.notna(watermark) else 0
    if late:
        log.warning("%s unsuppressed result(s) dated on or before the "
                    "watermark were NOT appended - late facility reporting?",
                    f"{late:,}")

    if cand.empty:
        return register, 0

    def episode(d: pd.DataFrame) -> pd.Series:
        return (d[KEY].astype(str) + "|"
                + pd.to_datetime(d.get("dateofCurrentViralLoad"),
                                 errors="coerce").dt.strftime("%Y-%m-%d").fillna("NA")
                + "|" + pd.to_numeric(d.get("currentViralLoad"),
                                      errors="coerce").astype("string"))

    have = set(episode(register)) if len(register) else set()
    cand = cand[~episode(cand).isin(have)]
    if cand.empty:
        return register, 0

    keep = [c for c in register.columns if c in cand.columns] or list(cand.columns)
    out = pd.concat([register, cand[keep]], ignore_index=True)
    return out, len(cand)


# ── output ────────────────────────────────────────────────────────────
def to_parquet_zip(sheets: dict[str, pd.DataFrame], dest: Path) -> None:
    """One parquet per sheet, zipped. Text for anything ambiguous: parquet
    needs one type per column, and S/N in particular must stay text."""
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for name, df in sheets.items():
            out = df.copy()
            for c in out.columns:
                if out[c].dtype == "object":
                    out[c] = out[c].map(
                        lambda v: None if pd.isna(v) else str(v)).astype("string")
            buf = io.BytesIO()
            out.to_parquet(buf, index=False, compression="snappy")
            z.writestr(f"{name}.parquet", buf.getvalue())
            log.info("  %-34s %8s rows x %3d cols", name, f"{len(out):,}",
                     len(out.columns))


def upload(dest: Path, base: str, user: str, pw: str, as_of: str) -> None:
    import urllib.request as U
    import json

    def post(path, data, headers, raw=False):
        req = U.Request(base.rstrip("/") + path, data=data, headers=headers)
        with U.urlopen(req, timeout=1800) as r:
            return json.loads(r.read())

    tok = post("/api/login",
               json.dumps({"username": user, "password": pw}).encode(),
               {"Content-Type": "application/json"})["token"]
    boundary = "----deid" + secrets.token_hex(8)
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="as_of"\r\n\r\n{as_of}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{dest.name}"\r\nContent-Type: application/zip\r\n\r\n'.encode(),
        dest.read_bytes(), f"\r\n--{boundary}--\r\n".encode()])
    res = post("/api/uploads", body,
               {"Content-Type": f"multipart/form-data; boundary={boundary}",
                "Authorization": f"Bearer {tok}"})
    log.info("uploaded: %s cohort rows are now live", f"{res.get('cohort'):,}")
    for w in res.get("warnings", []):
        log.info("  note: %s", w[:160])


# ── run ───────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would happen; write nothing, upload nothing")
    ap.add_argument("--migrate-keys", action="store_true",
                    help="ONE TIME: issue every existing client a new secure key. "
                         "The old key is kept in S/N_legacy, which is then required "
                         "permanently to re-key the EAC export. Snapshots already in "
                         "the dashboard will not compare across this boundary.")
    a = ap.parse_args()

    cfg = configparser.ConfigParser()
    cfg.read(a.config)
    P, U_ = cfg["paths"], cfg["upload"] if cfg.has_section("upload") else {}

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                        datefmt="%H:%M:%S",
                        handlers=[logging.StreamHandler(sys.stdout),
                                  logging.FileHandler(Path(P["logs"]) /
                                      f"deid-{dt.date.today()}.log", encoding="utf8")])
    log.info("=" * 62)
    log.info("de-identification run%s", "  (DRY RUN)" if a.dry_run else "")

    vault = Vault(Path(P["vault"]))
    if a.migrate_keys:
        vault.migrate_keys(Path(P["backups"]), a.dry_run)

    treat = pd.read_excel(Path(P["treatment"]), dtype=str)
    log.info("treatment list: %s rows x %d cols", f"{len(treat):,}", len(treat.columns))
    check_key_collisions(treat)

    # Build the key ourselves rather than trusting the pre-built column: if the
    # export ever reverses the order, joining on it silently matches nothing and
    # every client looks new.
    if not {"pepId", "datimCode"} <= set(treat.columns):
        raise SystemExit("treatment list needs both 'pepId' and 'datimCode'")
    built = (treat["datimCode"].astype("string").str.strip() + "_"
             + treat["pepId"].astype("string").str.strip())
    if VAULT_NEW in treat.columns:
        given = norm_key(treat[VAULT_NEW])
        mismatch = int((given != norm_key(built)).sum())
        if mismatch:
            log.warning("%s row(s) where the export's %s differs from "
                        "datimCode_pepId - using the value we built",
                        f"{mismatch:,}", VAULT_NEW)
    treat[KEY] = vault.resolve(built)

    eac = pd.read_excel(Path(P["eac"]), dtype=str)
    log.info("EAC list: %s rows x %d cols", f"{len(eac):,}", len(eac.columns))

    register = pd.read_excel(Path(P["register"]), dtype=str) \
        if Path(P["register"]).exists() else treat.iloc[0:0].copy()

    # The EAC export and the register carry S/N but no pepId or datimCode, so
    # after a migration their keys are stale and can only be translated through
    # the legacy mapping. Anything that fails to translate is reported rather
    # than silently carried forward under a key that no longer means anything.
    legacy = vault.legacy_map()
    if legacy:
        for label, frame in (("EAC list", eac), ("register", register)):
            if KEY not in frame.columns or frame.empty:
                continue
            old = frame[KEY].astype("string").str.strip()
            already = old.isin(set(vault.lookup.values()))
            translated = old.map(legacy)
            stale = translated.isna() & ~already & old.notna()
            frame[KEY] = translated.where(translated.notna(), frame[KEY])
            if int(already.sum()):
                log.info("%s: %s row(s) already on current keys",
                         label, f"{int(already.sum()):,}")
            if int((~already & translated.notna()).sum()):
                log.info("%s: %s row(s) re-keyed from the legacy mapping",
                         label, f"{int((~already & translated.notna()).sum()):,}")
            if int(stale.sum()):
                log.warning("%s: %s row(s) carry a key found in neither the "
                            "current nor the legacy mapping - these clients "
                            "cannot be linked and need investigating",
                            label, f"{int(stale.sum()):,}")
    register, added = append_new_unsuppressed(register, treat)
    log.info("register: %s newly unsuppressed episode(s) appended, %s total",
             f"{added:,}", f"{len(register):,}")

    drop = PII_COLUMNS + SENSITIVE_COLUMNS
    sheets = {
        "Total Unsuppressed": register.drop(columns=drop, errors="ignore"),
        Path(P["treatment"]).stem: treat.drop(columns=drop, errors="ignore"),
        Path(P["eac"]).stem: eac.drop(columns=EAC_PII_COLUMNS, errors="ignore"),
    }

    problems = validate(sheets)
    if problems:
        log.error("VALIDATION FAILED - nothing published:")
        for p in problems:
            log.error("   %s", p)
        return 1
    log.info("validation passed: no prohibited column survives, every row keyed")

    if a.dry_run:
        log.info("dry run - vault not written, no file produced")
        return 0

    vault.save(Path(P["backups"]))
    if added:
        register.to_excel(Path(P["register"]), index=False)

    dest = Path(P["output"]) / f"TF_Dashboard_Dataset_{dt.date.today()}.parquet.zip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    to_parquet_zip(sheets, dest)
    log.info("written: %s  (%.1f MB)", dest.name, dest.stat().st_size / 1e6)

    if U_ and U_.get("base_url"):
        as_of = pd.to_datetime(treat["dateResultReceivedFacility"],
                               errors="coerce").max()
        upload(dest, U_["base_url"], U_["username"], U_["password"],
               str(as_of.date()) if pd.notna(as_of) else str(dt.date.today()))
    else:
        log.info("no upload configured - upload %s on the Admin tab", dest.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
