"""
Spec §9 requires unit tests for the decision tree, the temporal matching logic
and the negative-value exclusion. Plus the guard that matters most in practice:
detecting a success-censored EAC export.
"""
import pandas as pd
import pytest

from app.indicators import (build_cohort, cascade, dtc_review, fiscal_quarter,
                            fiscal_year, norm_state, vl_category)
from app.ingest import audit_censoring

AS_OF = pd.Timestamp("2026-07-11")


def mk(**kw):
    """One EAC row with sane defaults; override what the test cares about."""
    base = {
        "S/N": "0.123456789012345",
        "EAC_Triggering_High_VL_Value": 5000,
        "EAC_Triggering_High_VL_Date": "2026-03-01",
        "Session_1_Date": None, "Session_2_Date": None, "Session_3_Date": None,
        "Followup_VL_Value": None, "Followup_VL_Result_Date": None,
        "Followup_VL_Sample_Collection_Date": None,
        "Total_EAC_Sessions_All_Cycles": 0, "EAC_Cycle_Number": 1,
        "Switched_To_Second_Line": "No",
    }
    base.update(kw)
    return base


def treat(sn="0.123456789012345", status="Active", fu_vl=None, fu_samp=None,
          line="Adult 1st line ARV regimen"):
    """
    The treatment line list is now the SOURCE OF FOLLOW-UP VLs. `fu_vl`/`fu_samp`
    are the client's current VL, i.e. the post-EAC result for the episode.
    """
    return pd.DataFrame([{
        "S/N": sn, "state": "DELTA", "lga": "Oshimili", "facilityName": "X",
        "sex": "F", "currentAge": 34, "currentArtStatus": status,
        "currentRegimenLine": line,
        "currentViralLoad": 5000 if fu_vl is None else fu_vl,
        "dateofCurrentViralLoad": "2026-03-01" if fu_samp is None else fu_samp,
        "lastDateOfSampleCollection": fu_samp,
    }])


def _idx(sn="0.123456789012345", vl=5000, d="2026-03-01"):
    """The Total Unsuppressed row that the quarterly index list would contain."""
    return pd.DataFrame([{
        "S/N": sn, "currentViralLoad": vl, "dateofCurrentViralLoad": d,
        "lastDateOfSampleCollection": d, "dateResultReceivedFacility": d,
    }])


def cohort(eac_rows, status="Active", fu_vl=None, fu_samp=None,
           line="Adult 1st line ARV regimen"):
    """
    `event` mode is retired: the cohort now always comes from the quarterly
    Total Unsuppressed list. So synthesise the index row each EAC row implies,
    which is what the real quarterly index list contains.
    """
    e = pd.DataFrame(eac_rows)
    t = treat(status=status, fu_vl=fu_vl, fu_samp=fu_samp, line=line)
    tu = pd.DataFrame([{
        "S/N": r["S/N"],
        "currentViralLoad": r["EAC_Triggering_High_VL_Value"],
        "dateofCurrentViralLoad": r["EAC_Triggering_High_VL_Date"],
        "lastDateOfSampleCollection": r["EAC_Triggering_High_VL_Date"],
        "dateResultReceivedFacility": r["EAC_Triggering_High_VL_Date"],
    } for r in eac_rows])
    return build_cohort(tu, t, e, as_of=AS_OF, mode="snapshot")


# ── §2.3 rule 2: temporal validity ────────────────────────────────────
def test_eac_after_index_vl_is_valid():
    c = cohort([mk(Session_1_Date="2026-03-20")])
    assert bool(c.df.loc[0, "eac1"]) is True
    assert bool(c.df.loc[0, "eac_prior_cycle"]) is False


def test_eac_before_index_vl_is_a_prior_cycle_and_excluded():
    c = cohort([mk(Session_1_Date="2026-01-10")])   # before the 1 Mar index VL
    assert bool(c.df.loc[0, "eac1"]) is False
    assert bool(c.df.loc[0, "eac_prior_cycle"]) is True
    assert cascade(c.df)[1]["n"] == 0               # step 2 = EAC commenced


