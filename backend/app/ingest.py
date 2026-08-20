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
import re
import zipfile
from dataclasses import dataclass

import pandas as pd

from .indicators import VL_UNDETECTABLE, build_cohort, norm_state

log = logging.getLogger(__name__)

SHEET_TOTAL = ("total unsuppressed", "total_unsuppressed")
EAC_MARKERS = ("Session_1_Date", "EAC_Cycle_Number")
ART_MARKERS = ("currentViralLoad", "currentArtStatus")

# Every column the dashboard actually reads, and what breaks without it.
# Most are matched EXACTLY and case-sensitively downstream (indicators.tcols and
# ecols), so a re-export that renames `outcomesDate` to `OutcomesDate` drops the
# column silently: no error, no failed upload, every client simply reads "not
# recorded". The audit below turns that into a visible finding.
EXPECTED_COLS: dict[str, dict[str, str]] = {
    "total": {
        "S/N": "client key - the join to every other sheet",
        "currentViralLoad": "the index (triggering) viral load",
        "dateofCurrentViralLoad": "index VL result date - dates the episode",
        "dateResultReceivedFacility": "FY quarter buckets",
        "lastDateOfSampleCollection": "index VL sample date",
        "CurrentRegimenLine": "regimen line AT index - separates a genuine switch "
                              "from a client already on 2nd/3rd line",
    },
    "eac": {
        "S/N": "client key",
        "Session_1_Date": "EAC-1, EAC lead time, time-to-EAC",
        "Session_2_Date": "EAC-2",
        "Session_3_Date": "EAC-3, completed EAC, the post-EAC VL window",
        "Session_4_Extended_Date": "extended EAC",
        "Total_EAC_Sessions_All_Cycles": "session count",
        "EAC_Cycle_Number": "repeat-cycle detection",
        "First_Ever_VL_Sample_Collection_Date": "time to first VL",
        "First_High_VL_Sample_Collection_Date": "time to first unsuppressed VL",
    },
    "treatment": {
        "S/N": "client key",
        "state": "geography filters",
        "lga": "geography filters",
        "facilityName": "facility filters and league tables",
        "sex": "Who breakdowns",
        "currentAge": "age bands and the paediatric split",
        "currentArtStatus": "care outcomes - LTFU / died / transferred out",
        "currentRegimenLine": "current line - this is what detects the switch",
        "currentArtRegimen": "regimen detail",
        "artStartDate": "ART era (pre/post Test-and-Treat)",
        "daysOnArt": "time on ART",
        "dsdModel": "differentiated service delivery",
        "currentViralLoad": "follow-up / post-EAC VL value",
        "dateofCurrentViralLoad": "follow-up VL result date",
        "lastDateOfSampleCollection": "follow-up VL sample date - the post-EAC clock",
        "maritalStatus": "Who breakdowns",
        "jobStatus": "Who breakdowns",
        "educationallevel": "Who breakdowns",
        "firstCd4": "CD4 band",
        "cd4LfaResult": "CD4 band (VISITEC LFA arm)",
        "currentPregnancyStatus": "pregnancy among women",
        "whostage": "WHO stage",
        "bmi": "nutrition",
        "outcomesDate": "exit dating for death / transfer / discontinued care",
        "pharmacyLastPickupdate": "derived LTFU exit date (pickup + refill + 28d)",
        "daysOfArvRefill": "derived LTFU exit date (pickup + refill + 28d)",
        "lgaOfResidence": "residence choropleth",
        "stateOfResidence": "residence choropleth",
    },
}

# The handful resolved through indicators._pick/_coalesce, which DO match
# case-insensitively. Header drift on these is untidy but harmless, so the audit
# must not claim they were ignored - everything else genuinely is.
CASE_INSENSITIVE: dict[str, set[str]] = {
    "total": {"currentViralLoad", "dateofCurrentViralLoad",
              "dateResultReceivedFacility", "lastDateOfSampleCollection"},
    "eac": {"Total_EAC_Sessions_All_Cycles", "EAC_Cycle_Number"},
    # The whole treatment mapping resolves case-insensitively now. The 24-July
    # export renamed "lga" to "LGA", which under exact matching would have
    # dropped every geography silently; the resolver was made tolerant instead.
    # Listing them here keeps the finding honest - casing drift on this sheet is
    # worth fixing at source, but it no longer loses data, so it must not be
    # reported as ignored.
    "treatment": set(EXPECTED_COLS["treatment"]),
}


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
    col = df.get("Followup_VL_Value")
    if col is None:
        # The column is optional - it has not been read for outcomes since
        # follow-up VLs moved to the clinical line lists. Without this guard
        # pd.to_numeric(None) returns a bare float64, whose missing .dropna()
        # raised an AttributeError that failed the WHOLE upload with an opaque
        # message. An EAC export that simply omits the column is not an error.
        return False, None
    v = pd.to_numeric(col, errors="coerce").dropna()
    if len(v) < 200:
        return False, (float(v.max()) if len(v) else None)
    return bool(v.max() < VL_UNDETECTABLE), float(v.max())


