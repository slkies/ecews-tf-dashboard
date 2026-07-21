"""
Workbook -> Postgres.

An admin uploads the bi-weekly workbook; this parses it, runs data-quality
checks, builds the cohort, and writes an immutable snapshot. Viewers never
upload anything - they just read the current snapshot through the API.

Two guards worth knowing about, both learned the hard way from real exports:

1. SUCCESS-CENSORED EAC SHEETS.  In the 23-May and 20-June exports every
   recorded Followup_VL_Value is <= 49.9 - unsuppressed follow-up results
   were simply never written to the column. Resuppression computes to 100%
   and trending them against a complete export invents a viral-rebound
   epidemic that never happened. We detect this and refuse to use such a
   sheet for outcomes.

2. S/N MUST STAY TEXT. The values need 12+ decimal places to remain unique.
   Anything that reads them as a float collides clients and silently breaks
   every join.
"""
from __future__ import annotations

import io
import logging
import pathlib
import zipfile
from dataclasses import dataclass

import pandas as pd

from .indicators import VL_UNDETECTABLE, build_cohort, norm_state

log = logging.getLogger(__name__)

SHEET_TOTAL = ("total unsuppressed", "total_unsuppressed")
EAC_MARKERS = ("Session_1_Date", "EAC_Cycle_Number")
ART_MARKERS = ("currentViralLoad", "currentArtStatus")


@dataclass
class SheetInfo:
    name: str
    kind: str            # total | treatment | eac | other
    rows: int
    censored: bool = False
    max_fu_vl: float | None = None


def _read(buf: bytes, filename: str = "") -> dict[str, pd.DataFrame]:
    """
    Accepts either an Excel workbook or a zip of Parquet files.

    Parquet is the better wire format and is what we recommend for the
    bi-weekly refresh: roughly 10x smaller, ~20x faster to parse, and - the
    part that actually matters - it carries dtypes, so S/N stays TEXT instead
    of being handed back as a float that collides clients.

    Zip layout: one .parquet per sheet, the filename is the sheet name.
        Total Unsuppressed.parquet
        Treatment Line List_11th July.parquet
        EAC Line List_4th July.parquet

    Build one with scripts/to_parquet.py.
    """
    # NB: an .xlsx is itself a zip, so "is it a zip" is not the question -
    # "does it contain .parquet members" is.
    if zipfile.is_zipfile(io.BytesIO(buf)):
        with zipfile.ZipFile(io.BytesIO(buf)) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".parquet")]
            if names:
                out: dict[str, pd.DataFrame] = {}
                for n in names:
                    df = pd.read_parquet(io.BytesIO(z.read(n)))
                    if "S/N" in df.columns:
                        df["S/N"] = df["S/N"].astype("string")
                    out[pathlib.Path(n).stem] = df
                log.info("read %d parquet sheets", len(out))
                return out
            # no parquet members -> it is an Excel workbook, fall through

    if filename.lower().endswith(".parquet"):
        df = pd.read_parquet(io.BytesIO(buf))
        if "S/N" in df.columns:
            df["S/N"] = df["S/N"].astype("string")
        return {filename.rsplit(".", 1)[0]: df}

    # Excel. dtype on the key column is not enough on its own - openpyxl hands
    # back the float first - but combined with the string cast it holds.
    xls = pd.ExcelFile(io.BytesIO(buf))
    return {n: xls.parse(n, dtype={"S/N": "string"}) for n in xls.sheet_names}


def _classify(name: str, df: pd.DataFrame) -> str:
    cols = set(df.columns)
    if name.strip().lower() in SHEET_TOTAL:
        return "total"
    if any(m in cols for m in EAC_MARKERS):
        return "eac"
    if any(m in cols for m in ART_MARKERS):
        return "treatment"
    return "other"


def audit_censoring(df: pd.DataFrame) -> tuple[bool, float | None]:
    """True if the follow-up VL column only ever contains suppressed values."""
    v = pd.to_numeric(df.get("Followup_VL_Value"), errors="coerce").dropna()
    if len(v) < 200:
        return False, (float(v.max()) if len(v) else None)
    return bool(v.max() < VL_UNDETECTABLE), float(v.max())


