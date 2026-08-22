"""
EAC / Treatment-Failure indicator engine.

Implements EAC_Indicator_Definitions_and_Data_Analysis_Plan v2.1:
  §2.3  matching + temporal validity rules
  §4    cascade indicators 1-10
  §5    time-dependent indicators
  §6    treatment plan decision tree

ONE DEVIATION FROM THE SPEC, AND IT IS DELIBERATE
-------------------------------------------------
Spec §2.1 says the index cohort is the `Total_Unsuppressed` snapshot.
That snapshot is built on *current* VL >= 1000. But a post-EAC VL
*becomes* the current VL, so:

    re-suppressed  -> current VL < 1000 -> client leaves the cohort
    still failing  -> that VL IS the index -> no later result exists

Empirically: of 2,169 snapshot clients, 266 have a follow-up VL row and
ALL 266 are dated *before* their index VL. Cascade steps 7-10 therefore
compute to exactly zero. The outcome arm is empty by construction.

So we anchor the cohort on the *index event* instead of on current status:

    A = EAC-list clients whose triggering high VL >= 1000 and whose index
        date falls in the analysis window   (preserves re-suppressors)
    B = Total_Unsuppressed clients with no EAC row at all
    index cohort = A union B

Set COHORT_MODE="snapshot" to reproduce the literal spec behaviour.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
import pathlib
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger("ecews")

# ── thresholds (spec §1.3, §4) ────────────────────────────────────────
VL_FAIL = 1000          # >= this = unsuppressed / treatment failure
VL_UNDETECTABLE = 50    # < this = undetectable
LLV_HIGH_RISK = 200     # 200-999 -> recommend switch (spec §1.4)
EAC_MIN_SESSIONS = 3    # spec §1.3
EAC_COMPLETE_DAYS = 30  # completed = sessions 1-3 plus >=30 days since session 3

# Socio-demographic level collapsing. Source values are lower-cased/stripped
# before lookup; anything unmapped or blank falls through to "Not recorded".
_MARITAL = {
    "married": "Married", "never married": "Never married",
    "widowed": "Previously married", "separated": "Previously married",
    "divorced": "Previously married",
    "living with partner": "Other", "lives alone": "Other",
}
_JOB = {
    "employee": "Employee", "unemployed": "Unemployed", "student": "Student",
    "retired": "Other", "not applicable": "Other", "unknown": "Other",
}
_EDU = {
    "primary school education": "Primary",
    "secondary school education": "Secondary",
    "tertiary education complete": "Tertiary",
    "other": "Other",
}
_PREG = {
    "not pregnant": "Not pregnant", "pregnant": "Pregnant",
    "breastfeeding": "Breastfeeding", "pmtct": "Pregnant",
}
# CurrentARTStatus -> care outcome. Anything not Active/blank is a NEGATIVE
# outcome: the client has left care, so a post-EAC VL was never going to happen.
# IIT / Stopped are mapped defensively - they are absent from the Jul-26 export
# but appear in other EMR exports.
_ART_STATUS = {
    "active": "Active",
    "ltfu": "LTFU", "lost to followup": "LTFU", "lost to follow-up": "LTFU",
    "death": "Died", "dead": "Died", "deceased": "Died",
    "transferred out": "Transferred out", "transfer out": "Transferred out",
    "transferred-out": "Transferred out",
    "discontinued care": "Discontinued care",
    "iit": "IIT", "interruption in treatment": "IIT",
    "stopped": "Stopped treatment", "stopped treatment": "Stopped treatment",
}
_NEG_OUTCOMES = ["LTFU", "IIT", "Stopped treatment", "Died",
                 "Transferred out", "Discontinued care"]
_WHO = {
    "1": "Stage 1", "2": "Stage 2", "3": "Stage 3", "4": "Stage 4",
    "who stage 1 peds": "Stage 1", "who stage 2 peds": "Stage 2",
    "who stage 3 peds": "Stage 3", "who stage 4 peds": "Stage 4",
}
WINDOW_MONTHS = 12      # spec §2.4


def vl_category(v: float | None) -> str | None:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    if v < VL_UNDETECTABLE:
        return "Undetectable"
    if v < VL_FAIL:
        return "LLV"
    return "Unsuppressed"


FY25_FLOOR = pd.Timestamp("2025-09-30")


def fiscal_quarter(d: pd.Timestamp | None,
                   floor: pd.Timestamp | None = FY25_FLOOR) -> str | None:
    """
    FY runs 1 Oct - 30 Sep (spec §2.4).

    `floor` collapses everything on or before it into that date's own quarter.
    With the default floor of 2025-09-30, every result received before FY26
    lands in FY25Q4 instead of scattering across FY22/FY23/FY24 buckets holding
    one or two episodes each. Those buckets were an artifact of dating the
    episode by an old VL result, not a real cohort. The programme reads this
    first bucket as "FY25 and earlier", which is what it is.
    """
    if d is None or pd.isna(d):
        return None
    d = pd.Timestamp(d)
    if floor is not None and d <= floor:
        d = floor
    fy = d.year + 1 if d.month >= 10 else d.year
    q = {10: 1, 11: 1, 12: 1, 1: 2, 2: 2, 3: 2,
         4: 3, 5: 3, 6: 3, 7: 4, 8: 4, 9: 4}[d.month]
    return f"FY{str(fy)[-2:]}Q{q}"


def fiscal_year(q: str | None) -> str | None:
    """FY26Q2 -> FY26."""
    return q[:4] if q else None


def norm_state(s: Any) -> str:
    """Delta / DELTA / OSUN / Osun / EKITI -> Delta / Osun / Ekiti."""
    # pd.isna must come first: `not pd.NA` raises "boolean value of NA is ambiguous".
    if s is None or pd.isna(s):
        return "Unknown"
    t = str(s).strip().lower()
    return t[:1].upper() + t[1:] if t else "Unknown"


def age_band(a: float | None) -> str:
    if a is None or pd.isna(a):
        return "Unknown"
    for hi, lab in ((10, "0-9"), (20, "10-19"), (25, "20-24"),
                    (35, "25-34"), (50, "35-49")):
        if a < hi:
            return lab
    return "50+"



def _col(df: pd.DataFrame, name: str) -> pd.Series:
    """
    `df[name]`, or an all-null Series aligned to `df` when the column is absent.

    `df.get(name)` returns None for a missing column, and `pd.to_numeric(None)`
    / `pd.to_datetime(None)` then hand back a bare scalar - float64 or NaT -
    instead of a Series. Every downstream `.where()`, `.dropna()`, `.dt` or
    `.fillna()` raises AttributeError.

    Every column read this way is OPTIONAL, so the crash only appears on an
    export that happens to omit one - which is exactly the case nobody tests by
    hand. It failed the whole upload with an opaque AttributeError rather than
    degrading to "not recorded", and it kept 25 of the unit tests red.
    """
    s = df.get(name)
    if s is None:
        return pd.Series(pd.NA, index=df.index, dtype="object")
    return s


def _pick(df: pd.DataFrame, *names: str) -> str | None:
    """
    Find a column regardless of casing.

    The quarterly Total Unsuppressed sheet ships `CurrentViralLoad` /
    `DateofCurrentViralLoad`; the treatment line list ships `currentViralLoad` /
    `dateofCurrentViralLoad`. Matching case-sensitively silently yields an
    all-null column and a cohort of zero, which is worse than crashing.
    """
    lower = {str(c).strip().lower(): c for c in df.columns}
    for n in names:
        hit = lower.get(n.strip().lower())
        if hit is not None:
            return hit
    return None


def _coalesce(df: pd.DataFrame, cols: list[str], kind: str) -> pd.Series:
    """
    First non-null value across whichever of `cols` actually exist.

    Schema drifts between exports: the May/June EAC sheets carry
    Current_High_VL_*, July renamed them to First_High_VL_* and added
    EAC_Triggering_High_VL_*. A naive .fillna() chain blows up when a column is
    absent, because df.get() returns None and to_datetime(None) is a bare NaT
    scalar, which fillna rejects ("Must specify a fill 'value' or 'method'").
    So: only touch columns that are present, and always start from a real Series.
    """
    conv = (pd.to_datetime if kind == "date" else pd.to_numeric)
    out = pd.Series(pd.NaT if kind == "date" else np.nan,
                    index=df.index,
                    dtype="datetime64[ns]" if kind == "date" else "float64")
    for c in cols:
        hit = _pick(df, c)
        if hit is not None:
            out = out.fillna(conv(df[hit], errors="coerce"))
    return out


@dataclass
class Cohort:
    """The built index cohort plus every derived flag."""
    df: pd.DataFrame
    as_of: pd.Timestamp
    mode: str
    warnings: list[str] = field(default_factory=list)


# ── cohort construction ───────────────────────────────────────────────
def build_cohort(
    total_unsuppressed: pd.DataFrame,
    treatment: pd.DataFrame,
    eac: pd.DataFrame,
    as_of: pd.Timestamp | None = None,
    mode: str = "snapshot",       # only mode; `event` was retired (see below)
    window_months: int = WINDOW_MONTHS,
) -> Cohort:
    # `as_of` MUST be the line-list date, never today. The VL-validity window is
    # measured back from it, so anchoring it to the clock made the cohort shrink
    # a little every day the app was left running (2,845 on 11 Jul -> 2,832 on
    # 14 Jul, same file). It is now required at the upload boundary.
    as_of = pd.Timestamp(as_of or dt.date.today())
    warn: list[str] = []

    e = eac.copy()
    tu = total_unsuppressed.copy()

    # S/N is the join key and must stay a string: the values need 12+ decimal
    # places to remain unique. Anything that coerces them to float collides.
    for d in (e, tu, treatment):
        d["sn"] = d["S/N"].astype("string").str.strip()
        d.loc[d["sn"].isin(["", "nan", "\\N", "None"]), "sn"] = pd.NA

    dropped = int(e["sn"].isna().sum() + tu["sn"].isna().sum())
    if dropped:
        warn.append(f"{dropped} rows dropped: blank S/N, cannot be linked.")
    e = e.dropna(subset=["sn"]).drop_duplicates("sn")
    tu = tu.dropna(subset=["sn"])

    # ---- the unit of analysis is a FAILURE EPISODE, not a client -------------
    # Total Unsuppressed is an open cohort with quarterly enrolment, so one
    # client can legitimately appear twice: fail -> EAC -> re-suppress -> fail
    # again. Those second failures are the switch candidates, i.e. exactly the
    # rows you least want to lose. De-duplicating on S/N would silently delete
    # 294 of them in the July export.
    #
    # A VL RESULT identifies the episode: result date + result value. Rows that
    # share both are the same lab result written twice (sometimes with differing
    # sample-collection metadata, which is a separate export bug). Rows that
    # differ are distinct episodes and are kept.
    tu_vl = _coalesce(tu, ["currentViralLoad"], "num")
    tu_dt = _coalesce(tu, ["dateofCurrentViralLoad"], "date")
    # Date the episode by when the RESULT REACHED THE FACILITY: that is the
    # moment the facility could act on it, and it is what the FY buckets mean.
    # Fall back to the result date on the handful of rows where it is missing.
    tu_recv = _coalesce(tu, ["dateResultReceivedFacility"], "date")
    tu_samp = _coalesce(tu, ["lastDateOfSampleCollection"], "date")
    tu = tu.assign(_vl=tu_vl, _dt=tu_dt,
                   _recv=tu_recv.fillna(tu_dt), _samp=tu_samp)

    # ---- NO VL-VALIDITY WINDOW ------------------------------------------
    # An earlier build dropped episodes whose sample was collected >12 months
    # before the line list. That was wrong and has been removed.
    #
    # Total Unsuppressed is a CUMULATIVE register, not a current-state snapshot.
    # An old unsuppressed result is not stale data - it is a real failure episode
    # that should have entered EAC in FY25Q4 or FY26Q1 and worked through the
    # cascade. Dropping those rows deleted 563 episodes that belong in FY25Q4,
    # and with them the ability to ask the questions the register exists for:
    # did this client re-suppress, did the suppression hold, did they fail again?
    #
    # Episode age is expressed by the FY quarter, not by exclusion.

    n_rows = len(tu)
    tu = tu.drop_duplicates(subset=["sn", "_dt", "_vl"])
    exact_dupes = n_rows - len(tu)

    episodes = len(tu)
    clients = tu["sn"].nunique()
    repeats = episodes - clients
    if exact_dupes:
        warn.append(f"{exact_dupes} exact duplicate rows collapsed "
                    f"(same client, same VL result).")
    if repeats:
        warn.append(f"{repeats} clients have more than one unsuppression episode "
                    f"(unsuppressed again after an earlier index VL). Each episode is "
                    f"tracked separately; {clients:,} distinct clients across "
                    f"{episodes:,} episodes.")

    # --- index event: the VL that triggered this cycle -----------------
    # Column names differ between exports; take the first one that exists.
    e["idx_vl"] = _coalesce(e, ["EAC_Triggering_High_VL_Value",
                                "First_High_VL_Value",
                                "Current_High_VL_Value"], "num")
    e["idx_date"] = _coalesce(e, ["EAC_Triggering_High_VL_Date",
                                  "First_High_VL_Result_Date",
                                  "Current_High_VL_Result_Date"], "date")

    for c in ("Session_1_Date", "Session_2_Date", "Session_3_Date",
              "Session_4_Extended_Date", "Session_5_Extended_Date",
              "Session_6_Extended_Date", "Followup_VL_Result_Date",
              "Followup_VL_Sample_Collection_Date", "ART_Start_Date"):
        # Create the column if the export omits it, so downstream code is safe.
        e[c] = (pd.to_datetime(e[c], errors="coerce") if c in e.columns
                else pd.Series(pd.NaT, index=e.index, dtype="datetime64[ns]"))

    # The EAC list's Followup_VL_* columns are NO LONGER USED for outcomes.
    # Every VL - index and follow-up - now comes from the clinical line lists.
    # This also makes the May/June success-censoring irrelevant to outcomes:
    # those sheets are only ever read for session dates.
    e["sessions"] = _coalesce(e, ["Total_EAC_Sessions_All_Cycles"], "num").fillna(0).astype(int)
    # EAC_Cycle_Number arrives corrupted as '1/0/1900' in some exports.
    e["cycles"] = _coalesce(e, ["EAC_Cycle_Number"], "num").fillna(0).astype(int)

    tu["idx_vl"] = tu["_vl"]
    tu["idx_date"] = tu["_dt"]
    tu["recv_date"] = tu["_recv"]
    tu["idx_samp"] = tu["_samp"]

    # `event` mode was RETIRED. It rebuilt the cohort from the EAC list keyed on
    # S/N, which collapsed repeat failure episodes back onto one row per client
    # and re-introduced the rolling-window drift. The quarterly open cohort in
    # Total Unsuppressed is now the single source of truth.
    # CurrentRegimenLine on the Total Unsuppressed = the regimen line AT the
    # index unsuppressed VL. This is what decides whether a later move to 2nd
    # line is a genuine switch (was 1st at index) or a client who was ALREADY
    # on 2nd/3rd line at index (a prior switch - cannot re-switch without
    # resistance testing, so they need DTC drug-history + VL review instead).
    _bc = ["sn", "idx_vl", "idx_date", "recv_date", "idx_samp"]
    if "CurrentRegimenLine" in tu:
        _bc.append("CurrentRegimenLine")
    base = tu[_bc].copy()
    if "CurrentRegimenLine" in base:
        base = base.rename(columns={"CurrentRegimenLine": "idx_regimen_line"})

    # Geography fallback, taken from the cohort register.
    #
    # State / LGA / facility normally come from the treatment line list, but the
    # 24-July export dropped its `lga` column - only `lgaOfResidence` survived,
    # which is a DIFFERENT measure (where the client lives, not where they are
    # treated). Total Unsuppressed carries the facility's own State / LGA /
    # FacilityName per episode, so it can stand in and the geography filters
    # keep working. Matched case-insensitively because this sheet capitalises
    # its headers where the treatment list does not.
    for _src, _dst in (("State", "_geo_state"), ("LGA", "_geo_lga"),
                       ("FacilityName", "_geo_facility")):
        _c = _pick(tu, _src)
        if _c is not None:
            base[_dst] = tu[_c]

    # --- attach EAC sessions + demographics -----------------------------
    ecols = [c for c in (
        "sn", "Session_1_Date", "Session_2_Date", "Session_3_Date",
        "Session_4_Extended_Date", "sessions", "cycles",
        "Session_1_Missed_Drug_Pickups",
        # first-ever and first-unsuppressed VL, for time-to-VL indicators
        "First_Ever_VL_Sample_Collection_Date",
        "First_High_VL_Sample_Collection_Date",
        # ...and their VALUES and result dates, for the trajectory. This is a
        # whitelist: a column absent from it does not reach the cohort at all,
        # which is why carrying these through ingest was not enough on its own.
        "First_Ever_VL_Value", "First_Ever_VL_Result_Date",
        "First_High_VL_Value", "First_High_VL_Result_Date",
    ) if c in e]
    df = base.merge(e[ecols], on="sn", how="left")

    t = treatment.dropna(subset=["sn"]).drop_duplicates("sn")
    tcols = {"state": "state", "lga": "lga", "facilityName": "facility",
             "sex": "sex", "currentAge": "age", "currentArtStatus": "art_status",
             "currentRegimenLine": "regimen_line", "currentArtRegimen": "regimen",
             "artStartDate": "art_start", "daysOnArt": "days_on_art",
             "dsdModel": "dsd", "currentViralLoad": "current_vl",
             "dateofCurrentViralLoad": "current_vl_date",
             "lastDateOfSampleCollection": "current_vl_samp",
             # When the CURRENT result reached the facility. Read from the
             # treatment sheet as well as the register, because it is half the
             # evidence that a result has actually come back: while the lab is
             # still running the sample this column still carries the INDEX
             # result's received date.
             "dateResultReceivedFacility": "current_recv",
             # socio-demographics + baseline CD4 (CD4 is measured at ART start,
             # so it predates the index VL and cannot be caused by it).
             "maritalStatus": "marital", "jobStatus": "job",
             "educationallevel": "education", "firstCd4": "first_cd4",
             "cd4LfaResult": "cd4_lfa",
             "currentPregnancyStatus": "pregnancy", "whostage": "who_stage",
             "bmi": "bmi",
             # exit dating: outcomesDate covers death/TO/discontinued (~99%),
             # but LTFU is only ~4% dated - derived from pickup + refill + 28d.
             "outcomesDate": "outcome_date",
             "pharmacyLastPickupdate": "last_pickup",
             "daysOfArvRefill": "days_refill",
             # residence (free-text in the EMR - normalised only at map time)
             "lgaOfResidence": "lga_res", "stateOfResidence": "state_res"}
    # Resolve the mapping case-insensitively. The export renames columns between
    # cycles without warning - the 24-July treatment list ships "LGA" where every
    # earlier one shipped "lga" - and an exact-match lookup drops the column
    # silently, leaving the geography blank with nothing on screen to say why.
    # First match wins, so a sheet carrying both spellings still resolves once.
    _lower = {str(c).strip().lower(): c for c in t.columns}
    resolved: dict[str, str] = {}
    for src, dest in tcols.items():
        hit = _lower.get(src.lower())
        if hit is not None and hit not in resolved:
            resolved[hit] = dest
    keep = ["sn"] + list(resolved)
    df = df.merge(t[keep].rename(columns=resolved), on="sn", how="left")

    # Apply the register's geography wherever the treatment list left a gap -
    # whether the column was dropped from the export entirely or is simply
    # blank for that episode. The treatment list wins when it has a value, so
    # exports that still carry `lga` behave exactly as before.
    for _dst, _fallback in (("state", "_geo_state"), ("lga", "_geo_lga"),
                            ("facility", "_geo_facility")):
        if _fallback in df.columns:
            have = df[_dst] if _dst in df.columns else pd.Series(pd.NA, index=df.index)
            df[_dst] = have.where(have.notna() & (have.astype("string").str.strip() != ""),
                                  df[_fallback])
    df = df.drop(columns=[c for c in ("_geo_state", "_geo_lga", "_geo_facility")
                          if c in df.columns])

    df["current_vl"] = pd.to_numeric(_col(df, "current_vl"), errors="coerce")
    df["current_vl_samp"] = pd.to_datetime(_col(df, "current_vl_samp"), errors="coerce")

    # Episode key: a client can have several. This, not sn, is the primary key.
    df["episode"] = (df["sn"].astype(str) + "|"
                     + df["idx_date"].dt.strftime("%Y-%m-%d").fillna("NA"))
    # Quarter = when the result reached the facility, floored into FY25Q4.
    df["enrol_quarter"] = df["recv_date"].map(fiscal_quarter)
    df["fy"] = df["enrol_quarter"].map(fiscal_year)

    df["state"] = df["state"].map(norm_state)
    df["sex"] = df["sex"].map({"F": "Female", "M": "Male"}).fillna("Unknown")
    df["age"] = pd.to_numeric(_col(df, "age"), errors="coerce")
    df["age_band"] = df["age"].map(age_band)
    df["paed"] = df["age"] < 20
    df["age_group"] = pd.cut(df["age"], [0, 10, 20, np.inf],
                             labels=["Under 10", "10-19", "20+"], right=False)
    df["days_on_art"] = pd.to_numeric(_col(df, "days_on_art"), errors="coerce")

    # --- socio-demographics: collapse the long tail, keep missing visible ---
    # ~23-31% are blank in the export. They become an explicit "Not recorded"
    # level rather than being dropped, so the model keeps its sample size and
    # the recording gap stays on the page instead of hiding in a footnote.
    def _norm(col, mapping):
        s = df.get(col)
        if s is None:
            return pd.Series("Not recorded", index=df.index)
        return (s.astype(str).str.strip().str.lower().map(mapping)
                 .fillna("Not recorded"))

    df["marital"] = _norm("marital", _MARITAL)
    df["job"] = _norm("job", _JOB)
    df["education"] = _norm("education", _EDU)
    df["who_stage"] = _norm("who_stage", _WHO)
    # Pregnancy is a female-only measure. Males and non-female rows are set to
    # N/A so the card can be reported on a female denominator (the export leaves
    # ~70k males blank, which otherwise swamps a "Not recorded" bar).
    preg = _norm("pregnancy", _PREG)
    df["pregnancy"] = preg.where(df["sex"] == "Female", "N/A")
    # BMI outside 10-60 is a recording error (weight/height swapped, zeros)
    bmi = pd.to_numeric(_col(df, "bmi"), errors="coerce")
    df["bmi"] = bmi.where((bmi >= 10) & (bmi <= 60))
    for rc in ("lga_res", "state_res"):
        if rc in df:
            df[rc] = df[rc].astype("string").str.strip()
    # Residence LGA, resolved to a canonical name so it can be filtered and
    # grouped. The raw value is kept alongside it: it is what the EMR actually
    # holds, and an unmatched entry is only diagnosable if the original text
    # survives. NULL here means "could not be matched", which is reported
    # rather than hidden.
    df["lga_res_norm"] = _col(df, "lga_res").map(canonical_lga_res)

    # Baseline CD4, BINARY (team review 18 Jul). Nigeria switched from a
    # quantitative CD4 assay to the semi-quantitative VISITEC LFA, so integer
    # FirstCD4 (old regime) and CD4_LFA (LessThan200 / GreaterTE200, new regime)
    # are BOTH valid and complementary. Combine them onto a single <200 vs >=200
    # split; the integer value wins when both exist.
    cd4 = pd.to_numeric(_col(df, "first_cd4"), errors="coerce")
    cd4 = cd4.where((cd4 >= 0) & (cd4 <= 3000))     # drop impossible integers
    df["first_cd4"] = cd4
    lfa_raw = _col(df, "cd4_lfa")
    lfa = (lfa_raw.astype(str).str.strip().str.lower() if lfa_raw is not None
           else pd.Series("", index=df.index))     # astype(str): NA -> 'nan'
    band = pd.Series(np.nan, index=df.index, dtype=object)
    band[lfa.eq("lessthan200")] = "<200"            # VISITEC LFA (new regime)
    band[lfa.eq("greaterte200")] = ">=200"
    band[cd4.notna() & (cd4 < 200)] = "<200"        # integer assay wins if present
    band[cd4.notna() & (cd4 >= 200)] = ">=200"
    df["cd4_band"] = band

    # --- time-to-VL, from ART start (EAC list dates) ---------------------
    art0 = pd.to_datetime(_col(df, "art_start"), errors="coerce")
    fev = pd.to_datetime(_col(df, "First_Ever_VL_Sample_Collection_Date"), errors="coerce")
    fhi = pd.to_datetime(_col(df, "First_High_VL_Sample_Collection_Date"), errors="coerce")
    ttfv = (fev - art0).dt.days
    ttfu = (fhi - art0).dt.days
    df["time_to_first_vl"] = ttfv.where(ttfv >= 0)
    df["time_to_first_unsupp"] = ttfu.where(ttfu >= 0)
    # ART-start year fixes the VL-monitoring era: routine VL scaled up with
    # Test-and-Treat around 2017/18, so pre-2018 starters have a long lag to
    # their first VL that is detection, not durability.
    df["art_year"] = art0.dt.year

    # ── EXIT DATE (when the client actually left care) ────────────────────
    # Outcomes_Date covers death / transferred out / discontinued (~99%), but
    # LTFU is only ~4% dated. For those, the exit is 28 days after the expected
    # return: last pharmacy pickup + days of ARV refill + 28 (LTFU definition).
    odate = pd.to_datetime(_col(df, "outcome_date"), errors="coerce")
    pickup = pd.to_datetime(_col(df, "last_pickup"), errors="coerce")
    refill = pd.to_numeric(_col(df, "days_refill"), errors="coerce")
    derived = pickup + pd.to_timedelta(refill.fillna(0), unit="D") + pd.Timedelta(days=28)
    neg = care_status(df).isin(_NEG_OUTCOMES)
    df["exit_date"] = odate.where(odate.notna(), derived).where(neg)
    df["exit_dated"] = df["exit_date"].notna()

    df["fy_quarter"] = df["enrol_quarter"]
    df["vl_magnitude"] = pd.cut(
        df["idx_vl"], [0, 10_000, 100_000, np.inf],
        labels=["1k-10k", "10k-100k", ">=100k"], right=False)

    # --- EAC validity ----------------------------------------------------
    # An EAC session dated BEFORE the index VL belongs to an earlier cycle. It
    # is not this episode's counselling. Those episodes are NOT excluded from
    # the cohort - they count as "no EAC on record yet", which is what they are.
    s1 = df["Session_1_Date"]
    df["eac_valid"] = (s1.notna() & (s1 >= df["idx_date"])).fillna(False).astype(bool)
    df["eac_prior_cycle"] = (s1.notna() & (s1 < df["idx_date"])).fillna(False).astype(bool)
    n_prior = int(df["eac_prior_cycle"].sum())
    if n_prior:
        warn.append(
            f"{n_prior} episodes have an EAC session dated before their index VL "
            f"(an earlier cycle). They are counted as NOT YET COMMENCED on EAC."
        )

    # §5: negative time-to-EAC is a data error, never a real value
    raw_lag = (s1 - df["idx_date"]).dt.days
    df["time_to_eac"] = raw_lag.where(raw_lag >= 0)
    n_neg = int((raw_lag < 0).sum())
    if n_neg:
        warn.append(f"{n_neg} negative time-to-EAC values excluded (spec §5).")

    # --- §4: EAC cascade flags -------------------------------------------
    v = df["eac_valid"]
    df["eac1"] = v
    df["eac2"] = v & df["Session_2_Date"].notna()
    df["eac3"] = v & df["Session_3_Date"].notna()
    df["eac_extended"] = v & (df["sessions"] >= 4)
    # eac_completed is defined further down: it now requires a follow-up VL SAMPLE
    # collected on/after session 3, so it must wait until fu_samp is known.

    # ── FOLLOW-UP VIRAL LOAD ──────────────────────────────────────────────
    # Sourced from the CLINICAL LINE LISTS, never from the EAC sheet.
    #
    # An episode's follow-up VL is the client's NEXT viral load after the index
    # result reached the facility. There are two places that next VL can appear:
    #
    #   (a) the client's NEXT failure episode in Total Unsuppressed - by
    #       definition >= 1,000, i.e. they failed again; or
    #   (b) the current VL on the Treatment line list - any value.
    #
    # Whichever was sampled first is the follow-up. This is why a repeat failure
    # automatically resolves as "still unsuppressed" on the earlier episode, and
    # therefore as a switch that should have happened and did not. No special
    # case is needed: the register already says it.
    df = df.sort_values(["sn", "idx_samp"], kind="mergesort").reset_index(drop=True)
    nxt_vl = df.groupby("sn")["idx_vl"].shift(-1)
    nxt_samp = df.groupby("sn")["idx_samp"].shift(-1)
    nxt_recv = df.groupby("sn")["recv_date"].shift(-1)

    cur_vl, cur_samp = df["current_vl"], df["current_vl_samp"]
    after = df["recv_date"]           # "any later VL" = sampled after the index
                                      # result was received at the facility

    # A SAMPLE, A RESULT, AND THE GAP BETWEEN THEM.
    #
    # Three states are possible on the treatment line list, and the pipeline
    # used to see only two. Working through what the programme actually does:
    # the index VL comes from the unsuppressed register, EAC is delivered, and
    # each new treatment line list is compared against that index to see what
    # has changed.
    #
    #   1. SAMPLE COLLECTION DATE UNCHANGED
    #      No post-EAC sample has been drawn. Nothing has happened.
    #
    #   2. SAMPLE DATE CHANGED, RESULT COLUMNS UNCHANGED
    #      A repeat sample HAS been collected, and the laboratory has not
    #      returned it yet. While it is out, the line list still carries the
    #      index result and the index received-date, because those columns are
    #      only rewritten when the new result lands. This is a turnaround-time
    #      state, not a service-delivery failure - the client has done their
    #      part. A later line list will carry the result.
    #
    #   3. SAMPLE DATE CHANGED, RESULT COLUMNS UPDATED
    #      The result is back and can be acted on.
    #
    # Reading a later sample date as a follow-up RESULT put state 2 into state
    # 3 and counted the index result twice: 247 of 2,089 on the 15 August
    # snapshot. Reading it as nothing at all - which an earlier attempt at this
    # fix did - collapses state 2 into state 1, and hides every client who is
    # waiting on a laboratory. Both are wrong, and they are wrong in opposite
    # directions: one inflates the switch backlog, the other conceals a lab
    # queue.
    #
    # So the sample date decides whether a sample exists, and the result
    # columns decide whether a result exists. A result has come back when
    # EITHER the value or the received-date has moved off the index - either is
    # sufficient, because a repeat test that happens to return the identical
    # value still arrives with a new received-date.
    new_sample = (cur_samp.notna() & (cur_samp > after)).fillna(False).astype(bool)
    # Coerced explicitly. The export carries this as TEXT ('2024-02-08
    # 00:00:00'), and comparing a string to a Timestamp is always unequal - so
    # the received-date half of the test would have fired for every row and
    # declared every result back.
    cur_recv = pd.to_datetime(df["current_recv"], errors="coerce")         if "current_recv" in df else pd.Series(pd.NaT, index=df.index)
    result_back = (
        (cur_vl.notna() & df["idx_vl"].notna() & (cur_vl != df["idx_vl"]))
        | (cur_recv.notna() & after.notna() & (cur_recv != after))
    ).fillna(False).astype(bool)

    cur_ok = new_sample
    nxt_ok = (nxt_samp.notna() & (nxt_samp > after)).fillna(False).astype(bool)
    # if both exist, take the earlier sample
    take_nxt = nxt_ok & (~cur_ok | (nxt_samp <= cur_samp).fillna(False).astype(bool))
    take_cur = cur_ok & ~take_nxt

    # The sample date stands on its own. The VALUE is carried only once the
    # result is actually back - a register-sourced follow-up is by definition a
    # recorded result, a treatment-sourced one only when the columns have moved.
    df["fu_samp"] = pd.to_datetime(
        np.where(take_nxt, nxt_samp, np.where(take_cur, cur_samp, pd.NaT)))
    df["fu_vl"] = np.where(take_nxt, nxt_vl,
                           np.where(take_cur & result_back, cur_vl, np.nan))
    # WHEN the follow-up result reached the facility - the client's exit from
    # the waiting state, and the far end of the wait the Deep dive reports.
    #
    # Dated from whichever source supplied the VALUE, which is the only way the
    # two can be talking about the same test. It used to come from the EAC
    # sheet's own Followup_VL_Result_Date, which is a different source's date
    # for a possibly different test - and in practice never arrived at all,
    # because that column is not on the merge whitelist, so fu_date was NULL
    # for all 4,228 episodes in the current snapshot. Nothing failed; the
    # column simply read as "not recorded" everywhere.
    _nr = pd.to_datetime(nxt_recv, errors="coerce")
    df["fu_date"] = pd.to_datetime(
        np.where(take_nxt, _nr.values,
                 np.where(take_cur & result_back, cur_recv.values,
                          np.datetime64("NaT"))))

    df["post_sample"] = df["fu_samp"].notna()
    df["post_result"] = df["fu_vl"].notna()
    # State 2: sample collected, laboratory has not reported. Actionable, and
    # actionable differently from "no sample" - this is a lab follow-up, not a
    # counselling or defaulter-tracing one.
    df["awaiting_result"] = df["post_sample"] & ~df["post_result"]

    # ── EAC COMPLETED + POST-EAC VL (team review, 17 Jul 2026) ───────────
    # Completed EAC   = sessions 1, 2 AND 3 all recorded, plus >=30 days elapsed
    #                   since session 3 (the counselling course is over).
    # Post-EAC VL     = sessions 1-3 recorded AND a VL sample collected on/after
    #                   session 3, irrespective of the 30-day rule (the client
    #                   actually returned for the post-EAC test).
    # The gap between them - completed but no post-EAC sample - is the new
    # `awaiting_vl` worklist. The follow-up VL (any later VL) stays as-is for
    # quality checks; as EMR EAC upload approaches 100% the two converge.
    eac123 = (df["eac1"] & df["eac2"] & df["eac3"]).fillna(False).astype(bool)
    df["post_eac_vl"] = (
        eac123 & df["fu_samp"].notna()
        & (df["fu_samp"] >= df["Session_3_Date"])
    ).fillna(False).astype(bool)
    df["eac_completed"] = (
        eac123 & ((as_of - df["Session_3_Date"]).dt.days >= EAC_COMPLETE_DAYS)
    ).fillna(False).astype(bool)

    df["resuppressed"] = df["post_result"] & (df["fu_vl"] < VL_FAIL)
    df["undetectable"] = df["post_result"] & (df["fu_vl"] < VL_UNDETECTABLE)
    df["llv"] = df["post_result"] & df["fu_vl"].between(VL_UNDETECTABLE, VL_FAIL - 1)
    df["still_unsuppressed"] = df["post_result"] & (df["fu_vl"] >= VL_FAIL)
    df["repeat_failure"] = take_nxt & (nxt_vl >= VL_FAIL)

    # ── SWITCHING (team review, 19 Jul 2026) ──────────────────────────────
    # A genuine switch requires the regimen at the INDEX unsuppressed VL to have
    # been first-line, and the client to be on 2nd/3rd line in a later treatment
    # list. Three groups among the still-unsuppressed:
    #   switched      - 1st line at index, now 2nd/3rd line;
    #   awaiting      - 1st line at index, still 1st line -> awaiting DTC review;
    #   prior_switch  - already 2nd/3rd line at index. Cannot be re-switched
    #                   without resistance testing, so they need a DTC drug-
    #                   history + VL review, not a switch.
    _2ND = r"2nd|second|3rd|third"
    line = df["regimen_line"].astype("string").str.lower()      # current
    df["on_second_line"] = line.str.contains(_2ND, regex=True, na=False)
    idxline = (df.get("idx_regimen_line",
                      pd.Series(pd.NA, index=df.index)).astype("string").str.lower())
    df["idx_on_2nd"] = idxline.str.contains(_2ND, regex=True, na=False)  # NA -> False (assume 1st)
    su = df["still_unsuppressed"]
    df["switch_eligible"] = (su & ~df["idx_on_2nd"]).fillna(False).astype(bool)
    df["switched"] = (su & ~df["idx_on_2nd"] & df["on_second_line"]).fillna(False).astype(bool)
    df["prior_switch"] = (su & df["idx_on_2nd"]).fillna(False).astype(bool)
    df["awaiting_switch"] = (su & ~df["idx_on_2nd"]
                             & ~df["on_second_line"]).fillna(False).astype(bool)

    samp = df["fu_samp"]
    res = df["fu_samp"]      # sample date is the clock for post-EAC timing
    # RE-BIND, DO NOT DELETE. `s1` was captured further up, BEFORE the
    # sort_values(...).reset_index(drop=True) that rebuilt this frame's row
    # order. Pandas aligns arithmetic on index LABELS, so the stale Series
    # silently paired each episode's follow-up sample with a *different*
    # episode's session-1 date - which is what produced impossible readings
    # like a negative lead time on an episode sampled months after session 1.
    s1 = df["Session_1_Date"]

    # --- truncation flag (spec §4) --------------------------------------
    # Truncation comes in two clinically different shapes, so they are two
    # separate cohorts rather than one blurred flag:
    #
    #  (a) PRE  - the follow-up sample was drawn BEFORE session 1. The cycle had
    #      not started when the client was retested, so a negative EAC lead time
    #      means there was no EAC to lead anything. Never caught by the old rule,
    #      which required the sample to fall after session 1.
    #  (b) MID  - the sample landed after session 1 or 2 but the cycle never
    #      reached session 3: counselling was cut short by the retest.
    #
    # Neither invalidates the cascade (the sessions did happen) - they are
    # worklists. `eac_truncated` stays as the union so existing callers hold.
    df["eac_trunc_pre"] = (
        samp.notna() & s1.notna() & (samp < s1)
    ).fillna(False).astype(bool)
    df["eac_trunc_mid"] = (
        samp.notna()
        & (
            (samp > s1) & df["Session_2_Date"].isna()
            | (samp > df["Session_2_Date"]) & df["Session_3_Date"].isna()
        )
    ).fillna(False).astype(bool)
    df["eac_truncated"] = (df["eac_trunc_pre"] | df["eac_trunc_mid"])

    # spec §2.3 rule 4 / §10.2
    df["dtc_review"] = (df["cycles"] > 2) & ~df["resuppressed"].astype(bool)

    # --- §5: time-dependent ---------------------------------------------
    # A negative interval here means the sample predates session 1 - that cycle
    # never started (eac_trunc_pre, its own worklist) and carries no lead time.
    lead_raw = (samp - s1).dt.days
    df["eac_lead_time"] = lead_raw.where(lead_raw >= 0)
    resupp_days = (res - s1).dt.days
    df["time_to_resupp"] = resupp_days.where(
        df["resuppressed"] & (resupp_days >= 0))
    df["months_unsuppressed"] = ((as_of - df["idx_date"]).dt.days / 30.44).round(1)

    df["treatment_plan"] = df.apply(_plan, axis=1, as_of=as_of)

    # The old single-snapshot Total Unsuppressed was drawn on the same day as the
    # line list, so a post-EAC VL had already overwritten currentViralLoad and the
    # outcome arm came out empty. The quarterly open cohort fixes that at source.
    # Warn only if the data in front of us actually has the problem.
    if mode == "snapshot" and len(df) and not df["post_result"].any():
        warn.append(
            "No post-EAC VL result exists for ANY client in this cohort. That is the "
            "signature of an index list drawn on the same date as the line list: a "
            "post-EAC VL becomes the current VL, so re-suppressors leave the cohort "
            "and the still-failing have no later result. Use quarterly index lists, "
            "or switch to cohort_mode=event."
        )

    return Cohort(df=df, as_of=as_of, mode=mode, warnings=warn)


# ── §6: treatment plan decision tree (priority-ordered, exactly one) ──
#
# Negative outcomes split in two, because the action differs completely.
#
# TERMINAL - the client has died or left this facility. No clinical action is
# possible here, so these are checked FIRST: a VL-based plan would otherwise be
# issued for someone who cannot receive it. Previously "Death" fell into
# "E. Track client" (you cannot track a dead client) and "Transferred out" was
# missing from the set entirely, so 38 episodes were told to draw a post-EAC
# sample at a facility the client had already left.
_TERMINAL = {"dead", "death", "died", "deceased",
             "transferred out", "transferred-out", "transfer out", "to"}

# NON-TERMINAL - disengaged but recoverable, so tracking is the action.
# Both hyphenations of "lost to follow-up" are listed: the export writes
# "Lost to followup", which silently missed the hyphenated-only set and sent
# those episodes off to a VL-based plan instead.
_NON_TERMINAL = {"iit", "stopped", "stopped treatment", "defaulted",
                 "lost to follow-up", "lost to followup", "ltfu",
                 "discontinued care", "discontinued"}


def _plan(r: pd.Series, as_of: pd.Timestamp) -> str:
    # `pd.NA or ""` raises; test for nullness explicitly.
    st = r.get("art_status")
    status = "" if st is None or pd.isna(st) else str(st).strip().lower()
    if status in _TERMINAL:
        return "H. No further action, confirm outcome in register and EMR"
    if status in _NON_TERMINAL:
        return "E. Track client"

    has_result = bool(r.get("post_result"))
    fu = r.get("fu_vl")

    if has_result and pd.notna(fu) and fu >= VL_FAIL and bool(r.get("eac_completed")):
        return "F. Refer to Drug Therapeutic Committee, update register and EMR"
    if has_result and pd.notna(fu) and fu < VL_FAIL:
        return "D. Repeat VL in 6 months, continue adherence counselling"

    idx = r.get("idx_date")
    recent = pd.notna(idx) and (as_of - idx).days <= 183

    if recent and not bool(r.get("eac1")):
        return "A. Commence EAC, update register and EMR"
    if recent and bool(r.get("eac1")) and not bool(r.get("eac_completed")):
        return "B. Complete EAC, update register and EMR"
    if pd.notna(idx) and not recent:
        return "C. Commence EAC, document register and EMR"
    return "G. Review manually"


# ── §4: cascade summary ───────────────────────────────────────────────
def cascade(df: pd.DataFrame) -> list[dict]:
    """
    Cascade under v3.1 definitions.

    Follow-up VL (steps 7-8) is ANY later VL from the clinical line lists, not a
    post-EAC result, so it is reported against the whole cohort (#1), not EAC1.
    Reporting it against #2 gave rates above 100% for mature quarters.

    Switching (step 10) is reported against the still-unsuppressed episodes (#9b,
    step 93): every episode whose follow-up VL is still >= 1,000. The export
    carries no switch date, so time-to-switch is not computable and the count
    cannot be attributed to a specific cycle - but the denominator is now the
    clinically correct one, not the whole cohort.
    """
    n = len(df)
    sex = df["sex"]
    allm = pd.Series(True, index=df.index)

    def m(col):
        return df[col].fillna(False).astype(bool)

    e1 = int(m("eac1").sum())
    resn = int(m("post_result").sum())
    unsupp = int(m("still_unsuppressed").sum())

    def step(i, label, mask, den, den_label, note=None):
        num = int(mask.sum())
        d = {"step": i, "label": label, "n": num,
             "n_female": int((mask & (sex == "Female")).sum()),
             "n_male": int((mask & (sex == "Male")).sum()),
             "denominator": int(den), "denominator_label": den_label,
             "pct": round(num / den * 100, 1) if den else None}
        if note:
            d["note"] = note
        return d

    return [
        step(1, "Total unsuppressed", allm, n, "-"),
        step(2, "EAC commenced", m("eac1"), n, "#1"),
        step(3, "EAC session 2", m("eac2"), e1, "#2"),
        step(4, "EAC session 3", m("eac3"), e1, "#2"),
        step(5, "Extended EAC (4+)", m("eac_extended"), e1, "#2"),
        step(6, "EAC completed", m("eac_completed"), e1, "#2"),
        step(61, "Post-EAC VL sample", m("post_eac_vl"),
             int((m("eac1") & m("eac2") & m("eac3")).sum()), "#4",
             note="Sessions 1-3 done AND a VL sample on/after session 3, "
                  "irrespective of the 30-day rule."),
        step(7, "Follow-up VL sample", m("post_sample"), n, "#1"),
        step(8, "Follow-up VL result", m("post_result"), n, "#1",
             note="Any later VL from the clinical line lists, not a post-EAC "
                  "result. Reported against the cohort, not EAC1."),
        step(9, "Re-suppressed (<1,000)", m("resuppressed"), resn, "#8"),
        step(91, "- Undetectable (<50)", m("undetectable"), resn, "#8"),
        step(92, "- LLV (50-999)", m("llv"), resn, "#8"),
        step(93, "Still unsuppressed", m("still_unsuppressed"), resn, "#8"),
        step(10, "Switched to 2nd/3rd line", m("switched"), unsupp, "#9b",
             note="Denominator = episodes still >= 1,000 after follow-up. No switch "
                  "date in the export, so time-to-switch is not computable."),
    ]


def time_metrics(df: pd.DataFrame) -> dict:
    def d(col, scale=1.0):
        s = pd.to_numeric(df[col], errors="coerce").dropna() * scale
        if s.empty:
            return None
        q1, q3 = float(s.quantile(.25)), float(s.quantile(.75))
        iqr = q3 - q1
        # Tukey whiskers, clamped to the observed data range
        wlo = max(float(s.min()), q1 - 1.5 * iqr)
        whi = min(float(s.max()), q3 + 1.5 * iqr)
        r = lambda v: round(v, 1)
        return {"n": int(s.size), "median": r(float(s.median())),
                "q1": r(q1), "q3": r(q3), "mean": r(float(s.mean())),
                "min": r(float(s.min())), "max": r(float(s.max())),
                "wlo": r(wlo), "whi": r(whi)}
    return {"time_to_eac": d("time_to_eac"),
            "eac_lead_time": d("eac_lead_time"),
            "time_to_resuppression": d("time_to_resupp"),
            "months_unsuppressed": d("months_unsuppressed"),
            "time_to_first_vl": d("time_to_first_vl", 1 / 30.44),      # months
            "time_to_first_unsupp": d("time_to_first_unsupp", 1 / 365.25)}  # years


def time_to_unsupp_curve(df: pd.DataFrame) -> dict:
    """
    Cumulative % reaching the FIRST unsuppressed VL by years on ART, from ART
    start. Every episode in this cohort is unsuppressed (the event is observed
    for all), so this is a cumulative-incidence curve, not a censored KM.

    Stratified by ART-start ERA because routine VL scaled up with Test-and-Treat
    around 2017/18: a pre-2018 starter's long lag to the first VL is partly
    detection, not durability, so the two strata must not be pooled.
    """
    y = pd.to_numeric(_col(df, "time_to_first_unsupp"), errors="coerce") / 365.25
    yr = pd.to_numeric(_col(df, "art_year"), errors="coerce")
    grid = np.arange(0.0, 15.01, 0.25)
    out = {}
    for label, mask in (("Started ART ≤2017 (pre / early T&T)", yr <= 2017),
                        ("Started ART ≥2018 (VL era)", yr >= 2018)):
        v = y[mask.fillna(False) & y.notna()].to_numpy()
        v = np.sort(v[(v >= 0) & (v <= 15)])
        if len(v) < 20:
            continue
        pts = [{"t": round(float(t), 2), "pct": round(float((v <= t).mean() * 100), 1)}
               for t in grid]
        out[label] = {"n": int(len(v)), "median": round(float(np.median(v)), 1),
                      "points": pts}
    return out


def kaplan_meier(df: pd.DataFrame) -> list[dict]:
    """
    Time from EAC session 1 to re-suppression. Clients who have not re-suppressed
    are right-censored, not dropped, so the curve does not flatter the programme.

    Reads only *persisted* columns (s1_date / fu_date / time_to_resupp), never the
    raw Excel headers: those exist during ingest but not when the cohort is read
    back from the database. An earlier version used Session_1_Date directly and
    worked in-process while 500-ing over HTTP.
    """
    s1 = df.get("s1_date", _col(df, "Session_1_Date"))
    fu = df.get("fu_date", _col(df, "Followup_VL_Result_Date"))
    if s1 is None:
        return []

    d = pd.DataFrame({
        "s1": pd.to_datetime(s1, errors="coerce"),
        "fu": pd.to_datetime(fu, errors="coerce"),
        "event": df["resuppressed"].fillna(False).astype(bool),
        "eac1": df["eac1"].fillna(False).astype(bool),
    })
    d = d[d["eac1"] & d["s1"].notna()]
    if d.empty:
        return []

    now = pd.Timestamp.today().normalize()
    # event -> days to the re-suppressing result; censored -> days observed so far
    d["t"] = (d["fu"].where(d["event"]).fillna(now) - d["s1"]).dt.days
    obs = d[["t", "event"]].dropna()
    obs = obs[(obs["t"] >= 0) & (obs["t"] < 900)].sort_values("t")
    if obs.empty:
        return []

    n, s, out = len(obs), 1.0, [{"t": 0, "survival": 1.0, "at_risk": len(obs)}]
    for tv, g in obs.groupby("t"):
        events = int(g["event"].sum())
        if events and n > 0:
            s *= 1 - events / n
            out.append({"t": int(tv), "survival": round(s, 4), "at_risk": int(n)})
        n -= len(g)
    return out


# ── descriptive profile: who / what / when / where ────────────────────
# Pure composition of the unsuppressed cohort — counts and shares, no models
# and no inference. The inferential work lives in deep_dive() / advanced.

def _dist(s, order=None, top=None, na="Not recorded") -> list[dict]:
    """Distribution of a series as [{level, n, pct}], honouring a fixed order."""
    if s is None:
        return []
    s = pd.Series(s).fillna(na).astype(str).replace({"nan": na, "None": na, "<NA>": na})
    vc = s.value_counts()
    n = int(vc.sum())
    if order:
        items = [(lv, int(vc.get(lv, 0))) for lv in order]
        items = [it for it in items if it[1] > 0]   # don't render empty levels
    else:
        items = [(str(k), int(v)) for k, v in vc.items()]
        if top:
            items = items[:top]
    return [{"level": k, "n": v, "pct": round(v / n * 100, 1) if n else 0.0}
            for k, v in items]


def _quart(s) -> dict | None:
    s = pd.to_numeric(s, errors="coerce").dropna()
    if s.empty:
        return None
    return {"n": int(s.size), "median": round(float(s.median()), 1),
            "q1": round(float(s.quantile(.25)), 1), "q3": round(float(s.quantile(.75)), 1)}


def profile(df: pd.DataFrame) -> dict:
    n = len(df)
    if not n:
        return {"n": 0}
    age = pd.to_numeric(_col(df, "age"), errors="coerce")
    yrs = pd.to_numeric(_col(df, "days_on_art"), errors="coerce") / 365
    cd4 = pd.to_numeric(_col(df, "first_cd4"), errors="coerce")
    tte = pd.to_numeric(_col(df, "time_to_eac"), errors="coerce")
    mu = pd.to_numeric(_col(df, "months_unsuppressed"), errors="coerce")

    def _band(v, cuts, labels, na="Not recorded"):
        if pd.isna(v):
            return na
        for c, l in zip(cuts, labels):
            if v < c:
                return l
        return labels[-1]

    yr_lab = ["<1 yr", "1-3 yr", "3-5 yr", "5-10 yr", "10+ yr"]
    mu_lab = ["<3 mo", "3-6 mo", "6-12 mo", "12+ mo"]
    eac_status = np.where(df["eac_completed"].fillna(False).astype(bool), "Completed EAC",
                 np.where(df["eac1"].fillna(False).astype(bool),
                          "Commenced, not completed", "Never commenced"))
    qs = sorted(x for x in df["enrol_quarter"].dropna().unique())

    # monthly arrivals into the cohort, dated by result received at facility
    mser = df.dropna(subset=["recv_date"]).copy()
    mser["recv_date"] = pd.to_datetime(mser["recv_date"], errors="coerce")
    mser = mser[mser["recv_date"] >= pd.Timestamp("2025-07-01")]
    mg = mser.groupby(mser["recv_date"].dt.to_period("M").dt.start_time).size()
    if len(mg):
        mg = mg.reindex(pd.date_range(mg.index.min(), mg.index.max(), freq="MS"),
                        fill_value=0)
    # ...and monthly EXITS, dated by when the follow-up result reached the
    # facility. An episode enters the cohort on an unsuppressed result and
    # leaves it when the repeat result comes back, so plotting only arrivals
    # answers half the question the panel asks. Reindexed onto the same month
    # axis as arrivals, so the two series are comparable month for month.
    xser = df.dropna(subset=["fu_date"]).copy()
    xser["fu_date"] = pd.to_datetime(xser["fu_date"], errors="coerce")
    xg = xser.groupby(xser["fu_date"].dt.to_period("M").dt.start_time).size()
    monthly = {"months": [d.strftime("%Y-%m-%d") for d in mg.index],
               "n": [int(x) for x in mg.values],
               "exits": [int(xg.get(d, 0)) for d in mg.index]}

    # The wait itself: index result received -> follow-up result received.
    # Only episodes that have actually exited; the ones still waiting have no
    # end date, and including them as zero would halve the median.
    _w = (pd.to_datetime(_col(df, "fu_date"), errors="coerce")
          - pd.to_datetime(_col(df, "recv_date"), errors="coerce")).dt.days
    _w = _w[_w.notna() & (_w >= 0)]
    if len(_w):
        _q1, _q3 = float(_w.quantile(.25)), float(_w.quantile(.75))
        _iqr = _q3 - _q1
        wait = {"n": int(_w.size), "median": round(float(_w.median()), 1),
                "q1": round(_q1, 1), "q3": round(_q3, 1),
                "mean": round(float(_w.mean()), 1),
                "min": round(float(_w.min()), 1), "max": round(float(_w.max()), 1),
                "wlo": round(max(float(_w.min()), _q1 - 1.5 * _iqr), 1),
                "whi": round(min(float(_w.max()), _q3 + 1.5 * _iqr), 1),
                "pending": int(df["awaiting_result"].fillna(False).sum())
                           if "awaiting_result" in df else 0}
    else:
        wait = None

    return {
        "n": n, "clients": int(df["sn"].nunique()),
        "who": {
            "median_age": round(float(age.median()), 0) if age.notna().any() else None,
            "female_pct": round(float((df["sex"] == "Female").mean() * 100), 1),
            "adolescent_pct": round(float(((age >= 10) & (age < 20)).mean() * 100), 1),
            "paed_pct": round(float((age < 10).mean() * 100), 1),
            "sex": _dist(_col(df, "sex"), ["Female", "Male", "Unknown"], na="Unknown"),
            "age_group": _dist(_col(df, "age_group"), ["Under 10", "10-19", "20+"]),
            "age_band": _dist(_col(df, "age_band"),
                              ["0-9", "10-19", "20-24", "25-34", "35-49", "50+", "Unknown"],
                              na="Unknown"),
            "marital": _dist(_col(df, "marital"),
                             ["Married", "Never married", "Previously married", "Other", "Not recorded"]),
            "education": _dist(_col(df, "education"),
                               ["Primary", "Secondary", "Tertiary", "Other", "Not recorded"]),
            "job": _dist(_col(df, "job"),
                         ["Employee", "Unemployed", "Student", "Other", "Not recorded"]),
            # female-only denominator (males are set to N/A upstream)
            "pregnancy": _dist(df.loc[df["sex"] == "Female", "pregnancy"]
                               if "pregnancy" in df else None,
                               ["Pregnant", "Breastfeeding", "Not pregnant", "Not recorded"]),
        },
        "what": {
            "median_years_art": round(float(yrs.median()), 1) if yrs.notna().any() else None,
            "regimen": _dist(np.where(df["on_second_line"].fillna(False).astype(bool),
                                      "2nd/3rd line", "1st line"), ["1st line", "2nd/3rd line"]),
            "vl_magnitude": _dist(_col(df, "vl_magnitude"), ["1k-10k", "10k-100k", ">=100k"]),
            "cd4": _dist(_col(df, "cd4_band"), ["<200", ">=200", "Not recorded"]),
            "years_art": _dist(yrs.map(lambda v: _band(v, [1, 3, 5, 10], yr_lab)),
                               yr_lab + ["Not recorded"]),
            "eac_status": _dist(pd.Series(eac_status, index=df.index),
                                ["Never commenced", "Commenced, not completed", "Completed EAC"]),
            "who_stage": _dist(_col(df, "who_stage"),
                               ["Stage 1", "Stage 2", "Stage 3", "Stage 4", "Not recorded"]),
            "bmi": _dist(pd.to_numeric(_col(df, "bmi"), errors="coerce")
                         .map(lambda v: _band(v, [18.5, 25, 30],
                              ["Underweight (<18.5)", "Normal (18.5-24.9)",
                               "Overweight (25-29.9)", "Obese (30+)"])),
                         ["Underweight (<18.5)", "Normal (18.5-24.9)",
                          "Overweight (25-29.9)", "Obese (30+)", "Not recorded"]),
            "plan": _dist(_col(df, "treatment_plan")),
        },
        "when": {
            "monthly": monthly,
            "wait": wait,
            "quarter": _dist(_col(df, "enrol_quarter"), qs),
            # ART start -> first-ever VL (the 6-month guideline clock) and
            # ART start -> first UNSUPPRESSED VL (how long treatment held).
            "time_to_first_vl": _dist(
                pd.to_numeric(_col(df, "time_to_first_vl"), errors="coerce")
                .map(lambda v: _band(v / 30.44, [6, 12, 24],
                     ["<6 mo", "6-12 mo", "1-2 yr", "2+ yr"])),
                ["<6 mo", "6-12 mo", "1-2 yr", "2+ yr", "Not recorded"]),
            "yrs_to_unsupp": _dist(
                pd.to_numeric(_col(df, "time_to_first_unsupp"), errors="coerce")
                .map(lambda v: _band(v / 365.25, [1, 3, 5, 10],
                     ["<1 yr", "1-3 yr", "3-5 yr", "5-10 yr", "10+ yr"])),
                ["<1 yr", "1-3 yr", "3-5 yr", "5-10 yr", "10+ yr", "Not recorded"]),
            "ttfv_months": _quart(pd.to_numeric(_col(df, "time_to_first_vl"),
                                   errors="coerce") / 30.44),
            "ttfu_years": _quart(pd.to_numeric(_col(df, "time_to_first_unsupp"),
                                  errors="coerce") / 365.25),
            "time_to_eac": _dist(tte.map(lambda v: _band(v, [31, 91], ["<=30 d", "31-90 d", ">90 d"],
                                                         na="No EAC on record")),
                                 ["<=30 d", "31-90 d", ">90 d", "No EAC on record"]),
            "months_unsupp": _dist(mu.map(lambda v: _band(v, [3, 6, 12], mu_lab)),
                                   mu_lab + ["Not recorded"]),
            "tte_stats": _quart(tte),
            "lead_stats": _quart(_col(df, "eac_lead_time")),
            "mu_stats": _quart(mu),
        },
        "care": _care_outcomes(df),
        "where": {
            "state": _dist(_col(df, "state"), na="Unknown"),
            "lga": _dist(_col(df, "lga"), top=10, na="Unknown"),
            "facility": _dist(_col(df, "facility"), top=10, na="Unknown"),
            "lga_res": _lga_res_map(df),
        },
    }


# data-entry spelling variants -> the official normalized LGA key used in
# static/nga_lga_3states.geojson (properties.key)
def _norm_lga(v) -> str:
    """Strip everything but letters and digits: 'Ughelli-North ' -> 'ughellinorth'."""
    return re.sub(r"[^a-z0-9]", "", str(v).lower())


@lru_cache(maxsize=1)
def _lga_lookup() -> dict[str, tuple[str, str]]:
    """
    Normalised key -> (canonical LGA name, state).

    Two layers, and the order matters:

    1. The three programme states, from the boundary file the choropleth draws.
       These win, because their spellings are the ones the map can render and
       the ones the team recognises.
    2. Every other Nigerian LGA, names only. Clients do live outside the
       programme states, and before this they simply fell into "unmatched".
       They are filterable and groupable; they have no polygon, so the map
       leaves them out - which is right, they are outside the mapped area.
    """
    static = pathlib.Path(__file__).resolve().parents[1] / "static"
    out: dict[str, tuple[str, str]] = {}

    # Layer 2 first, so layer 1 overwrites any name the two spell differently
    # (the national set writes Ayedaade / Ilesha East where ours writes
    # Aiyedaade / Ilesa East).
    try:
        national = json.loads((static / "nga_lga_names.json").read_text(encoding="utf8"))
        for name in national.get("lgas", []):
            out[_norm_lga(name)] = (name, "")
    except Exception:                       # noqa: BLE001 - optional
        log.warning("national LGA name list unreadable; residences outside the "
                    "programme states will not resolve")

    try:
        feats = json.loads((static / "nga_lga_3states.geojson").read_text(encoding="utf8"))
        for f in feats["features"]:
            p = f.get("properties", {})
            name, state, key = p.get("lga"), p.get("state"), p.get("key")
            if name and key:
                out[key] = (name, state or "")
    except Exception:                       # noqa: BLE001 - map file is optional
        log.warning("LGA boundary file unreadable; residence LGA left un-normalised")

    return out


def canonical_lga_res(v) -> str | None:
    """
    Free-text residence -> the canonical LGA name, or None where it cannot be
    matched confidently.

    The EMR records this as free text, so the same LGA arrives as 'UGHELLI
    NORTH', 'Ughelli North' and worse. Left raw it produced 190 distinct values
    for 71 real LGAs - fine for the map, which normalises before drawing, but
    unusable as a filter where each spelling would be its own option.

    Deliberately returns None rather than guessing: 'Oshimili' (North or
    South?) and 'Ile-Ife' (Central or East?) are genuinely ambiguous, and an
    unmatched share that is reported is worth more than a wrong assignment.
    """
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    k = _norm_lga(v)
    if not k:
        return None
    hit = _lga_lookup().get(_LGA_ALIAS.get(k, k))
    return hit[0] if hit else None


_LGA_ALIAS = {
    "ayedade": "aiyedaade", "ayedaade": "aiyedaade", "ayedire": "aiyedire",
    "ileshaeast": "ilesaeast", "ileshawest": "ilesawest",
    "atakumosaeast": "atakunmosaeast", "atakumosawest": "atakunmosawest",
    "adoekiti": "adoekiti", "idoosiekiti": "idoosi",
    # unambiguous fixes only: misspellings and HQ-town -> LGA facts.
    # "Ile-Ife" (Central vs East) stays ambiguous and is left unmatched.
    "sepele": "sapele", "ikire": "irewole",
    "iseeleuku": "aniochanorth", "isseleuku": "aniochanorth",
    # Bare "Oshimili" resolves to Oshimili South: every programme facility in
    # Oshimili sits in the South LGA (confirmed by the programme team, 3 Aug).
    # This is the single largest unmatched value - 221 episodes.
    "oshimili": "oshimilisouth",
    # Bare "Ado" is Ado Ekiti, not the Ado LGA in Benue that the national list
    # would otherwise match. Confirmed by the programme team: these are Ekiti
    # clients naming the state capital.
    "ado": "adoekiti",
}


def care_status(df) -> pd.Series:
    """CurrentARTStatus normalised to a care outcome (Active / LTFU / Died / ...)."""
    s = _col(df, "art_status")
    if s is None:
        return pd.Series("Not recorded", index=df.index)
    return (s.astype(str).str.strip().str.lower().map(_ART_STATUS)
             .fillna("Not recorded"))


_EXIT_WHEN = ["Before the index VL", "Before EAC commencement",
              "During EAC, before the repeat VL", "After the repeat VL",
              "Exit date unknown"]


def _care_outcomes(df) -> dict:
    """Negative ART outcomes, dated, and WHEN the exit happened.

    Exit date = Outcomes_Date where present (death / transferred out /
    discontinued are ~99% dated); for LTFU, which is only ~4% dated, it is the
    expected return plus the LTFU grace period: last pharmacy pickup + days of
    ARV refill + 28 days. That lets us place the exit against EAC commencement
    (session 1) and the repeat VL sample, instead of only saying "never tested".
    """
    st = care_status(df)
    neg = st.isin(_NEG_OUTCOMES)
    no_fu = ~df["post_result"].fillna(False).astype(bool)
    no_peac = ~df["post_eac_vl"].fillna(False).astype(bool)
    n = len(df)

    exit_d = pd.to_datetime(_col(df, "exit_date"), errors="coerce")
    idx = pd.to_datetime(_col(df, "idx_date"), errors="coerce")
    s1 = pd.to_datetime(df.get("s1_date", _col(df, "Session_1_Date")), errors="coerce")
    fu = pd.to_datetime(_col(df, "fu_samp"), errors="coerce")

    when = pd.Series("Exit date unknown", index=df.index, dtype=object)
    dated = neg & exit_d.notna()
    # order matters: earliest reference point wins
    after_vl = dated & fu.notna() & (exit_d >= fu)
    during = dated & s1.notna() & (exit_d >= s1) & ~after_vl
    before_eac = dated & ~after_vl & ~during
    before_idx = dated & idx.notna() & (exit_d < idx)
    when[before_eac] = "Before EAC commencement"
    when[during] = "During EAC, before the repeat VL"
    when[after_vl] = "After the repeat VL"
    when[before_idx] = "Before the index VL"      # already out of care at index

    rows = []
    for lv in _NEG_OUTCOMES:
        m = st == lv
        k = int(m.sum())
        if not k:
            continue
        rows.append({"level": lv, "n": k,
                     "dated": int((m & exit_d.notna()).sum()),
                     "no_followup_vl": int((m & no_fu).sum()),
                     "no_post_eac_vl": int((m & no_peac).sum())})
    return {
        "status": _dist(st, ["Active"] + _NEG_OUTCOMES + ["Not recorded"]),
        "neg_total": int(neg.sum()),
        "neg_pct": round(float(neg.mean()) * 100, 1) if n else None,
        "neg_no_followup": int((neg & no_fu).sum()),
        "neg_no_post_eac": int((neg & no_peac).sum()),
        "neg_dated": int(dated.sum()),
        "exit_when": _dist(when[neg], _EXIT_WHEN),
        "breakdown": rows,
    }


def _lga_res_map(df) -> dict:
    """Aggregate free-text residence LGA onto boundary keys for the map, with a
    per-LGA sex + CALHIV (<20 yr) breakdown for the hover tooltip.

    The EMR field is free text (towns, misspellings), so a share will never
    match an LGA polygon - that share is reported, not hidden.
    """
    s = _col(df, "lga_res") if hasattr(df, "get") else None
    if s is None:
        return {"counts": {}, "total": 0}
    age = pd.to_numeric(_col(df, "age"), errors="coerce")
    # Same normalisation as canonical_lga_res, so the map and the residence-LGA
    # filter can never disagree about which LGA a client belongs to.
    d = pd.DataFrame({
        "k": s.astype(str).map(lambda v: _LGA_ALIAS.get(_norm_lga(v), _norm_lga(v))),
        "f": (df["sex"] == "Female").astype(int),
        "m": (df["sex"] == "Male").astype(int),
        "peds": (age < 10).fillna(False).astype(int),
        "adol": ((age >= 10) & (age < 20)).fillna(False).astype(int),
    })
    d = d[s.notna().to_numpy()]
    counts: dict[str, dict] = {}
    for k, g in d.groupby("k"):
        counts[k] = {"n": int(len(g)), "f": int(g["f"].sum()), "m": int(g["m"].sum()),
                     "peds": int(g["peds"].sum()), "adol": int(g["adol"].sum())}
    return {"counts": counts, "total": int(s.notna().sum())}


def breakdown(df: pd.DataFrame, by: str) -> list[dict]:
    if by not in df:
        return []
    rows = []
    for k, g in df.groupby(by, dropna=False, observed=True):
        e1, r = int(g["eac1"].sum()), int(g["post_result"].sum())
        # A null group key rendered as the literal string "nan", which is not a
        # place, a sex, or anything else a reader can act on. For residence LGA
        # this bucket also holds free text that matched no boundary, so the
        # label has to cover both cases without implying the value was blank.
        blank = k is None or (isinstance(k, float) and pd.isna(k)) or str(k).lower() == "nan"
        rows.append({
            "group": "Not recorded / unmatched" if blank else str(k), "n": len(g),
            "eac1": e1, "eac1_pct": round(e1 / len(g) * 100, 1) if len(g) else None,
            "post_result": r,
            "resuppressed": int(g["resuppressed"].sum()),
            "resupp_pct": round(int(g["resuppressed"].sum()) / r * 100, 1) if r else None,
            "still_unsuppressed": int(g["still_unsuppressed"].sum()),
            "switched": int(g["switched"].sum()),
        })
    return sorted(rows, key=lambda x: -x["n"])


# ── §7.3 deep dive: association of re-suppression with each variable ───
# Outcome = re-suppressed (post-EAC VL < 1,000) among episodes that HAVE a
# follow-up VL. Everything is hand-rolled in numpy so the image ships no
# scipy/statsmodels. Univariate OR (Woolf CI) + chi-square/trend per variable;
# adjusted OR from one multivariable logistic (Newton-Raphson, Wald CIs).

def _phi(z: float) -> float:            # standard-normal CDF
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _p_z(z: float) -> float:            # two-sided p from a z-score
    if math.isnan(z) or math.isinf(z):
        return 0.0 if math.isinf(z) else 1.0
    return round(2 * (1 - _phi(abs(z))), 4)


def _sexp(x: float) -> float:           # exp clamped so a separated fit can't overflow
    if math.isnan(x):
        return float("nan")
    return math.exp(max(-30.0, min(30.0, x)))


def _or_2x2(a, b, c, d):
    """OR of (exposed vs ref) x (event vs none); Haldane 0.5 if any zero."""
    a, b, c, d = float(a), float(b), float(c), float(d)
    if min(a, b, c, d) == 0:
        a, b, c, d = a + .5, b + .5, c + .5, d + .5
    lor = math.log((a * d) / (b * c))
    se = math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
    return (round(_sexp(lor), 2), round(_sexp(lor - 1.96 * se), 2),
            round(_sexp(lor + 1.96 * se), 2), _p_z(lor / se))


def _chi2_p(tab: np.ndarray) -> float:
    """Pearson chi-square p-value for an r x c table (Wilson-Hilferty approx)."""
    tab = tab.astype(float)
    r, c = tab.shape
    exp = tab.sum(1, keepdims=True) * tab.sum(0, keepdims=True) / tab.sum()
    with np.errstate(divide="ignore", invalid="ignore"):
        chi2 = np.nansum(np.where(exp > 0, (tab - exp) ** 2 / exp, 0))
    k = (r - 1) * (c - 1)
    if k <= 0:
        return 1.0
    # Wilson-Hilferty: (chi2/k)^(1/3) ~ Normal(1-2/(9k), 2/(9k))
    t = (chi2 / k) ** (1 / 3)
    z = (t - (1 - 2 / (9 * k))) / math.sqrt(2 / (9 * k))
    return round(1 - _phi(z), 4)


def _mannwhitney_p(x: np.ndarray, y: np.ndarray) -> float:
    """Two-sided Mann-Whitney U with tie-corrected normal approximation."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    x, y = x[~np.isnan(x)], y[~np.isnan(y)]
    n1, n2 = len(x), len(y)
    if n1 == 0 or n2 == 0:
        return 1.0
    allv = np.concatenate([x, y])
    order = allv.argsort()
    ranks = np.empty(len(allv))
    ranks[order] = np.arange(1, len(allv) + 1)
    # average ties
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.zeros(len(cnt))
    np.add.at(sums, inv, ranks)
    ranks = (sums / cnt)[inv]
    r1 = ranks[:n1].sum()
    u1 = r1 - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    _, tc = np.unique(allv, return_counts=True)
    N = n1 + n2
    tie = (tc ** 3 - tc).sum()
    sd = math.sqrt(n1 * n2 / 12 * ((N + 1) - tie / (N * (N - 1))))
    if sd == 0:
        return 1.0
    return _p_z((u1 - mu) / sd)


def _cochran_armitage_p(counts: list[tuple[int, int]]) -> float:
    """Trend test across ordered groups; scores 0..k-1. counts=[(events,n)]."""
    k = len(counts)
    if k < 3:
        return 1.0
    scores = np.arange(k, dtype=float)
    ev = np.array([c[0] for c in counts], float)
    nn = np.array([c[1] for c in counts], float)
    N = nn.sum()
    R = ev.sum()
    if N == 0 or R in (0, N):
        return 1.0
    pbar = R / N
    num = (scores * (ev - nn * pbar)).sum()
    sbar = (nn * scores).sum() / N
    var = pbar * (1 - pbar) * (nn * (scores - sbar) ** 2).sum()
    if var <= 0:
        return 1.0
    return _p_z(num / math.sqrt(var))


def _logit_fit(X: np.ndarray, y: np.ndarray):
    """Newton-Raphson logistic fit. Returns (beta, se) with a tiny ridge."""
    n, k = X.shape
    beta = np.zeros(k)
    ridge = 1e-3 * np.eye(k)   # mild L2 to tame quasi-separated sparse levels
    ridge[0, 0] = 0.0          # never penalise the intercept
    for _ in range(60):
        p = 1 / (1 + np.exp(-(X @ beta)))
        W = np.clip(p * (1 - p), 1e-9, None)
        H = X.T @ (X * W[:, None]) + ridge
        grad = X.T @ (y - p)
        try:
            step = np.linalg.solve(H, grad)
        except np.linalg.LinAlgError:
            break
        beta += step
        if np.max(np.abs(step)) < 1e-8:
            break
    p = 1 / (1 + np.exp(-(X @ beta)))
    W = np.clip(p * (1 - p), 1e-9, None)
    cov = np.linalg.inv(X.T @ (X * W[:, None]) + ridge)
    return beta, np.sqrt(np.diag(cov))


# variable spec: (col, label, ordered?, reference level, level order, trend subset)
# trend subset = the genuinely ordinal levels a Cochran-Armitage test may use;
# None means "use every level". Education is ordinal only across Primary ->
# Tertiary — "Other"/"Not recorded" have no place on that scale.
_DD_SPECS = [
    ("_sex", "Sex", False, "Female", ["Female", "Male"], None),
    ("_age", "Age band", True, "25-34",
     ["0-9", "10-19", "20-24", "25-34", "35-49", "50+"], None),
    ("_state", "State", False, "Delta", ["Delta", "Osun", "Ekiti"], None),
    ("_reg", "Regimen line", False, "1st line", ["1st line", "2nd/3rd line"], None),
    ("_vl", "Index VL band", True, "1k-10k", ["1k-10k", "10k-100k", ">=100k"], None),
    ("_marital", "Marital status", False, "Married",
     ["Married", "Never married", "Previously married", "Other", "Not recorded"], None),
    ("_job", "Employment", False, "Employee",
     ["Employee", "Unemployed", "Student", "Other", "Not recorded"], None),
    ("_edu", "Education", True, "Secondary",
     ["Primary", "Secondary", "Tertiary", "Other", "Not recorded"],
     ["Primary", "Secondary", "Tertiary"]),
    # NB: repeat-failure is deliberately NOT a predictor — a repeat-failure episode
    # has, by definition, a follow-up VL >= 1,000, so it can never be re-suppressed.
    # It is the outcome restated (perfect separation), not a risk factor.
    # NB: baseline CD4 is descriptive only (see `cd4` below) — 31% coverage.
]


def deep_dive(df: pd.DataFrame) -> dict:
    d = df[df["post_result"].fillna(False).astype(bool)].copy()
    if len(d) < 100:
        return {"ok": False,
                "reason": f"Only {len(d)} episodes have a follow-up VL; at least 100 "
                          f"are needed to model re-suppression."}
    yn = pd.to_numeric(d["days_on_art"], errors="coerce") / 365
    d = d.assign(
        _sex=d["sex"],
        _age=d["age_band"],
        _state=d["state"],
        _reg=np.where(d["on_second_line"].fillna(False).astype(bool),
                      "2nd/3rd line", "1st line"),
        _vl=d["vl_magnitude"],
        _marital=d.get("marital", pd.Series("Not recorded", index=d.index)),
        _job=d.get("job", pd.Series("Not recorded", index=d.index)),
        _edu=d.get("education", pd.Series("Not recorded", index=d.index)),
        _yrs=yn,
        _y=d["resuppressed"].fillna(False).astype(int),
    )

    # ── multivariable design (complete cases) ─────────────────────────────
    cc = d.dropna(subset=["_yrs"]).copy()
    for key, _, _, _, levels, _t in _DD_SPECS:
        cc = cc[cc[key].isin(levels)]
    cols, names = [np.ones(len(cc))], ["_const"]
    for key, _, _, ref, levels, _t in _DD_SPECS:
        for lv in levels:
            if lv == ref:
                continue
            cols.append((cc[key] == lv).astype(float).to_numpy())
            names.append(f"{key}::{lv}")
    yrs_c = cc["_yrs"].to_numpy() - cc["_yrs"].mean()
    cols.append(yrs_c)
    names.append("_yrs")
    X = np.column_stack(cols)
    yv = cc["_y"].to_numpy()
    beta, se = _logit_fit(X, yv)
    aor = {}
    for i, nm in enumerate(names):
        b, s = float(beta[i]), float(se[i])
        aor[nm] = (round(_sexp(b), 2), round(_sexp(b - 1.96 * s), 2),
                   round(_sexp(b + 1.96 * s), 2), _p_z(b / s) if s > 0 else 1.0)

    def flag(lo, hi):
        if lo > 1:
            return "pos"
        if hi < 1:
            return "neg"
        return "ns"

    # ── per-variable univariate + attach AOR ──────────────────────────────
    variables = []
    for key, label, ordered, ref, levels, trend_levels in _DD_SPECS:
        sub = d[d[key].isin(levels)]
        refm = sub[key] == ref
        c_ev = int(sub.loc[refm, "_y"].sum())     # ref & re-suppressed
        c_no = int(refm.sum()) - c_ev             # ref & not re-suppressed
        rows, tab = [], []
        for lv in levels:
            m = sub[key] == lv
            nlv = int(m.sum())
            ev = int(sub.loc[m, "_y"].sum())
            tab.append([ev, nlv - ev])
            row = {"level": lv, "n": nlv, "resupp": ev,
                   "rate": round(ev / nlv * 100, 1) if nlv else None, "ref": lv == ref}
            if lv == ref:
                row.update(or_=1.0, or_lo=None, or_hi=None, or_p=None)
            else:
                o, lo, hi, p = _or_2x2(ev, nlv - ev, c_ev, c_no)
                row.update(or_=o, or_lo=lo, or_hi=hi, or_p=p)
            a = aor.get(f"{key}::{lv}")
            if lv == ref:
                row.update(aor=1.0, aor_lo=None, aor_hi=None, aor_p=None, flag="ref")
            elif a:
                row.update(aor=a[0], aor_lo=a[1], aor_hi=a[2], aor_p=a[3], flag=flag(a[1], a[2]))
            else:
                row.update(aor=None, aor_lo=None, aor_hi=None, aor_p=None, flag="ns")
            rows.append(row)
        if ordered:
            # the trend runs only over the genuinely ordinal levels
            tl = trend_levels or levels
            test, tp = "Cochran-Armitage trend", _cochran_armitage_p(
                [(r["resupp"], r["n"]) for r in rows if r["level"] in tl])
        else:
            test, tp = "Chi-square", _chi2_p(np.array([t for t in tab if sum(t)]))
        variables.append({"key": key, "label": label,
                          "type": "ordered" if ordered else "categorical",
                          "test": test, "test_p": tp, "levels": rows})

    # ── continuous: years on ART ─────────────────────────────────────────
    yrs = d["_yrs"]
    a = aor.get("_yrs")
    variables.append({
        "key": "_yrs", "label": "Years on ART", "type": "continuous",
        "test": "Mann-Whitney U", "test_p": _mannwhitney_p(
            yrs[d["_y"] == 1].to_numpy(), yrs[d["_y"] == 0].to_numpy()),
        "median_resupp": round(float(yrs[d["_y"] == 1].median()), 1),
        "median_not": round(float(yrs[d["_y"] == 0].median()), 1),
        "aor": a[0] if a else None, "aor_lo": a[1] if a else None,
        "aor_hi": a[2] if a else None, "aor_p": a[3] if a else None,
        "flag": flag(a[1], a[2]) if a else "ns", "unit": "per year",
    })

    # ── baseline CD4 (binary): DESCRIPTIVE ONLY ──────────────────────────
    # Measured at ART initiation, so it predates the index VL (no reverse
    # causation), but coverage is partial. `cd4_band` already merges the old
    # integer assay and the new VISITEC LFA onto a single <200 vs >=200 split.
    cb = d.get("cd4_band")
    cb = cb.astype("string") if cb is not None else pd.Series(pd.NA, index=d.index)
    cd4_rows = []
    for lv in ["<200", ">=200", "Not recorded"]:
        m = (cb == lv) if lv != "Not recorded" else cb.isna()
        nlv = int(m.sum())
        ev = int(d.loc[m, "_y"].sum())
        cd4_rows.append({"level": lv, "n": nlv, "resupp": ev,
                         "rate": round(ev / nlv * 100, 1) if nlv else None})
    known = cb.notna()
    tab4 = [[r["resupp"], r["n"] - r["resupp"]]
            for r in cd4_rows if r["level"] != "Not recorded" and r["n"]]
    cd4_out = {
        "coverage_pct": round(float(known.mean()) * 100, 1),
        "n_known": int(known.sum()),
        "median": None,   # binary now - no median
        "levels": cd4_rows,
        "test": "Chi-square (recorded only)",
        "test_p": _chi2_p(np.array(tab4)) if len(tab4) > 1 else None,
    }

    return {"ok": True, "n_model": int(len(d)), "events": int(d["_y"].sum()),
            "cc_n": int(len(cc)), "resupp_pct": round(d["_y"].mean() * 100, 1),
            "variables": variables, "cd4": cd4_out}


# ── repeat-unsuppression & DTC-review cohort ──────────────────────────
# Two distinct groups the switch pathway cares about:
#   - repeat unsuppression: a client with more than one unsuppression episode
#     (unsuppressed again after an earlier index VL);
#   - DTC review: episodes still >= 1,000 on the follow-up VL and NOT yet
#     switched. The 37 already switched are shown separately, not dropped.
_DTC_SPECS = [
    ("_sex", "Sex", ["Female", "Male"], "Female"),
    ("_age", "Age group", ["Under 10", "10-19", "20+"], "20+"),
    ("_reg", "Regimen line", ["1st line", "2nd/3rd line"], "1st line"),
    ("_cd4", "Baseline CD4", ["<200", ">=200"], ">=200"),
    ("_vl", "Index VL band", ["1k-10k", "10k-100k", ">=100k"], "1k-10k"),
]


def dtc_review(df: pd.DataFrame) -> dict:
    n = len(df)
    if not n:
        return {"ok": False}
    sn = df.get("sn", pd.Series(range(n), index=df.index))
    rep = sn.duplicated(keep=False)
    still = df["still_unsuppressed"].fillna(False).astype(bool)
    # Repeat unsuppression, restricted to episodes STILL >= 1,000 after the
    # follow-up / post-EAC VL. This is the switch-relevant subset: a client who
    # failed more than once AND has not re-suppressed. It nests inside `still`,
    # unlike the raw repeat count, which also includes repeat clients who did
    # re-suppress and so are not switch candidates at all. The univariate OR
    # analysis below deliberately stays on ALL repeats (`rep`) as a broader
    # descriptive signal - only this headline is the subset.
    rep_still = rep & still
    switched = df["switched"].fillna(False).astype(bool)
    awaiting = df["awaiting_switch"].fillna(False).astype(bool)
    prior = df.get("prior_switch", pd.Series(False, index=df.index)).fillna(False).astype(bool)
    dtc = df["dtc_review"].fillna(False).astype(bool)

    d = df.assign(
        _rep=rep.astype(int),
        _sex=df["sex"],
        _age=_col(df, "age_group"),
        _reg=np.where(df["on_second_line"].fillna(False).astype(bool),
                      "2nd/3rd line", "1st line"),
        _cd4=_col(df, "cd4_band"),
        _vl=_col(df, "vl_magnitude"),
        _still=still, _await=awaiting, _switched=switched, _prior=prior)

    def rate(a, b):
        return round(a / b * 100, 1) if b else None

    # (b) univariate associations with being a repeat-unsuppression episode
    assoc = []
    for key, label, levels, ref in _DTC_SPECS:
        sub = d[d[key].isin(levels)]
        refm = sub[key] == ref
        c_ev = int(sub.loc[refm, "_rep"].sum())
        c_no = int(refm.sum()) - c_ev
        rows = []
        for lv in levels:
            m = sub[key] == lv
            nn = int(m.sum())
            ev = int(sub.loc[m, "_rep"].sum())
            row = {"level": lv, "n": nn, "repeat": ev, "pct": rate(ev, nn),
                   "ref": lv == ref}
            if lv == ref:
                row.update(or_=1.0, or_lo=None, or_hi=None, or_p=None)
            else:
                o, lo, hi, p = _or_2x2(ev, nn - ev, c_ev, c_no)
                row.update(or_=o, or_lo=lo, or_hi=hi, or_p=p)
            rows.append(row)
        assoc.append({"label": label, "levels": rows})

    # (c) switch gap: still-unsuppressed split by dimension
    def gap_by(key, levels):
        out = []
        g = d[d["_still"]]
        for lv in levels:
            m = g[key] == lv
            ns = int(m.sum())
            if not ns:
                continue
            aw = int(g.loc[m, "_await"].sum())
            sw = int(g.loc[m, "_switched"].sum())
            pr = int(g.loc[m, "_prior"].sum())
            out.append({"level": lv, "still": ns, "awaiting": aw, "switched": sw,
                        "prior": pr, "pct_awaiting": rate(aw, ns)})
        return out

    mu = pd.to_numeric(d["months_unsuppressed"], errors="coerce")
    d = d.assign(_mub=mu.map(lambda v: (
        "Not recorded" if pd.isna(v) else "<3 mo" if v < 3 else
        "3-6 mo" if v < 6 else "6-12 mo" if v < 12 else "12+ mo")))
    states = [s for s in ["Delta", "Osun", "Ekiti"]
              if (d["state"] == s).any()]

    return {
        "ok": True,
        "summary": {
            # clients who unsuppressed >1 time (>=2 episodes), the episodes those
            # clients account for, and the repeat-OCCURRENCE episodes (2nd, 3rd...)
            "repeat_clients": int((sn.value_counts() > 1).sum()),
            "repeat_episodes": int(rep.sum()),
            "repeat_occurrences": int(n - sn.nunique()),
            # the switch-relevant subset: repeat episodes still >= 1,000, and the
            # clients they belong to. A strict subset of `still`.
            "repeat_still_episodes": int(rep_still.sum()),
            "repeat_still_clients": int(sn[rep_still].nunique()),
            "still": int(still.sum()),
            "switched": int(switched.sum()),
            "awaiting": int(awaiting.sum()),
            "prior": int(prior.sum()),
            "dtc_flag": int(dtc.sum()),
        },
        "repeat_assoc": {"n": int(rep.sum()), "pct": rate(int(rep.sum()), n),
                         "variables": assoc},
        "switch_gap": {
            "n_still": int(still.sum()), "awaiting": int(awaiting.sum()),
            "switched": int(switched.sum()), "prior": int(prior.sum()),
            "by_state": gap_by("state", states),
            "by_regimen": gap_by("_reg", ["1st line", "2nd/3rd line"]),
            "by_months": gap_by("_mub", ["<3 mo", "3-6 mo", "6-12 mo", "12+ mo"]),
            "by_cd4": gap_by("_cd4", ["<200", ">=200"]),
        },
        # Computed from idx_vl and fu_vl at request time, so it works on every
        # snapshot already loaded - no re-upload needed to see it.
        "log_drop": log_drop(df),
    }


# ── log drop: is the viral load responding at all? ────────────────────
# Among episodes still >= 1,000 after EAC, "still failing" lumps together two
# clinically opposite situations. A client whose VL fell from 400,000 to 3,000
# is responding to adherence support and may finish the job with another cycle.
# A client whose VL is unchanged, or has risen, is not an adherence problem -
# that is the resistance picture, and another counselling cycle spends months
# to reach the same place.
#
# log10(index) - log10(follow-up). A 1-log fall is a tenfold reduction and the
# conventional threshold for calling a response credible.
_LOG_BANDS = [
    (2.0,  float("inf"), "Fell >2 log",        "responding well"),
    (1.0,  2.0,          "Fell 1-2 log",       "substantial response"),
    (0.5,  1.0,          "Fell 0.5-1 log",     "partial response"),
    (0.0,  0.5,          "Fell <0.5 log",      "essentially no fall"),
    (float("-inf"), 0.0, "Viral load rose",    "worse than at index"),
]


def log_drop(df: pd.DataFrame) -> dict:
    """Distribution of the log10 fall in VL among episodes still >= 1,000."""
    still = df["still_unsuppressed"].fillna(False).astype(bool)
    idx = pd.to_numeric(_col(df, "idx_vl"), errors="coerce")
    fu = pd.to_numeric(_col(df, "fu_vl"), errors="coerce")
    ok = still & idx.notna() & fu.notna() & (idx > 0) & (fu > 0)
    if not ok.any():
        return {"ok": False, "n": 0}

    d = np.log10(idx[ok]) - np.log10(fu[ok])
    done = df["eac_completed"].fillna(False).astype(bool)[ok]

    bands = []
    for lo, hi, label, meaning in _LOG_BANDS:
        m = (d >= lo) & (d < hi)
        bands.append({"band": label, "meaning": meaning, "n": int(m.sum()),
                      "pct": round(m.sum() / len(d) * 100, 1),
                      # completed a full cycle AND barely moved: the clearest
                      # switch argument the data can make
                      "completed_eac": int((m & done).sum())})

    # <0.5 log or rising, after a completed cycle. Adherence has been addressed
    # and the virus did not respond.
    flat = d < 0.5
    return {
        "ok": True,
        "n": int(len(d)),
        "still": int(still.sum()),
        "median": round(float(d.median()), 2),
        "bands": bands,
        "no_response": int(flat.sum()),
        "no_response_completed_eac": int((flat & done).sum()),
    }


# ── §7.1 predictive model: probability of re-suppression ──────────────
FEATURES: list[tuple[str, str]] = [
    ("paed", "Age under 20"),
    ("male", "Male"),
    ("log_vl", "Index VL (log10)"),
    ("no_eac", "No EAC session"),
    ("eac3", "Completed 3 sessions"),
    ("late_eac", "EAC started >30d after VL"),
    ("years_art", "Years on ART"),
    ("second_line", "Already 2nd line"),
    ("repeat_ep", "Repeat failure episode"),
]


def _design(df: pd.DataFrame) -> pd.DataFrame:
    rep = df["sn"].duplicated(keep=False) if "sn" in df else pd.Series(False, index=df.index)
    return pd.DataFrame({
        "paed": df.get("paed", False).fillna(False).astype(float),
        "male": (_col(df, "sex") == "Male").astype(float),
        "log_vl": np.log10(pd.to_numeric(df["idx_vl"], errors="coerce").clip(lower=1)).fillna(3),
        "no_eac": (~df["eac1"].fillna(False).astype(bool)).astype(float),
        "eac3": df["eac3"].fillna(False).astype(float),
        "late_eac": (pd.to_numeric(_col(df, "time_to_eac"), errors="coerce") > 30).fillna(False).astype(float),
        "years_art": (pd.to_numeric(_col(df, "days_on_art"), errors="coerce") / 365).fillna(0).clip(0, 40),
        "second_line": df.get("regimen_line", pd.Series("", index=df.index))
                         .astype(str).str.contains("2nd", case=False, na=False).astype(float),
        "repeat_ep": rep.astype(float),
    })


def resuppression_model(df: pd.DataFrame) -> dict:
    """
    Logistic regression, target = re-suppressed (post-EAC VL < 1,000).

    Fitted only on episodes that HAVE a post-EAC result. That is a selected
    subset - only about a third of episodes ever get a repeat VL - so the model
    is conditioned on having been tested. Said plainly on the dashboard rather
    than buried, because a clinician acting on the risk list needs to know it.
    """
    train = df[df["post_result"].fillna(False).astype(bool)]
    if len(train) < 100:
        return {"ok": False, "reason": f"Only {len(train)} episodes have a post-EAC result; "
                                       f"at least 100 are needed to fit a model."}

    X = _design(train).to_numpy(float)
    y = train["resuppressed"].fillna(False).astype(int).to_numpy()
    if y.sum() in (0, len(y)):
        return {"ok": False, "reason": "No outcome variation in this selection."}

    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1
    Z = (X - mu) / sd
    Z1 = np.column_stack([np.ones(len(Z)), Z])

    w = np.zeros(Z1.shape[1])
    for _ in range(400):                      # gradient descent + small L2
        p = 1 / (1 + np.exp(-Z1 @ w))
        g = Z1.T @ (p - y) / len(y)
        g[1:] += 0.01 * w[1:]
        w -= 0.5 * g

    odds = np.exp(w[1:] / sd)                 # back to natural units
    p_tr = 1 / (1 + np.exp(-Z1 @ w))

    # AUC (rank-based, ties averaged)
    order = np.argsort(p_tr)
    ranks = np.empty(len(p_tr), float)
    ranks[order] = np.arange(1, len(p_tr) + 1)
    pos, neg = y.sum(), len(y) - y.sum()
    auc = float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))

    # calibration by decile
    cal = []
    idx = np.argsort(p_tr)
    for chunk in np.array_split(idx, 10):
        if len(chunk):
            cal.append({"predicted": round(float(p_tr[chunk].mean() * 100), 1),
                        "observed": round(float(y[chunk].mean() * 100), 1),
                        "n": int(len(chunk))})

    # score every episode still awaiting a result
    pend = df[~df["post_result"].fillna(False).astype(bool)]
    scored = []
    if len(pend):
        Zp = (_design(pend).to_numpy(float) - mu) / sd
        pp = 1 / (1 + np.exp(-np.column_stack([np.ones(len(Zp)), Zp]) @ w))
        pend = pend.assign(p_resupp=pp).sort_values("p_resupp")
        for r in pend.head(200).itertuples():
            scored.append({
                "sn": r.sn, "facility": r.facility, "state": r.state,
                "age": None if pd.isna(r.age) else float(r.age),
                "idx_vl": None if pd.isna(r.idx_vl) else float(r.idx_vl),
                "sessions": 0 if pd.isna(r.sessions) else int(r.sessions),
                "plan": r.treatment_plan,
                "p_resupp": round(float(r.p_resupp) * 100, 1),
            })

    return {
        "ok": True,
        "n_train": int(len(train)),
        "n_scored": int(len(pend)),
        "baseline": round(float(y.mean() * 100), 1),
        "auc": round(auc, 3),
        "odds_ratios": sorted(
            [{"feature": lab, "or": round(float(o), 3)}
             for (_, lab), o in zip(FEATURES, odds)],
            key=lambda d: -d["or"]),
        "calibration": cal,
        "lowest_chance": scored,     # least likely to re-suppress = act first
    }