def _col_audit(df: pd.DataFrame, kind: str, sheet: str, add) -> None:
    """
    Compare an incoming sheet against the columns the dashboard reads.

    Splits into two findings because they need different remedies: a column that
    is genuinely absent needs a re-export, whereas one that is merely mis-cased
    is present in the file and only needs its header restored.
    """
    exp = EXPECTED_COLS.get(kind, {})
    if not exp:
        return
    have = set(df.columns)
    lower = {str(c).strip().lower(): c for c in df.columns}
    tolerant = CASE_INSENSITIVE.get(kind, set())

    missing, ignored, tolerated = [], [], []
    for col, purpose in exp.items():
        if col in have:
            continue
        hit = lower.get(col.lower())
        if hit is None:
            missing.append(f"{col} ({purpose})")
        elif col in tolerant:
            tolerated.append(f"{hit} should be {col}")
        else:
            ignored.append(f"{hit} should be {col} - powers {purpose}")

    add(sheet, "Expected column missing", "high", len(missing),
        "Absent from this sheet, so the feature it powers is blank for every "
        "client: " + "; ".join(missing) + ". Ask the HI team to re-export."
        if missing else
        f"All {len(exp)} columns the dashboard reads are present.")
    add(sheet, "Expected column renamed", "high", len(ignored),
        "Present but under a different header, and these are read case-sensitively, "
        "so they are SILENTLY IGNORED: " + "; ".join(ignored) + "."
        if ignored else "No header drift on case-sensitive columns.")
    if tolerated:
        add(sheet, "Header casing drift (tolerated)", "low", len(tolerated),
            "Read case-insensitively, so nothing is lost - but fix at source "
            "before it spreads: " + "; ".join(tolerated) + ".")


def dq_checks(sheets: dict[str, pd.DataFrame], infos: list[SheetInfo],
              cohort_df: pd.DataFrame,
              used: dict[str, str | None] | None = None) -> list[dict]:
    out: list[dict] = []

    def add(sheet, name, sev, n, detail):
        out.append({"sheet": sheet, "check_name": name,
                    "severity": sev if n else "clear",
                    "n_records": int(n), "detail": detail})

    # Audit only the sheets that were actually analysed. A stale sheet sitting
    # in the workbook is ignored by design and should not raise findings.
    for _kind, _name in (used or {}).items():
        if _name and _name in sheets:
            _col_audit(sheets[_name], _kind, _name, add)

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
    treats = [i for i in infos if i.kind == "treatment"]
    if not treats:
        raise ValueError("No treatment line list found (need currentViralLoad).")
    total = next((i for i in infos if i.kind == "total"), None)

    # ---- which sheet wins when the workbook carries several -----------------
    # Sheet ORDER is the authority. Exports are appended chronologically, and
    # trusting that is far less fragile than parsing "18th July" out of a sheet
    # name. Both kinds now take the LAST sheet as the newest.
    #
    # They used to disagree: EAC took the last, treatment took the FIRST. A
    # workbook holding both an 11-July and an 18-July treatment list therefore
    # analysed the 11-July one and ignored the newer sheet without a word.
    treat = treats[-1]
    primary = eacs[-1]

    # ---- the EAC list is NOT cumulative, so union it ------------------------
    # Clients drop out of the EAC export once their cycle closes: 3,547 present
    # in the May/June sheets were gone from the 4-July one. Reading only the
    # newest sheet deletes their session dates, and they resurface downstream as
    # "never had EAC" - 226 episodes in the July build, 22% of the no-EAC group.
    #
    # Newest sheet first, so build_cohort's drop_duplicates("sn") keeps the most
    # recent row per client. Whole rows are kept intact and columns are never
    # blended across exports: filling a gap in an in-progress cycle from an older
    # one would credit a client with a Session_3 they have not yet attended.
    eac_df = pd.concat([sheets[i.name] for i in reversed(eacs)], ignore_index=True)
    treat_df = sheets[treat.name]
    total_df = sheets[total.name] if total else treat_df.iloc[0:0]

    def _keys(df: pd.DataFrame) -> set:
        if "S/N" not in df:
            return set()
        return set(df["S/N"].astype("string").str.strip().dropna())

    recovered = len(_keys(eac_df) - _keys(sheets[primary.name]))

    coh = build_cohort(total_df, treat_df, eac_df, as_of=as_of, mode=mode)
    findings = dq_checks(sheets, infos, coh.df, used={
        "total": total.name if total else None,
        "treatment": treat.name,
        "eac": primary.name,
    })

    warnings = list(coh.warnings)
    for i in eacs:
        if i.censored:
            warnings.append(
                f"'{i.name}' has a success-censored follow-up VL column "
                f"(max {i.max_fu_vl:g}). Harmless: that column is no longer read. "
                f"Outcomes come from the clinical line lists."
            )
    if len(eacs) > 1:
        warnings.append(
            f"EAC session dates unioned across {len(eacs)} sheets "
            f"({', '.join(i.name for i in eacs)}); '{primary.name}' is the newest and "
            f"wins wherever a client appears in more than one. {recovered:,} clients "
            f"carry session dates found ONLY in an older sheet - reading the newest "
            f"alone would have counted them as never having had EAC.")
    else:
        warnings.append(f"EAC session dates read from '{primary.name}'.")
    if len(treats) > 1:
        warnings.append(
            f"{len(treats)} treatment line lists present. Used the newest by sheet "
            f"order, '{treat.name}'. Not read: "
            f"{', '.join(i.name for i in treats if i is not treat)}. The treatment "
            f"list is a current-state snapshot, so only the latest is meaningful.")
    warnings.append("All viral loads - index and follow-up - come from the clinical line lists.")

    return coh, findings, warnings, infos, primary.name