# ── §5: negative time-to-EAC is a data error, never a value ───────────
def test_negative_time_to_eac_is_excluded_not_negative():
    c = cohort([mk(Session_1_Date="2026-01-10")])
    assert pd.isna(c.df.loc[0, "time_to_eac"])
    assert any("negative time-to-EAC" in w for w in c.warnings)


def test_positive_time_to_eac_is_kept():
    c = cohort([mk(Session_1_Date="2026-03-21")])
    assert c.df.loc[0, "time_to_eac"] == 20


# ── §6: decision tree, priority-ordered, exactly one plan ─────────────
def test_plan_e_wins_for_inactive_clients_even_if_failing():
    c = cohort([mk(Session_1_Date="2026-03-05", Session_3_Date="2026-04-05",
                   Total_EAC_Sessions_All_Cycles=3,
                   Followup_VL_Value=8000, Followup_VL_Result_Date="2026-06-01")],
               status="LTFU")
    assert c.df.loc[0, "treatment_plan"].startswith("E.")


def test_plan_f_switch_committee_when_failed_after_completed_eac():
    # Session_2_Date is required: the team redefined "completed EAC" as sessions
    # 1 AND 2 AND 3 plus 30 days, so a session COUNT of 3 no longer implies it.
    # This test predated that change and was asserting the old definition.
    c = cohort([mk(Session_1_Date="2026-03-05", Session_2_Date="2026-03-20",
                   Session_3_Date="2026-04-05",
                   Total_EAC_Sessions_All_Cycles=3)],
               fu_vl=8000, fu_samp="2026-06-01")
    assert bool(c.df.loc[0, "still_unsuppressed"]) is True
    assert bool(c.df.loc[0, "switch_eligible"]) is True
    assert bool(c.df.loc[0, "awaiting_switch"]) is True   # still on 1st line
    assert c.df.loc[0, "treatment_plan"].startswith("F.")


def test_plan_d_when_resuppressed():
    c = cohort([mk(Session_1_Date="2026-03-05", Session_3_Date="2026-04-05",
                   Total_EAC_Sessions_All_Cycles=3)],
               fu_vl=40, fu_samp="2026-06-01")
    assert bool(c.df.loc[0, "resuppressed"]) is True
    assert c.df.loc[0, "treatment_plan"].startswith("D.")


def test_plan_a_when_no_eac_and_recent_index():
    c = cohort([mk()])
    assert c.df.loc[0, "treatment_plan"].startswith("A.")


def test_plan_b_when_eac_started_but_incomplete():
    c = cohort([mk(Session_1_Date="2026-06-20", Total_EAC_Sessions_All_Cycles=1)])
    assert c.df.loc[0, "treatment_plan"].startswith("B.")


def test_plan_c_when_index_vl_is_stale():
    # >6 months old (so not "recent") but still inside the 12-month window.
    c = cohort([mk(EAC_Triggering_High_VL_Date="2025-11-01",
                   Session_1_Date="2025-11-10", Total_EAC_Sessions_All_Cycles=1)])
    assert c.df.loc[0, "treatment_plan"].startswith("C.")



def test_every_client_gets_exactly_one_plan():
    c = cohort([mk(**{"S/N": f"0.{i}23456789012345"}) for i in range(1, 6)])
    assert c.df["treatment_plan"].notna().all()


# ── the censoring guard ───────────────────────────────────────────────
def test_success_censored_sheet_is_detected():
    df = pd.DataFrame({"Followup_VL_Value": [10, 20, 49.9] * 100})
    censored, mx = audit_censoring(df)
    assert censored is True and mx == 49.9


def test_complete_sheet_is_not_flagged():
    df = pd.DataFrame({"Followup_VL_Value": [10, 20, 5000] * 100})
    censored, _ = audit_censoring(df)
    assert censored is False


def test_small_sheet_is_not_flagged_on_thin_evidence():
    df = pd.DataFrame({"Followup_VL_Value": [10, 20, 30]})
    assert audit_censoring(df)[0] is False