def mortality(df: pd.DataFrame) -> dict:
    """§7.2 — crude mortality among the unsuppressed cohort."""
    st = _col(df, "art_status")
    if st is None:
        return {"ok": False}
    dead = st.astype(str).str.strip().str.lower().isin(["dead", "death"])
    by = []
    for lab, mask in (("Completed EAC", df["eac_completed"].fillna(False).astype(bool)),
                      ("Did not complete", ~df["eac_completed"].fillna(False).astype(bool))):
        g = df[mask]
        if len(g):
            d = st[mask].astype(str).str.strip().str.lower().isin(["dead", "death"]).sum()
            by.append({"group": lab, "n": int(len(g)), "deaths": int(d),
                       "pct": round(float(d) / len(g) * 100, 2)})
    return {"ok": True, "n": int(len(df)), "deaths": int(dead.sum()),
            "crude_pct": round(float(dead.sum()) / len(df) * 100, 2) if len(df) else 0,
            "by_eac": by}


# ── VL trajectory ─────────────────────────────────────────────────────
# The dated viral loads a client may have, oldest first. Not every client has
# all four: first_vl and first_high arrive from the EAC export and are absent
# from snapshots uploaded before that ingest change, so the trajectory is built
# from whatever exists rather than assuming a fixed shape.
# Each entry gives the value column, the date columns to try in order, and the
# label. More than one date column because they are not reliably populated:
# fu_date comes from the EAC sheet's Followup_VL_Result_Date and is empty for
# every one of the 671 still-unsuppressed episodes in the current snapshot,
# while fu_samp - the sample collection date, which the post-EAC clock already
# runs on - is present for all of them. Taking the first that exists is the
# difference between a two-point trajectory and no trajectory at all.
_VL_POINTS = (
    ("first_vl", ("first_vl_date",), "First ever VL"),
    ("first_high_vl", ("first_high_date",), "First high VL"),
    ("idx_vl", ("idx_date", "idx_samp", "recv_date"), "Index VL"),
    ("fu_vl", ("fu_date", "fu_samp"), "Follow-up VL"),
)