def dq_checks(sheets: dict[str, pd.DataFrame], infos: list[SheetInfo],
              cohort_df: pd.DataFrame) -> list[dict]:
    out: list[dict] = []

    def add(sheet, name, sev, n, detail):
        out.append({"sheet": sheet, "check_name": name,
                    "severity": sev if n else "clear",
                    "n_records": int(n), "detail": detail})

    for i in infos:
        if i.kind != "eac":
            continue
        df = sheets[i.name]
        if i.censored:
            add(i.name, "Success-censored follow-up VL", "critical", i.rows,
                f"Every recorded Followup_VL_Value is <= {i.max_fu_vl:g}. Unsuppressed "
                "results were never written. Excluded from outcome analysis; ask the "
                "HI team to re-export or retire this list.")
        add(i.name, "Missing client key (S/N)", "critical",
            df["S/N"].isna().sum() if "S/N" in df else 0,
            "Rows with a blank S/N cannot be linked to the treatment line list.")
        cyc = df.get("EAC_Cycle_Number")
        bad = 0 if cyc is None else cyc.astype("string").fillna("").str.contains(
            r"1900|/", regex=True).sum()
        add(i.name, "Excel date corruption in EAC_Cycle_Number", "high", bad,
            "Values such as 1/0/1900 where an integer cycle number is expected.")

    for i in infos:
        if i.kind not in ("total", "treatment"):
            continue
        df = sheets[i.name]
        st = df.get("state")
        variants = sorted(set(st.dropna().astype(str))) if st is not None else []
        dup = len(variants) > len({v.lower() for v in variants})
        add(i.name, "Inconsistent state casing", "medium", len(variants) if dup else 0,
            f"Found: {', '.join(variants)}. Normalised on ingest, but fix at source.")

    c = cohort_df
    add(None, "EAC session dated before the index VL", "high",
        int(c["eac_prior_cycle"].sum()),
        "Session 1 precedes the VL that should have triggered it. Excluded from the "
        "cascade as a prior cycle (spec §2.3 rule 2).")
    add(None, "Implausible viral load", "high",
        int((c["idx_vl"] > 10_000_000).sum()),
        "Index VL above 10,000,000 copies/mL, beyond any commercial assay range.")
    # Guideline: the first VL is drawn after 6 months of consecutive ART. An
    # index VL earlier than that points at a date error or premature testing -
    # most relevant for newly commencing clients.
    art0 = pd.to_datetime(c.get("art_start"), errors="coerce")
    idxd = pd.to_datetime(c.get("idx_date"), errors="coerce")
    early = ((idxd - art0).dt.days < 183) & art0.notna() & idxd.notna()
    add(None, "Index VL within 6 months of ART start", "medium",
        int(early.fillna(False).sum()),
        "The guideline recommends the first VL after 6 months of consecutive ART. "
        "An index VL earlier than that suggests a date error or premature sampling - "
        "check ART start dates for newly commencing clients.")
    # matches the `awaiting_vl` worklist: completed the course (sessions 1-3 +
    # >=30 days) but no post-EAC VL SAMPLE on/after session 3.
    add(None, "EAC completed, no post-EAC VL sample", "medium",
        int((c["eac_completed"] & ~c["post_eac_vl"]).sum()),
        "Course finished (sessions 1-3, >=30 days) but no post-EAC VL sample collected. "
        "These clients are stranded mid-cascade - see the 'awaiting VL' worklist.")
    add(None, "Sample drawn before EAC session 1", "high",
        int(c["eac_trunc_pre"].sum()),
        "The follow-up VL sample predates session 1, so the EAC cycle had not started "
        "when the client was retested - a negative EAC lead time. The counselling "
        "cannot have influenced that result.")
    add(None, "EAC cycle truncated mid-series", "medium",
        int(c["eac_trunc_mid"].sum()),
        "A post-EAC sample was drawn after session 1 or 2 but the series never reached "
        "session 3.")
    # Session dates that contradict each other: S2 or S3 dated before S1, or S3
    # before S2. Surfaced because it is the only way an episode can be 'completed'
    # while its follow-up sample predates session 1.
    s1d = pd.to_datetime(c.get("Session_1_Date"), errors="coerce")
    s3d = pd.to_datetime(c.get("Session_3_Date"), errors="coerce")
    s2d = pd.to_datetime(c.get("Session_2_Date"), errors="coerce")
    disorder = (((s2d < s1d) & s2d.notna() & s1d.notna())
                | ((s3d < s1d) & s3d.notna() & s1d.notna())
                | ((s3d < s2d) & s3d.notna() & s2d.notna()))
    add(None, "EAC session dates out of order", "high",
        int(disorder.fillna(False).sum()),
        "Session 2 or 3 is dated before session 1 (or session 3 before session 2). "
        "The session series contradicts itself, so any lead time or completion "
        "derived from it is unreliable. Fix at source.")
    add(None, "Post-EAC result with no sample date", "medium",
        int((c["post_result"] & ~c["post_sample"]).sum()),
        "A follow-up VL result exists but Followup_VL_Sample_Collection_Date is blank. "
        "Cascade step 8 is therefore reported against EAC1, not against samples.")
    add(None, "Switch recorded without a switch date", "high",
        int(c["switched"].sum()),
        "Switched_To_Second_Line reflects the client's current regimen line only. With "
        "no switch date in the export, a switch cannot be attributed to the current EAC "
        "cycle. Ask the HI team to add Switch_Date / Regimen_Change_Date.")
    add(None, ">2 EAC cycles, still unsuppressed", "high", int(c["dtc_review"].sum()),
        "Flag for Drug Therapeutic Committee review (spec §2.3 rule 4).")
    rep_clients = int((c["sn"].value_counts() > 1).sum())
    add(None, "Clients with a repeat unsuppression episode", "medium", rep_clients,
        f"{rep_clients} clients unsuppressed more than once ({int(len(c) - c['sn'].nunique())} "
        "repeat occurrences). Each episode is tracked separately - not duplicates - and these "
        "are the highest-priority switch candidates.")
    return out