COHORT_COLS = [
    "sn", "state", "lga", "facility", "sex", "age", "age_band", "paed",
    "art_status", "regimen_line", "regimen", "days_on_art", "dsd",
    "marital", "job", "education", "first_cd4",
    "post_eac_vl", "pregnancy", "who_stage", "bmi", "lga_res", "state_res",
    "lga_res_norm",
    "cd4_band", "age_group", "time_to_first_vl", "time_to_first_unsupp",
    "prior_switch", "art_year", "exit_date",
    "idx_vl", "idx_date", "recv_date", "idx_samp", "vl_magnitude", "fy_quarter",
    "eac_valid", "eac_prior_cycle", "eac1", "eac2", "eac3",
    "eac_extended", "eac_completed", "eac_truncated",
    "eac_trunc_pre", "eac_trunc_mid",
    "sessions", "cycles", "dtc_review",
    "repeat_failure", "on_second_line", "switch_eligible", "awaiting_switch", "fu_samp",
    "post_sample", "post_result", "awaiting_result", "s1_date", "fu_vl", "fu_date",
    "resuppressed", "undetectable", "llv", "still_unsuppressed", "switched",
    "time_to_eac", "eac_lead_time", "time_to_resupp", "months_unsuppressed",
    "treatment_plan", "episode", "enrol_quarter", "fy",
    "first_vl", "first_vl_date", "first_high_vl", "first_high_date",
]


def _series(d: pd.DataFrame, name: str) -> pd.Series:
    """Column by name, case- and punctuation-insensitively, always a Series.

    `d.get(missing)` returns None, and pd.to_datetime(None) is a scalar NaT -
    so a renamed column does not raise, it silently produces one value for
    every row. The exports have renamed columns on case three times already.
    """
    hit = {re.sub(r"[^a-z0-9]", "", str(c).lower()): c for c in d.columns} \
        .get(re.sub(r"[^a-z0-9]", "", name.lower()))
    if hit is None:
        return pd.Series(pd.NA, index=d.index, dtype="object")
    return d[hit]


# The two dated viral loads taken from the EAC export: the client's first ever
# result, and their first unsuppressed one. Both are near-fully populated and
# neither exists anywhere else - they reach back years, well before this
# dashboard held anything.
#
# Nothing else is taken from here, deliberately. The EAC list also carries a
# most-recent and a triggering VL, but the clinical line lists are the
# authority for current results; reading the same fact from two sources
# invites them to disagree and leaves nobody able to say which is right. The
# follow-up VL is excluded for a second reason too: it has been
# success-censored in past sheets - May and June recorded nothing above 49.9,
# which would have made every client look re-suppressed.
VL_HISTORY = {
    "first_vl":        "First_Ever_VL_Value",
    "first_vl_date":   "First_Ever_VL_Result_Date",
    "first_high_vl":   "First_High_VL_Value",
    "first_high_date": "First_High_VL_Result_Date",
}


def cohort_records(df: pd.DataFrame, upload_id: int) -> list[tuple]:
    d = df.copy()
    d["s1_date"] = pd.to_datetime(d.get("Session_1_Date"), errors="coerce")
    d["fu_date"] = pd.to_datetime(d.get("Followup_VL_Result_Date"), errors="coerce")
    for dest, src in VL_HISTORY.items():
        col = _series(d, src)
        d[dest] = (pd.to_datetime(col, errors="coerce") if dest.endswith("date")
                   else pd.to_numeric(col, errors="coerce"))
    for c in COHORT_COLS:
        if c not in d:
            d[c] = None
    d = d[COHORT_COLS].astype(object).where(pd.notna(d[COHORT_COLS]), None)
    return [(upload_id, *r) for r in d.itertuples(index=False, name=None)]