# Above this a result is almost certainly a data-entry artefact rather than a
# viral load: the highest plausible figures in the literature are a few million.
# The point is kept - a clinical result is not ours to rewrite - but it is
# flagged so a chart can cap its axis and a reviewer knows not to trust it.
VL_IMPLAUSIBLE = 10_000_000


def _vl_pattern(points: list[dict]) -> str:
    """
    Describe the shape of a client's viral load history in the terms a DTC
    uses. Order matters: a rebound and a sharp rise can both be true, and the
    rebound is the more useful thing to say, because it means the client has
    demonstrably suppressed before and something changed.
    """
    vals = [p["value"] for p in points]
    if len(vals) < 2:
        return "Single result"
    high = [v >= VL_FAIL for v in vals]
    # Suppressed at some point, unsuppressed after it.
    if any(not high[i] and any(high[i + 1:]) for i in range(len(high) - 1)):
        return "Rebound after suppression"
    # An order of magnitude up on the previous result.
    if vals[-2] > 0 and vals[-1] >= vals[-2] * 10:
        return "Sharp rise"
    if len(vals) >= 3:
        rises = any(vals[i + 1] > vals[i] for i in range(len(vals) - 1))
        falls = any(vals[i + 1] < vals[i] for i in range(len(vals) - 1))
        if rises and falls:
            return "Erratic"
    if all(high):
        return "Persistently high"
    return "Mixed"