def ingest_workbook(buf: bytes, as_of, mode: str = "snapshot", filename: str = ""):
    sheets = _read(buf, filename)
    infos: list[SheetInfo] = []
    for n, df in sheets.items():
        kind = _classify(n, df)
        info = SheetInfo(name=n, kind=kind, rows=len(df))
        if kind == "eac":
            info.censored, info.max_fu_vl = audit_censoring(df)
        infos.append(info)

    eacs = [i for i in infos if i.kind == "eac"]
    if not eacs:
        raise ValueError("No EAC line list found (need Session_1_Date or EAC_Cycle_Number).")
    treat = next((i for i in infos if i.kind == "treatment"), None)
    if treat is None:
        raise ValueError("No treatment line list found (need currentViralLoad).")
    total = next((i for i in infos if i.kind == "total"), None)

    # Newest EAC sheet wins. Success-censoring no longer matters for outcomes:
    # follow-up VLs come from the clinical line lists, and the EAC sheet is read
    # only for SESSION DATES, which the censoring never touched.
    primary = eacs[-1]

    eac_df = sheets[primary.name]
    treat_df = sheets[treat.name]
    total_df = sheets[total.name] if total else treat_df.iloc[0:0]

    coh = build_cohort(total_df, treat_df, eac_df, as_of=as_of, mode=mode)
    findings = dq_checks(sheets, infos, coh.df)

    warnings = list(coh.warnings)
    for i in eacs:
        if i.censored:
            warnings.append(
                f"'{i.name}' has a success-censored follow-up VL column "
                f"(max {i.max_fu_vl:g}). Harmless: that column is no longer read. "
                f"Outcomes come from the clinical line lists."
            )
    warnings.append(f"EAC session dates read from '{primary.name}'. All viral loads - index and follow-up - come from the clinical line lists.")

    return coh, findings, warnings, infos, primary.name


COHORT_COLS = [
    "sn", "state", "lga", "facility", "sex", "age", "age_band", "paed",
    "art_status", "regimen_line", "regimen", "days_on_art", "dsd",
    "marital", "job", "education", "first_cd4",
    "post_eac_vl", "pregnancy", "who_stage", "bmi", "lga_res", "state_res",
    "cd4_band", "age_group", "time_to_first_vl", "time_to_first_unsupp",
    "prior_switch", "art_year", "exit_date",
    "idx_vl", "idx_date", "recv_date", "idx_samp", "vl_magnitude", "fy_quarter",
    "eac_valid", "eac_prior_cycle", "eac1", "eac2", "eac3",
    "eac_extended", "eac_completed", "eac_truncated",
    "eac_trunc_pre", "eac_trunc_mid",
    "sessions", "cycles", "dtc_review",
    "repeat_failure", "on_second_line", "switch_eligible", "awaiting_switch", "fu_samp",
    "post_sample", "post_result", "s1_date", "fu_vl", "fu_date",
    "resuppressed", "undetectable", "llv", "still_unsuppressed", "switched",
    "time_to_eac", "eac_lead_time", "time_to_resupp", "months_unsuppressed",
    "treatment_plan", "episode", "enrol_quarter", "fy",
]


def cohort_records(df: pd.DataFrame, upload_id: int) -> list[tuple]:
    d = df.copy()
    d["s1_date"] = pd.to_datetime(d.get("Session_1_Date"), errors="coerce")
    d["fu_date"] = pd.to_datetime(d.get("Followup_VL_Result_Date"), errors="coerce")
    for c in COHORT_COLS:
        if c not in d:
            d[c] = None
    d = d[COHORT_COLS].astype(object).where(pd.notna(d[COHORT_COLS]), None)
    return [(upload_id, *r) for r in d.itertuples(index=False, name=None)]