# ── the join key must survive as text ─────────────────────────────────
def test_sn_precision_is_preserved():
    sn = "0.7203225946247102"
    c = cohort([mk(**{"S/N": sn})])
    assert c.df.loc[0, "sn"] == sn          # not 0.72032259 or 0.720323


def test_blank_sn_rows_are_dropped_and_reported():
    c = cohort([mk(), mk(**{"S/N": None})])
    assert len(c.df) == 1
    assert any("blank S/N" in w for w in c.warnings)


# ── geography falls back to the register when the export drops it ─────
def _cohort_geo(treatment_has_lga: bool):
    """Build a one-episode cohort where Total Unsuppressed carries geography
    and the treatment list may or may not."""
    e = pd.DataFrame([mk(Session_1_Date="2026-03-20")])
    t = treat()
    if not treatment_has_lga:
        t = t.drop(columns=["lga"])          # the 24-July export dropped it
    tu = pd.DataFrame([{
        "S/N": "0.123456789012345", "currentViralLoad": 5000,
        "dateofCurrentViralLoad": "2026-03-01",
        "lastDateOfSampleCollection": "2026-03-01",
        "dateResultReceivedFacility": "2026-03-01",
        # the register capitalises its headers
        "State": "DELTA", "LGA": "Ughelli North", "FacilityName": "Register Clinic",
    }])
    return build_cohort(tu, t, e, as_of=AS_OF, mode="snapshot")


def test_lga_falls_back_to_the_register_when_the_export_drops_it():
    c = _cohort_geo(treatment_has_lga=False)
    assert c.df.loc[0, "lga"] == "Ughelli North"


def test_treatment_list_lga_wins_when_present():
    """Older exports still carry `lga`; the fallback must not override them."""
    c = _cohort_geo(treatment_has_lga=True)
    assert c.df.loc[0, "lga"] == "Oshimili"      # the treatment list's value


# ── §6: terminal vs non-terminal negative outcomes ────────────────────
@pytest.mark.parametrize("status", ["Death", "Transferred out", "Deceased"])
def test_terminal_outcomes_get_no_action_plan(status):
    """
    A client who has died or left the facility cannot be tracked and cannot be
    given a viral-load action. Death previously fell into "E. Track client" and
    "Transferred out" was missing from the inactive set entirely, so those
    episodes were issued EAC and sampling instructions.
    """
    c = cohort([mk(Session_1_Date="2026-03-20")], status=status)
    assert c.df.loc[0, "treatment_plan"].startswith("H.")


@pytest.mark.parametrize("status", ["LTFU", "Lost to followup",
                                    "Lost to follow-up", "Discontinued Care"])
def test_non_terminal_outcomes_are_tracked(status):
    """
    'Lost to followup' is the spelling the export actually uses. The set only
    listed the hyphenated form, so those episodes missed plan E and were sent
    to a viral-load plan instead.
    """
    c = cohort([mk(Session_1_Date="2026-03-20")], status=status)
    assert c.df.loc[0, "treatment_plan"].startswith("E.")


# ── DTC review: the repeat-unsuppression subset must nest in "still" ──
def test_dtc_repeat_subset_nests_in_still():
    """
    The headline repeat-unsuppression figure on the DTC page is the switch-
    relevant subset: repeat episodes that are STILL >= 1,000 after follow-up.
    It must never exceed either its parent set (still) or the full repeat count,
    and the three-way switch split must still sum to `still`.
    """
    # Two failure episodes for one client (a repeat), one for another; the
    # repeat client stays >= 1,000 on follow-up (a switch candidate).
    rows = [
        mk(**{"S/N": "0.111111111111",
              "EAC_Triggering_High_VL_Date": "2026-01-05"}),
        mk(**{"S/N": "0.111111111111",
              "EAC_Triggering_High_VL_Date": "2026-04-05"}),
        mk(**{"S/N": "0.222222222222"}),
    ]
    c = cohort(rows, fu_vl=8000, fu_samp="2026-06-01")   # follow-up still high
    s = dtc_review(c.df)["summary"]

    assert s["repeat_still_episodes"] <= s["still"]
    assert s["repeat_still_episodes"] <= s["repeat_episodes"]
    assert s["repeat_still_clients"] <= s["repeat_clients"]
    assert s["awaiting"] + s["prior"] + s["switched"] == s["still"]