def vl_trajectory(df: pd.DataFrame, limit: int = 500) -> dict:
    """
    Per-client viral load trajectories for the clients who need a decision.

    The population is every episode whose FOLLOW-UP viral load is still at or
    above 1,000 - whether or not EAC was completed. Someone who never finished
    counselling and remains unsuppressed needs review at least as urgently as
    someone who did; on this snapshot their median follow-up VL is in fact
    higher (34,000 with no EAC on record against 17,362 having completed it).
    """
    if df.empty or "still_unsuppressed" not in df.columns:
        return {"ok": False, "rows": [], "n": 0}

    d = df[df["still_unsuppressed"].fillna(False).astype(bool)].copy()
    if d.empty:
        return {"ok": False, "rows": [], "n": 0}

    rows: list[dict] = []
    for _, r in d.iterrows():
        pts: list[dict] = []
        for vcol, dcols, label in _VL_POINTS:
            v = pd.to_numeric(r.get(vcol), errors="coerce")
            t = pd.NaT
            for dc in dcols:
                t = pd.to_datetime(r.get(dc), errors="coerce")
                if pd.notna(t):
                    break
            if pd.isna(v) or pd.isna(t):
                continue
            pts.append({"label": label, "date": t.strftime("%Y-%m-%d"),
                        "value": float(v),
                        "suppressed": bool(float(v) < VL_FAIL),
                        "implausible": bool(float(v) > VL_IMPLAUSIBLE)})
        # Chronological, then collapse ADJACENT repeats of the same value.
        #
        # This matters more than it sounds. The index VL comes from the
        # unsuppressed register and the follow-up from the clinical line list,
        # and where a client has had no new test since, both are the SAME
        # result - carrying different dates because the two sources date
        # results differently. 280 of the 671 still-unsuppressed episodes are
        # in that position. Drawn as two points they read as "stable at 20.8
        # million for three months", which is a test that never happened.
        #
        # Only adjacent repeats collapse. A genuine 500 -> 20,000 -> 500 keeps
        # all three points; de-duplicating on value alone would flatten the
        # fall and change what the trajectory says.
        pts.sort(key=lambda p: p["date"])
        uniq: list[dict] = []
        for p in pts:
            if uniq and uniq[-1]["value"] == p["value"]:
                uniq[-1]["repeated_on"] = p["date"]
                continue
            uniq.append(p)

        latest = uniq[-1] if uniq else None
        rows.append({
            "sn": r.get("sn"), "state": r.get("state"), "lga": r.get("lga"),
            "facility": r.get("facility"), "sex": r.get("sex"),
            "age": None if pd.isna(r.get("age")) else int(r.get("age")),
            "regimen_line": r.get("regimen_line"),
            "eac_stage": ("Completed EAC" if r.get("eac_completed")
                          else "Commenced, not completed" if r.get("eac1")
                          else "No EAC on record"),
            "switched": bool(r.get("switched")),
            "months_unsuppressed": (None if pd.isna(r.get("months_unsuppressed"))
                                    else float(r.get("months_unsuppressed"))),
            "points": uniq,
            "n_results": len(uniq),
            "latest_vl": latest["value"] if latest else None,
            "latest_date": latest["date"] if latest else None,
            "pattern": _vl_pattern(uniq),
        })

    # Highest current viral load first: that is the order a review works down.
    rows.sort(key=lambda x: (x["latest_vl"] is None, -(x["latest_vl"] or 0)))
    return {"ok": True, "n": len(rows), "shown": min(limit, len(rows)),
            "rows": rows[:limit]}


