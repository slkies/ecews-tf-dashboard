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


def build_key(datim: pd.Series, pep: pd.Series) -> pd.Series:
    """
    The vault key: datimCode immediately followed by pepId, NO separator.

        datimCode AAA0aaAAaAA + pepId XXX00000000 -> AAA0aaAAaAAXXX00000000

    Built here rather than read from the export's own column. If an export ever
    reverses the order, joining on its column silently matches nothing, every
    client looks new, and the run mints a fresh key for all 180,000 of them.
    Building it ourselves means a format change fails loudly instead.
    """
    return (datim.astype("string").str.strip()
            + pep.astype("string").str.strip())


def read_excel_any(path: Path, password: str | None = None, **kw):
    """
    Read an .xlsx, including a password-protected one.

    The weekly export arrives encrypted - correctly so, it is raw PII. An
    encrypted workbook is an OLE2 container holding an EncryptedPackage stream,
    which pandas cannot read and which it misreports as a legacy .xls, so the
    error you get without this is about a missing 'xlrd' and tells you nothing.

    Decryption happens in memory. The plaintext is never written to disk.
    """
    with path.open("rb") as fh:
        encrypted = fh.read(8).startswith(b"\xd0\xcf\x11\xe0")
    if not encrypted:
        return pd.read_excel(path, **kw)
    if not password:
        raise SystemExit(
            f"{path.name} is password-protected. Add the password to the "
            "[secrets] section of your config:\n\n"
            "    [secrets]\n    treatment_password = ...\n\n"
            "Keep that file outside the repository - it is a real credential.")
    import msoffcrypto
    buf = io.BytesIO()
    with path.open("rb") as fh:
        office = msoffcrypto.OfficeFile(fh)
        office.load_key(password=password)
        office.decrypt(buf)
    buf.seek(0)
    log.info("%s: decrypted in memory", path.name)
    return pd.read_excel(buf, **kw)


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
        # An identity mapping to two different S/Ns is ambiguous: the same
        # person is carried as two clients, and any run would have to guess
        # which key to use. Refuse - but write out exactly which rows are
        # involved, because "resolve 91 rows by hand" is not actionable
        # without knowing which 91.
        ambiguous = self.df.groupby("_k")[KEY].nunique()
        ambiguous = ambiguous[ambiguous > 1]
        if len(ambiguous):
            report = path.parent / f"{path.stem}-AMBIGUOUS.csv"
            self.df[self.df["_k"].isin(ambiguous.index)] \
                .drop(columns=["_k"]).to_csv(report, index=False)
            raise SystemExit(
                f"{path.name} maps {len(ambiguous):,} identit(ies) to more than "
                f"one S/N - the same client carried twice.\n"
                f"The affected rows are listed in {report.name}.\n"
                "Decide for each whether it is one client (keep one S/N) or "
                "genuinely two, then correct the vault. The script will not "
                "guess which mapping is right.")
        self.lookup = dict(zip(self.df["_k"], self.df[KEY]))
        self.added: list[dict] = []
        log.info("vault: %s existing mappings", f"{len(self.lookup):,}")

    def resolve(self, datim: pd.Series, pep: pd.Series) -> pd.Series:
        """Existing clients keep their S/N; unseen ones get a new one.

        Takes the two components rather than the finished key, because the
        vault stores both orderings and there is no separator to split on -
        `datimCode + pepId` cannot be taken apart again once joined.
        """
        keys = build_key(datim, pep)
        k = norm_key(keys)
        out = k.map(self.lookup)
        missing = out.isna() & k.notna()
        # Both orderings, from the components. The vault is the only record of
        # who a key belongs to; leaving the legacy column blank on new rows
        # would make it progressively less usable for anyone reading it.
        rev = dict(zip(k[missing], norm_key(build_key(pep, datim))[missing]))
        for key in k[missing].dropna().unique():
            sn = new_sn()
            self.lookup[key] = sn
            self.added.append({VAULT_NEW: key, VAULT_OLD: rev.get(key), KEY: sn})
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
                            vl_threshold: int = 1000,
                            include_late: bool = False) -> tuple[pd.DataFrame, int]:
    """
    Add active clients whose viral load came back at or above the threshold
    AFTER the register's current coverage date.

    Episodes are keyed on (S/N, result date, value), never on S/N alone: a
    client who re-suppresses and fails again is a NEW episode and one of the
    highest-priority switch candidates. De-duplicating on the person would
    quietly discard exactly those.
    """
    # Resolve column names case-insensitively, and REQUIRE each one. These
    # exports have already renamed a column by case once (lga -> LGA). Reading
    # the ART status with .get() and a blank default meant a renamed column
    # made every client look non-active, and the run appended nobody - the
    # feature silently doing nothing, which is worse than it failing.
    def need(df: pd.DataFrame, name: str) -> pd.Series:
        lower = {str(c).strip().lower(): c for c in df.columns}
        hit = lower.get(name.lower())
        if hit is None:
            raise SystemExit(
                f"treatment list has no '{name}' column (case-insensitive). "
                f"Without it newly unsuppressed clients cannot be identified.\n"
                f"Columns present: {', '.join(map(str, df.columns))}")
        return df[hit]

    date_col = "dateResultReceivedFacility"
    got = pd.to_datetime(need(treat, date_col), errors="coerce")
    vl = pd.to_numeric(need(treat, "currentViralLoad"), errors="coerce")
    active = need(treat, "currentArtStatus") \
        .astype("string").str.strip().str.lower().eq("active")

    reg_lower = {str(c).strip().lower(): c for c in register.columns}
    reg_dates = pd.to_datetime(register.get(reg_lower.get(date_col.lower())),
                               errors="coerce")
    watermark = reg_dates.max() if reg_dates.notna().any() else pd.NaT
    log.info("register covers results received up to %s",
             watermark.date() if pd.notna(watermark) else "(empty register)")

    # Normally only results received after the register's cut-off. With
    # --include-late, everything unsuppressed is considered and the episode
    # key alone decides what is new, which sweeps up late-reported results.
    if include_late or pd.isna(watermark):
        fresh = got.notna()
    else:
        fresh = got > watermark
    unsuppressed = active & (vl >= vl_threshold)
    cand = treat[unsuppressed & fresh].copy()

    def col_ci(d: pd.DataFrame, name: str) -> pd.Series:
        """Case-insensitive column fetch that always returns a Series.

        `d.get(missing)` returns None, and pd.to_datetime(None) is a scalar
        NaT, so the old code raised AttributeError on `.dt` the moment a
        column was absent - which the register genuinely can be.
        """
        hit = {str(c).strip().lower(): c for c in d.columns}.get(name.lower())
        if hit is None:
            return pd.Series(pd.NA, index=d.index, dtype="object")
        return d[hit]

    def episode(d: pd.DataFrame) -> pd.Series:
        return (d[KEY].astype(str) + "|"
                + pd.to_datetime(col_ci(d, "dateofCurrentViralLoad"),
                                 errors="coerce").dt.strftime("%Y-%m-%d").fillna("NA")
                + "|" + pd.to_numeric(col_ci(d, "currentViralLoad"),
                                      errors="coerce").astype("string"))

    # If the register cannot supply the episode date, every candidate looks new
    # and a client already in the register would be appended a second time.
    if len(register) and col_ci(register, "dateofCurrentViralLoad").isna().all():
        log.warning("the register has no usable 'dateofCurrentViralLoad' - "
                    "episodes are matched on S/N and value alone, which is "
                    "weaker; check the appended rows before publishing")

    # A register row with neither a viral load nor a result date is not an
    # episode - it is the residue of an earlier append that lost its columns to
    # a case mismatch. Drop them so a re-run repairs the register rather than
    # stacking a second copy on top of the wreckage.
    if len(register):
        rvl = pd.to_numeric(col_ci(register, "currentViralLoad"), errors="coerce")
        rdt = pd.to_datetime(col_ci(register, "dateResultReceivedFacility"),
                             errors="coerce")
        empty = rvl.isna() & rdt.isna()
        if empty.any():
            log.warning("register: dropping %s row(s) with no viral load and "
                        "no result date - not episodes, and they would be "
                        "re-appended as duplicates", f"{int(empty.sum()):,}")
            register = register[~empty].reset_index(drop=True)

    have = set(episode(register)) if len(register) else set()

    # Results dated on or before the watermark are outside the agreed cut-off,
    # so they are not appended. But reporting the raw count was crying wolf:
    # of 1,853 on the first real run, 1,720 were already in the register. Only
    # the ones genuinely absent are worth a warning - those are late facility
    # reporting, and the number is small enough to act on.
    if pd.notna(watermark):
        stale = treat[unsuppressed & got.notna() & (got <= watermark)]
        missed = int((~episode(stale).isin(have)).sum()) if len(stale) else 0
        if missed and include_late:
            # Telling someone to pass a flag they have already passed reads as
            # though it was ignored. With the flag on these ARE being added.
            log.info("%s late-reported result(s) dated on or before the "
                     "cut-off are being included (--include-late)",
                     f"{missed:,}")
        elif missed:
            log.warning("%s unsuppressed result(s) dated on or before the "
                        "cut-off are absent from the register - late facility "
                        "reporting. Outside the agreed cut-off, so NOT "
                        "appended; use --include-late to add them.",
                        f"{missed:,}")

    if cand.empty:
        return register, 0

    cand = cand[~episode(cand).isin(have)]
    if cand.empty:
        return register, 0

    # The register and the export spell the same fields differently -
    # DateResultReceivedFacility vs dateResultReceivedFacility, State vs state.
    # An exact-case intersection matched 2 of 63 columns, so appended rows
    # carried an S/N and nothing else: no viral load, no date, no status. They
    # counted as episodes and charted as nothing. Map by lower-case name.
    reg_by_lower = {str(c).strip().lower(): c for c in register.columns}
    cand = cand.rename(columns={c: reg_by_lower[str(c).strip().lower()]
                                for c in cand.columns
                                if str(c).strip().lower() in reg_by_lower})
    keep = [c for c in register.columns if c in cand.columns]

    # Fail rather than publish blank episodes again. Every appended row must
    # carry the two fields the dashboard cannot do without.
    need_cols = [reg_by_lower.get(n) for n in
                 ("dateresultreceivedfacility", "currentviralload")]
    for col in filter(None, need_cols):
        if col not in keep or cand[col].isna().all():
            raise SystemExit(
                f"appended rows would have no '{col}'. Only {len(keep)} of "
                f"{len(register.columns)} register columns could be matched to "
                f"the export, so these rows would be published empty. The "
                f"column naming has probably changed - stopping.")

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
    ap.add_argument("--include-late", action="store_true",
                    help="also append unsuppressed results dated on or before "
                         "the register's cut-off that are missing from it - "
                         "late facility reporting")
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

    S = cfg["secrets"] if cfg.has_section("secrets") else {}
    treat = read_excel_any(Path(P["treatment"]), S.get("treatment_password"),
                           dtype=str)
    log.info("treatment list: %s rows x %d cols", f"{len(treat):,}", len(treat.columns))
    check_key_collisions(treat)

    if not {"pepId", "datimCode"} <= set(treat.columns):
        raise SystemExit("treatment list needs both 'pepId' and 'datimCode'")
    built = build_key(treat["datimCode"], treat["pepId"])

    # A key format that no longer matches the vault is the most dangerous
    # failure this script has: nothing errors, every client simply looks new,
    # and the run mints 180,000 keys and severs the cohort from its history.
    # So check the built key actually hits the vault before using it.
    hit = norm_key(built).isin(vault.lookup).mean()
    log.info("key check: %.1f%% of the export matches the vault", hit * 100)
    if hit < 0.5 and len(vault.lookup):
        raise SystemExit(
            f"only {hit:.1%} of the treatment list matches the vault. The key "
            f"format has probably changed.\n"
            f"  built from the export : {built.dropna().iloc[0]}\n"
            f"  a key in the vault    : {next(iter(vault.lookup))}\n"
            "Refusing to continue - carrying on would issue a new key to "
            "nearly every client and orphan the entire published history.")
    if VAULT_NEW in treat.columns:
        mismatch = int((norm_key(treat[VAULT_NEW]) != norm_key(built)).sum())
        if mismatch:
            log.warning("%s row(s) where the export's %s differs from "
                        "datimCode+pepId - using the value we built",
                        f"{mismatch:,}", VAULT_NEW)
    treat[KEY] = vault.resolve(treat["datimCode"], treat["pepId"])

    # The EAC list is not cumulative - clients drop out once a cycle closes -
    # so the dashboard unions every sheet it is given and the pipeline has to
    # carry them all forward, not just the newest. `eac` may therefore be a
    # single file or a glob.
    eac_paths = sorted(Path(P["eac"]).parent.glob(Path(P["eac"]).name)) \
        if any(ch in P["eac"] for ch in "*?[") else [Path(P["eac"])]
    if not eac_paths:
        raise SystemExit(f"no EAC list matched {P['eac']}")
    eac_sheets = {p.stem: read_excel_any(p, S.get("eac_password"), dtype=str)
                  for p in eac_paths}

    # ORDER MATTERS. The dashboard treats sheet order as the authority for
    # which EAC list is newest and takes the LAST one. Writing them in glob
    # order meant alphabetical order, so 'EAC Line List_4th July' sorted after
    # '24th July' and was declared newest - two weeks of session dates lost
    # their precedence.
    #
    # Sorted by the latest session date each sheet actually contains, not by
    # its name: the content cannot drift out of step with itself the way a
    # filename can, and ingest.py is explicit that parsing dates out of names
    # is the fragile option.
    def newest_session(df: pd.DataFrame) -> pd.Timestamp:
        cols = [c for c in df.columns if "session" in str(c).lower()
                and "date" in str(c).lower()]
        best = pd.NaT
        for c in cols:
            m = pd.to_datetime(df[c], errors="coerce").max()
            if pd.notna(m) and (pd.isna(best) or m > best):
                best = m
        return best

    order = sorted(eac_sheets, key=lambda n: (pd.Timestamp.min
                                              if pd.isna(newest_session(eac_sheets[n]))
                                              else newest_session(eac_sheets[n])))
    eac_sheets = {n: eac_sheets[n] for n in order}
    log.info("EAC sheets in chronological order, newest last: %s",
             " -> ".join(order))
    for name, df in eac_sheets.items():
        log.info("EAC list %-28s %8s rows x %3d cols", name,
                 f"{len(df):,}", len(df.columns))

    register = read_excel_any(Path(P["register"]), S.get("register_password"),
                              dtype=str) \
        if Path(P["register"]).exists() else treat.iloc[0:0].copy()

    # The EAC export and the register carry S/N but no pepId or datimCode, so
    # after a migration their keys are stale and can only be translated through
    # the legacy mapping. Anything that fails to translate is reported rather
    # than silently carried forward under a key that no longer means anything.
    legacy = vault.legacy_map()
    if legacy:
        targets = [(f"EAC {n}", d) for n, d in eac_sheets.items()]                   + [("register", register)]
        for label, frame in targets:
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
    register, added = append_new_unsuppressed(register, treat,
                                             include_late=a.include_late)
    log.info("register: %s newly unsuppressed episode(s) appended, %s total",
             f"{added:,}", f"{len(register):,}")

    # Drop by name, case-insensitively, and apply the SAME list everywhere.
    # Matching on the exact spelling let 'DOB' through where the list said
    # 'dob', and the EAC sheets were only ever checked for DOB, so two of them
    # kept PatientHospitalNo. Validation caught both, but a de-identification
    # step that relies on the export's capitalisation is not a safeguard.
    banned = {c.lower() for c in PII_COLUMNS + SENSITIVE_COLUMNS + EAC_PII_COLUMNS}

    def strip_pii(df: pd.DataFrame) -> pd.DataFrame:
        gone = [c for c in df.columns if str(c).strip().lower() in banned]
        return df.drop(columns=gone, errors="ignore")

    sheets = {"Total Unsuppressed": strip_pii(register),
              Path(P["treatment"]).stem: strip_pii(treat)}
    for name, df in eac_sheets.items():
        sheets[name] = strip_pii(df)

    # A row with no S/N cannot be linked to anything: the dashboard keys every
    # join, worklist and episode on it. These are blank in the source exports,
    # not a re-keying failure. Drop them, but never quietly - say which sheet
    # and how many, so a sudden jump is visible.
    for name, df in sheets.items():
        if KEY not in df.columns:
            continue
        sn = df[KEY].astype("string").str.strip()
        keyless = sn.isna() | sn.eq("")
        if keyless.any():
            log.warning("%s: dropping %s row(s) with no %s - blank in the "
                        "source export, so they cannot be linked to anything",
                        name, f"{int(keyless.sum()):,}", KEY)
            sheets[name] = df[~keyless]

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