# ── small helpers ─────────────────────────────────────────────────────
@pytest.mark.parametrize("vl,expected", [
    (0, "Undetectable"), (49, "Undetectable"), (50, "LLV"), (999, "LLV"),
    (1000, "Unsuppressed"), (10_000_000, "Unsuppressed"), (None, None),
])
def test_vl_category(vl, expected):
    assert vl_category(vl) == expected


@pytest.mark.parametrize("raw", ["Delta", "DELTA", "delta"])
def test_state_casing_normalised(raw):
    assert norm_state(raw) == "Delta"


@pytest.mark.parametrize("d,q", [
    ("2025-10-01", "FY26Q1"), ("2026-01-15", "FY26Q2"),
    ("2026-06-30", "FY26Q3"), ("2026-09-30", "FY26Q4"),
])
def test_fiscal_quarter(d, q):
    assert fiscal_quarter(pd.Timestamp(d)) == q


# ── schema drift: exports rename and drop columns between cycles ──────
def test_july_schema_without_legacy_columns_does_not_crash():
    """
    Reproduces the production failure: the July EAC sheet has
    First_High_VL_* / EAC_Triggering_High_VL_* but NOT Current_High_VL_*.
    The old fillna() chain raised "Must specify a fill 'value' or 'method'"
    because to_datetime(None) is a bare NaT scalar.
    """
    row = mk(Session_1_Date="2026-03-20")
    assert "Current_High_VL_Value" not in row
    c = cohort([row])
    assert len(c.df) == 1
    assert bool(c.df.loc[0, "eac1"]) is True