def awaiting_results(df: pd.DataFrame, as_of, limit: int = 300) -> dict:
    """
    Post-EAC samples collected but not yet reported by the laboratory.

    A queue, not a failure. These clients have been bled; nothing more is asked
    of them or of the counselling team until the result lands. The action is
    with the laboratory, which is why this is separated from every other state
    on the DTC page - chasing the client would be the wrong response.

    Waiting time runs from the sample collection date to the snapshot's as-of
    date, never to today: an as-of anchored to the clock makes the same file
    report a longer wait every day it is left open.
    """
    if df.empty or "awaiting_result" not in df.columns:
        return {"ok": False, "n": 0, "rows": [], "by_facility": []}

    d = df[df["awaiting_result"].fillna(False).astype(bool)].copy()
    if d.empty:
        return {"ok": True, "n": 0, "rows": [], "by_facility": []}

    asof = pd.Timestamp(as_of)
    samp = pd.to_datetime(_col(d, "fu_samp"), errors="coerce")
    d["days"] = (asof - samp).dt.days
    d["samp"] = samp

    # A negative wait means the sample is dated after the snapshot - a data
    # entry error rather than a laboratory delay. Counted separately so the
    # median is not dragged by it.
    future = int((d["days"] < 0).sum())
    ok = d[d["days"] >= 0]
    days = ok["days"].dropna()

    by_fac = (ok.groupby("facility")
              .agg(n=("days", "size"), median_days=("days", "median"),
                   longest=("days", "max"))
              .sort_values("n", ascending=False).head(15).reset_index())

    rows = (ok.sort_values("days", ascending=False).head(limit))
    out_rows = [{
        "sn": r.get("sn"), "state": r.get("state"), "facility": r.get("facility"),
        "sex": r.get("sex"),
        "age": None if pd.isna(r.get("age")) else int(r.get("age")),
        "idx_vl": None if pd.isna(r.get("idx_vl")) else float(r.get("idx_vl")),
        "sample_date": r["samp"].strftime("%Y-%m-%d") if pd.notna(r["samp"]) else None,
        "days": int(r["days"]),
        "eac_stage": ("Completed EAC" if r.get("eac_completed")
                      else "Commenced, not completed" if r.get("eac1")
                      else "No EAC on record"),
    } for _, r in rows.iterrows()]

    return {
        "ok": True,
        "n": int(len(d)),
        "as_of": asof.strftime("%Y-%m-%d"),
        "median_days": None if days.empty else int(days.median()),
        "p90_days": None if days.empty else int(days.quantile(0.9)),
        "over_30": int((days >= 30).sum()),
        "over_60": int((days >= 60).sum()),
        "future_dated": future,
        "by_facility": [{"facility": r["facility"], "n": int(r["n"]),
                         "median_days": int(r["median_days"]),
                         "longest": int(r["longest"])}
                        for _, r in by_fac.iterrows()],
        "shown": len(out_rows),
        "rows": out_rows,
    }