def test_legacy_may_schema_still_works():
    """May/June sheets use Current_High_VL_* and have no Triggering columns."""
    e = pd.DataFrame([{
        "S/N": "0.123456789012345",
        "Current_High_VL_Value": 5000,
        "Current_High_VL_Result_Date": "2026-03-01",
        "Session_1_Date": "2026-03-20", "Session_2_Date": None, "Session_3_Date": None,
        "Followup_VL_Value": 30, "Followup_VL_Result_Date": "2026-06-01",
        "Total_EAC_Sessions_All_Cycles": 1, "EAC_Cycle_Number": 1,
        "Switched_To_Second_Line": "No",
    }])
    t = treat()
    c = build_cohort(_idx(), t, e, as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 1
    assert c.df.loc[0, "idx_vl"] == 5000
    assert bool(c.df.loc[0, "eac1"]) is True


def test_missing_optional_columns_entirely():
    """A minimal export with no session-4/5/6 or sample-date columns at all."""
    e = pd.DataFrame([{
        "S/N": "0.123456789012345",
        "EAC_Triggering_High_VL_Value": 5000,
        "EAC_Triggering_High_VL_Date": "2026-03-01",
        "Session_1_Date": "2026-03-20",
    }])
    t = treat()
    c = build_cohort(_idx(), t, e, as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 1
    assert bool(c.df.loc[0, "switched"]) is False


# ── repeat failure episodes must survive ingestion ───────────────────
def _tu(rows):
    return pd.DataFrame(rows)




def test_repeat_failure_is_two_episodes_not_one_client():
    """
    The whole point of the quarterly open cohort: a client can fail, complete
    EAC, re-suppress, then fail again. That second failure is the most important
    row in the dataset - it is a switch candidate. De-duplicating on S/N would
    delete it. Keyed on the VL result, both episodes survive.
    """
    sn = "0.7203225946247102"
    tu = _tu([
        {"S/N": sn, "currentViralLoad": 2274, "dateofCurrentViralLoad": "2025-08-20"},
        {"S/N": sn, "currentViralLoad": 6423, "dateofCurrentViralLoad": "2026-01-23"},
    ])
    t = treat(sn=sn)
    c = build_cohort(tu, t, pd.DataFrame([mk(**{"S/N": sn})]),
                     as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 2, "second failure episode was dropped"
    assert c.df["sn"].nunique() == 1
    assert set(c.df["idx_vl"]) == {2274, 6423}
    assert c.df["episode"].nunique() == 2


def test_same_vl_result_written_twice_collapses():
    """Identical result date AND value = the same lab result, exported twice."""
    sn = "0.7203225946247102"
    tu = _tu([
        {"S/N": sn, "currentViralLoad": 4890, "dateofCurrentViralLoad": "2025-12-04"},
        {"S/N": sn, "currentViralLoad": 4890, "dateofCurrentViralLoad": "2025-12-04"},
    ])
    t = treat(sn=sn)
    c = build_cohort(tu, t, pd.DataFrame([mk(**{"S/N": sn})]),
                     as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 1
    assert any("duplicate" in w for w in c.warnings)


def test_column_casing_is_ignored():
    """Quarterly sheet ships CurrentViralLoad; line list ships currentViralLoad."""
    sn = "0.7203225946247102"
    tu = _tu([{"S/N": sn, "CurrentViralLoad": 5000,
               "DateofCurrentViralLoad": "2026-03-01"}])
    t = treat(sn=sn)
    c = build_cohort(tu, t, pd.DataFrame([mk(**{"S/N": sn})]),
                     as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 1
    assert c.df.loc[0, "idx_vl"] == 5000     # not NaN


# ── VL validity + FY bucketing (added after the July review) ──────────

def test_fy25_floor_collapses_old_quarters():
    """
    Everything received on or before 2025-09-30 belongs in FY25Q4. Without the
    floor, a 2021 result produced an 'FY22Q1' bucket holding a single episode.
    """
    assert fiscal_quarter(pd.Timestamp("2021-12-02")) == "FY25Q4"
    assert fiscal_quarter(pd.Timestamp("2025-08-14")) == "FY25Q4"
    assert fiscal_quarter(pd.Timestamp("2025-09-30")) == "FY25Q4"
    assert fiscal_quarter(pd.Timestamp("2025-10-01")) == "FY26Q1"
    assert fiscal_quarter(pd.Timestamp("2026-05-02")) == "FY26Q3"
    assert fiscal_year("FY26Q3") == "FY26"
    assert fiscal_year(None) is None


def test_quarter_uses_date_received_not_result_date():
    """Bucket by when the facility could act on the result."""
    tu = _tu([{"S/N": "0.1", "currentViralLoad": 5000,
               "dateofCurrentViralLoad": "2025-09-28",     # FY25Q4
               "lastDateOfSampleCollection": "2025-09-20",
               "dateResultReceivedFacility": "2025-10-06"}])  # -> FY26Q1
    c = build_cohort(tu, treat(sn="0.1"), pd.DataFrame([mk(**{"S/N": "0.1"})]),
                     as_of=AS_OF, mode="snapshot")
    assert c.df.loc[0, "enrol_quarter"] == "FY26Q1"
    assert c.df.loc[0, "fy"] == "FY26"




# ── the July review: rules agreed with the programme lead ─────────────
def test_old_vl_is_kept_not_dropped():
    """
    The 12-month VL-validity window is EXPUNGED. Total Unsuppressed is a
    cumulative register: an old unsuppressed result is a real failure episode
    that belongs in FY25Q4, not a stale row to discard.
    """
    tu = _tu([{"S/N": "0.1", "currentViralLoad": 5000,
               "dateofCurrentViralLoad": "2024-02-01",
               "lastDateOfSampleCollection": "2024-01-15",   # >2 years old
               "dateResultReceivedFacility": "2024-02-05"}])
    c = build_cohort(tu, treat(sn="0.1"), pd.DataFrame([mk(**{"S/N": "0.1"})]),
                     as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 1, "an old episode was dropped"
    assert c.df.loc[0, "enrol_quarter"] == "FY25Q4"
    assert not any("no longer valid" in w for w in c.warnings)


def test_followup_vl_comes_from_treatment_list_not_eac_sheet():
    """Outcomes are read from the clinical line lists, never the EAC sheet."""
    e = pd.DataFrame([mk(**{"S/N": "0.1", "Session_1_Date": "2026-03-20",
                            "Followup_VL_Value": 999999})])   # must be ignored
    tu = _tu([{"S/N": "0.1", "currentViralLoad": 5000,
               "dateofCurrentViralLoad": "2026-03-01",
               "lastDateOfSampleCollection": "2026-02-25",
               "dateResultReceivedFacility": "2026-03-05"}])
    t = treat(sn="0.1", fu_vl=45, fu_samp="2026-06-01")
    c = build_cohort(tu, t, e, as_of=AS_OF, mode="snapshot")
    assert c.df.loc[0, "fu_vl"] == 45, "EAC-sheet follow-up VL leaked in"
    assert bool(c.df.loc[0, "resuppressed"]) is True


def test_repeat_failure_resolves_as_failed_switch_on_the_earlier_episode():
    """
    A client who fails again: the second episode's index VL IS the first
    episode's post-EAC result. So episode 1 reads as still-unsuppressed and
    therefore switch-eligible - a switch that should have happened and did not.
    """
    sn = "0.7203225946247102"
    tu = _tu([
        {"S/N": sn, "currentViralLoad": 2274, "dateofCurrentViralLoad": "2025-11-20",
         "lastDateOfSampleCollection": "2025-11-10",
         "dateResultReceivedFacility": "2025-11-25"},
        {"S/N": sn, "currentViralLoad": 6423, "dateofCurrentViralLoad": "2026-04-23",
         "lastDateOfSampleCollection": "2026-04-10",
         "dateResultReceivedFacility": "2026-04-28"},
    ])
    c = build_cohort(tu, treat(sn=sn), pd.DataFrame([mk(**{"S/N": sn})]),
                     as_of=AS_OF, mode="snapshot")
    assert len(c.df) == 2, "second failure episode was dropped"
    first = c.df.sort_values("idx_samp").iloc[0]
    assert first["fu_vl"] == 6423, "next episode's VL is not the follow-up"
    assert bool(first["still_unsuppressed"]) is True
    assert bool(first["repeat_failure"]) is True
    assert bool(first["switch_eligible"]) is True
    assert bool(first["awaiting_switch"]) is True


def test_switch_is_read_from_regimen_line():
    """Switched = on 2nd or 3rd line in the treatment list."""
    e = pd.DataFrame([mk(**{"S/N": "0.1", "Session_1_Date": "2026-03-20"})])
    tu = _tu([{"S/N": "0.1", "currentViralLoad": 5000,
               "dateofCurrentViralLoad": "2026-03-01",
               "lastDateOfSampleCollection": "2026-02-25",
               "dateResultReceivedFacility": "2026-03-05"}])
    for line, expect in [("Adult 1st line ARV regimen", False),
                         ("Adult 2nd line ARV regimen", True),
                         ("Adult 3rd Line ARV Regimens", True)]:
        t = treat(sn="0.1", fu_vl=8000, fu_samp="2026-06-01", line=line)
        c = build_cohort(tu, t, e, as_of=AS_OF, mode="snapshot")
        r = c.df.iloc[0]
        assert bool(r["switch_eligible"]) is True
        assert bool(r["switched"]) is expect, f"{line} misread"
        assert bool(r["awaiting_switch"]) is (not expect)


def test_eac_before_index_counts_as_not_yet_commenced():
    """The 175 'prior cycle' episodes stay in the cohort as NOT commenced."""
    c = cohort([mk(Session_1_Date="2026-01-10")])   # before index 2026-03-01
    assert len(c.df) == 1, "prior-cycle episode was dropped from the cohort"
    assert bool(c.df.loc[0, "eac1"]) is False
    assert bool(c.df.loc[0, "eac_prior_cycle"]) is True
