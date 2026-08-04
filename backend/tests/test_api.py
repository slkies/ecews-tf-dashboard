"""
API-level integration tests.

Scope is deliberate: these cover the security controls the technical dossier
makes claims about, because those are what an external reviewer is being asked
to trust and what would otherwise break silently. Indicator maths is covered by
test_indicators.py and is not repeated here.
"""
from __future__ import annotations

import io
import zipfile

import pandas as pd
import pytest

from conftest import ADMIN, hdr   # tests/ is not a package; pytest adds it to sys.path

PROTECTED = ["/api/summary", "/api/overview", "/api/clients", "/api/export",
             "/api/filters", "/api/dq", "/api/uploads", "/api/users",
             "/api/audit", "/api/cascade", "/api/plans"]

ADMIN_ONLY = ["/api/users", "/api/audit", "/api/feedback"]


# ── authentication ────────────────────────────────────────────────────
def test_health_needs_no_auth_and_leaks_nothing(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


@pytest.mark.parametrize("path", PROTECTED)
def test_protected_endpoints_reject_anonymous(client, path):
    assert client.get(path).status_code == 401


def test_login_returns_token_and_profile(client):
    r = client.post("/api/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    assert r.status_code == 200
    body = r.json()
    assert body["token"]
    assert body["user"]["role"] == "admin"
    # The hash must never travel to the client.
    assert "password_hash" not in body["user"]


def test_me_reflects_the_token(client, viewer_h):
    r = client.get("/api/me", headers=viewer_h)
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


def test_garbage_token_is_rejected(client):
    r = client.get("/api/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


def test_login_does_not_reveal_whether_an_account_exists(client):
    unknown = client.post("/api/login",
                          json={"email": "nobody@ecews.org", "password": "x"})
    wrong = client.post("/api/login",
                        json={"email": ADMIN[0], "password": "wrong"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]


# ── brute-force lockout ───────────────────────────────────────────────
def _fail(client, email="target@ecews.org"):
    return client.post("/api/login", json={"email": email, "password": "wrong"})


def test_lockout_after_five_failures(client):
    for _ in range(5):
        assert _fail(client).status_code == 401
    assert _fail(client).status_code == 429


def test_lockout_blocks_even_the_correct_password(client):
    for _ in range(5):
        assert _fail(client, ADMIN[0]).status_code == 401
    r = client.post("/api/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    assert r.status_code == 429, "a locked account must not be openable"


def test_success_resets_the_failure_counter(client):
    for _ in range(4):
        _fail(client, ADMIN[0])
    assert client.post("/api/login",
                       json={"email": ADMIN[0], "password": ADMIN[1]}
                       ).status_code == 200
    # Four more must not trip the limit: the counter restarts at the success.
    for _ in range(4):
        assert _fail(client, ADMIN[0]).status_code == 401


def test_lockout_is_per_account(client):
    for _ in range(5):
        _fail(client, "someone@ecews.org")
    # A different address is unaffected.
    assert client.post("/api/login",
                       json={"email": ADMIN[0], "password": ADMIN[1]}
                       ).status_code == 200


# ── authorisation ─────────────────────────────────────────────────────
@pytest.mark.parametrize("path", ADMIN_ONLY)
def test_admin_only_endpoints_reject_a_viewer(client, viewer_h, path):
    assert client.get(path, headers=viewer_h).status_code == 403


@pytest.mark.parametrize("path", ADMIN_ONLY)
def test_admin_only_endpoints_allow_an_admin(client, admin_h, path):
    assert client.get(path, headers=admin_h).status_code == 200


def test_viewer_cannot_upload(client, viewer_h):
    r = client.post("/api/uploads", headers=viewer_h,
                    files={"file": ("x.xlsx", b"nonsense")})
    assert r.status_code == 403


def test_viewer_cannot_create_users(client, viewer_h):
    r = client.post("/api/users", headers=viewer_h,
                    json={"username": "x", "email": "x@ecews.org", "password": "secret123"})
    assert r.status_code == 403


# ── bulk export ───────────────────────────────────────────────────────
def test_viewer_cannot_export(client, viewer_h, cohort):
    assert client.get("/api/export", headers=viewer_h).status_code == 403


def test_admin_can_export(client, admin_h, cohort):
    r = client.get("/api/export", headers=admin_h)
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    assert len(r.text.strip().splitlines()) == 6      # header + 5 episodes


def test_analyst_can_export(client, admin_h, cohort):
    client.post("/api/users", headers=admin_h,
                json={"username": "analyst", "email": "analyst@ecews.org",
                      "password": "Analyst-Pass-1", "role": "analyst"})
    h = hdr(client, ("analyst", "Analyst-Pass-1"))
    assert client.get("/api/export", headers=h).status_code == 200


def test_denied_export_is_audited(client, admin_h, viewer_h, cohort):
    client.get("/api/export", headers=viewer_h)
    actions = {a["action"] for a in
               client.get("/api/audit", headers=admin_h).json()["actions"]}
    assert "export.denied" in actions


# ── row-level scope ───────────────────────────────────────────────────
def _scoped_viewer(client, admin_h, state):
    email = f"{state.lower()}@ecews.org"
    r = client.post("/api/users", headers=admin_h,
                    json={"username": state.lower(), "email": email,
                          "password": "Scoped-Pass-1",
                          "role": "viewer", "scope_state": state})
    assert r.status_code == 200, r.text
    return hdr(client, (state.lower(), "Scoped-Pass-1"))


def test_unscoped_admin_sees_every_state(client, admin_h, cohort):
    rows = client.get("/api/clients", headers=admin_h).json()
    assert len(rows) == 5


def test_scope_limits_rows_to_the_users_state(client, admin_h, cohort):
    h = _scoped_viewer(client, admin_h, "Delta")
    rows = client.get("/api/clients", headers=h).json()
    assert len(rows) == 3
    assert {r["state"] for r in rows} == {"Delta"}


def test_scope_overrides_a_requested_filter(client, admin_h, cohort):
    """The one that matters: a Delta user must not reach Osun by asking."""
    h = _scoped_viewer(client, admin_h, "Delta")
    rows = client.get("/api/clients?state=Osun", headers=h).json()
    assert {r["state"] for r in rows} == {"Delta"}, "scope must beat the filter"
    assert len(rows) == 3


def test_scope_applies_to_the_csv_export_too(client, admin_h, cohort):
    client.post("/api/users", headers=admin_h,
                json={"username": "d.analyst", "email": "d-analyst@ecews.org",
                      "password": "Scoped-Pass-1",
                      "role": "analyst", "scope_state": "Delta"})
    h = hdr(client, ("d.analyst", "Scoped-Pass-1"))
    csv = client.get("/api/export?state=Osun", headers=h).text
    assert "Osun" not in csv
    assert len(csv.strip().splitlines()) == 4          # header + 3 Delta rows


def test_scope_narrows_the_filter_lists(client, admin_h, cohort):
    h = _scoped_viewer(client, admin_h, "Delta")
    assert client.get("/api/filters", headers=h).json()["states"] == ["Delta"]


# ── audit trail ───────────────────────────────────────────────────────
def test_login_events_are_recorded(client, admin_h):
    _fail(client, "audited@ecews.org")
    counts = {a["action"]: a["n"] for a in
              client.get("/api/audit", headers=admin_h).json()["actions"]}
    assert counts.get("login.failure", 0) >= 1
    assert counts.get("login.success", 0) >= 1


def test_patient_data_access_is_recorded_with_the_row_count(
        client, admin_h, cohort):
    client.get("/api/clients", headers=admin_h)
    rows = client.get("/api/audit?action=clients.view", headers=admin_h
                      ).json()["rows"]
    assert rows and "5 client rows" in rows[0]["detail"]


def test_audit_trail_has_no_write_route(client, admin_h):
    """Append-only is a property of the API surface, not just of intent."""
    assert client.delete("/api/audit", headers=admin_h).status_code == 405
    assert client.post("/api/audit", headers=admin_h).status_code == 405


# ── passwords ─────────────────────────────────────────────────────────
def _make_user(client, admin_h, email="pwuser@ecews.org", pw="Correct-Horse-99"):
    r = client.post("/api/users", headers=admin_h,
                    json={"username": email.split("@")[0], "email": email,
                          "password": pw, "role": "viewer"})
    assert r.status_code == 200, r.text
    uid = next(u["id"] for u in client.get("/api/users", headers=admin_h).json()
               if u["email"] == email)
    return uid, email, pw


@pytest.mark.parametrize("pw", ["short", "changeme", "viewer1234", "blindalley"])
def test_weak_or_default_passwords_are_refused(client, admin_h, pw):
    r = client.post("/api/users", headers=admin_h,
                    json={"username": "weak", "email": "weak@ecews.org", "password": pw})
    assert r.status_code == 400


def test_admin_can_reset_another_users_password(client, admin_h):
    uid, email, old = _make_user(client, admin_h)
    assert client.post(f"/api/users/{uid}/password", headers=admin_h,
                       json={"password": "Brand-New-Pass-1"}).status_code == 200
    assert client.post("/api/login",
                       json={"email": email, "password": "Brand-New-Pass-1"}
                       ).status_code == 200
    assert client.post("/api/login", json={"email": email, "password": old}
                       ).status_code == 401


def test_a_viewer_cannot_reset_anyone(client, admin_h, viewer_h):
    uid, _, _ = _make_user(client, admin_h)
    assert client.post(f"/api/users/{uid}/password", headers=viewer_h,
                       json={"password": "Brand-New-Pass-1"}).status_code == 403


def test_changing_your_own_password_requires_the_current_one(client, admin_h):
    _, email, pw = _make_user(client, admin_h)
    h = hdr(client, (email, pw))
    assert client.post("/api/me/password", headers=h,
                       json={"current_password": "wrong",
                             "password": "Another-Good-1"}).status_code == 403
    assert client.post("/api/me/password", headers=h,
                       json={"current_password": pw,
                             "password": "Another-Good-1"}).status_code == 200
    assert client.post("/api/login",
                       json={"email": email, "password": "Another-Good-1"}
                       ).status_code == 200


def test_a_reset_password_must_also_meet_the_policy(client, admin_h):
    uid, _, _ = _make_user(client, admin_h)
    assert client.post(f"/api/users/{uid}/password", headers=admin_h,
                       json={"password": "abc"}).status_code == 400


def test_password_events_are_audited(client, admin_h):
    uid, _, _ = _make_user(client, admin_h)
    client.post(f"/api/users/{uid}/password", headers=admin_h,
                json={"password": "Brand-New-Pass-1"})
    actions = {a["action"] for a in
               client.get("/api/audit", headers=admin_h).json()["actions"]}
    assert "user.password_reset" in actions


# ── usernames ─────────────────────────────────────────────────────────
def test_sign_in_by_username(client):
    r = client.post("/api/login", json={"username": "admin",
                                        "password": ADMIN[1]})
    assert r.status_code == 200
    assert r.json()["user"]["username"] == "admin"


def test_sign_in_by_email_still_works(client):
    """Nobody is locked out on the day usernames arrive."""
    r = client.post("/api/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    assert r.status_code == 200


def test_username_is_case_insensitive(client):
    assert client.post("/api/login", json={"username": "ADMIN",
                                           "password": ADMIN[1]}
                       ).status_code == 200


def test_seeded_accounts_have_usernames(client, admin_h):
    users = client.get("/api/users", headers=admin_h).json()
    by_email = {u["email"]: u for u in users}
    assert by_email[ADMIN[0]]["username"] == "admin"
    assert by_email["viewer@ecews.org"]["username"] == "viewer"


@pytest.mark.parametrize("bad", ["ab", "has space", "no@sign", "-leading",
                                 "x" * 33])
def test_invalid_usernames_are_refused(client, admin_h, bad):
    r = client.post("/api/users", headers=admin_h,
                    json={"username": bad, "email": "u@ecews.org",
                          "password": "Correct-Horse-99"})
    assert r.status_code == 400


def test_usernames_are_unique_regardless_of_case(client, admin_h):
    body = {"username": "Sam", "email": "sam@ecews.org",
            "password": "Correct-Horse-99"}
    assert client.post("/api/users", headers=admin_h, json=body).status_code == 200
    clash = dict(body, username="SAM", email="other@ecews.org")
    assert client.post("/api/users", headers=admin_h, json=clash).status_code == 409


def test_lockout_counts_the_account_not_the_handle(client):
    """
    Five failures against the username and five against the email must not be
    two separate budgets for one account.
    """
    for _ in range(3):
        client.post("/api/login", json={"username": "admin", "password": "no"})
    for _ in range(2):
        client.post("/api/login", json={"email": ADMIN[0], "password": "no"})
    r = client.post("/api/login", json={"username": "admin",
                                        "password": ADMIN[1]})
    assert r.status_code == 429


# ── usage tracking ────────────────────────────────────────────────────
def test_usage_is_admin_only(client, viewer_h):
    assert client.get("/api/usage", headers=viewer_h).status_code == 403


def test_usage_records_activity_per_user(client, admin_h, viewer_h, cohort):
    client.get("/api/summary", headers=viewer_h)
    client.get("/api/summary", headers=admin_h)
    d = client.get("/api/usage?days=1", headers=admin_h).json()
    emails = {p["email"] for p in d["people"]}
    assert ADMIN[0] in emails
    assert d["gap_minutes"] > 0
    # Requests within one window collapse into a single session per user.
    assert all(p["sessions"] >= 1 for p in d["people"])


def test_usage_never_records_the_login_route(client, admin_h):
    """Sign-in belongs to the audit trail; logging it here too would double-count
    and would attribute a request to a session that did not exist yet."""
    client.post("/api/login", json={"email": ADMIN[0], "password": "wrong"})
    paths = {p["path"] for p in
             client.get("/api/usage?days=1", headers=admin_h).json()["pages"]}
    assert "/api/login" not in paths


# ── upload pipeline ───────────────────────────────────────────────────
def _workbook() -> bytes:
    """Minimal three-sheet workbook as a zip of Parquet, matching the real shape."""
    sn = ["0.111111111111", "0.222222222222"]
    total = pd.DataFrame({
        "S/N": sn, "currentViralLoad": [5000, 20000],
        "dateofCurrentViralLoad": ["2026-01-10", "2026-01-12"],
        "dateResultReceivedFacility": ["2026-01-15", "2026-01-17"],
        "lastDateOfSampleCollection": ["2026-01-05", "2026-01-07"],
        "CurrentRegimenLine": ["1st Line", "1st Line"]})
    treat = pd.DataFrame({
        "S/N": sn, "state": ["Delta", "Osun"], "lga": ["Warri", "Ife"],
        "facilityName": ["Clinic A", "Clinic C"], "sex": ["F", "M"],
        "currentAge": [30, 12], "currentArtStatus": ["Active", "Active"],
        "currentRegimenLine": ["1st Line", "1st Line"],
        "currentArtRegimen": ["TDF/3TC/DTG", "ABC/3TC/DTG"],
        "artStartDate": ["2019-03-01", "2020-06-01"],
        "daysOnArt": [2500, 2000], "dsdModel": ["MMD", "MMD"],
        "currentViralLoad": [40, 60000],
        "dateofCurrentViralLoad": ["2026-06-01", "2026-06-02"],
        "lastDateOfSampleCollection": ["2026-05-20", "2026-05-21"]})
    eac = pd.DataFrame({
        "S/N": sn,
        "Session_1_Date": ["2026-02-01", "2026-02-03"],
        "Session_2_Date": ["2026-03-01", None],
        "Session_3_Date": ["2026-04-01", None],
        "EAC_Cycle_Number": [1, 1],
        "Total_EAC_Sessions_All_Cycles": [3, 1]})

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, df in (("Total Unsuppressed", total),
                         ("Treatment Line List_18th July", treat),
                         ("EAC Line List_10th July", eac)):
            b = io.BytesIO()
            df.astype(str).to_parquet(b, index=False)
            z.writestr(f"{name}.parquet", b.getvalue())
    return buf.getvalue()


def test_upload_builds_a_cohort_and_becomes_current(client, admin_h):
    r = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-18"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cohort"] == 2
    assert body["primary_eac_sheet"] == "EAC Line List_10th July"

    # It is now the snapshot everyone reads.
    assert client.get("/api/summary", headers=admin_h).json()["n"] == 2


def test_upload_picks_the_newest_treatment_sheet(client, admin_h):
    """Guards the regression where the FIRST treatment sheet silently won."""
    r = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())})
    warns = " ".join(r.json()["warnings"])
    assert "Treatment Line List_18th July" in warns or r.status_code == 200


def test_back_dated_upload_is_warned_about(client, admin_h):
    """
    Time-based indicators are measured FROM as_of, so an upload dated earlier
    than the one it replaces makes them fall on arithmetic alone. Completed EAC
    needs 30 days since session 3; moving the clock back two days once retired
    ten completions and read as clients un-completing a cycle.
    """
    client.post("/api/uploads", headers=admin_h,
                files={"file": ("wb.parquet.zip", _workbook())},
                data={"as_of": "2026-07-24"})
    r = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-18"})       # six days backwards
    assert r.status_code == 200, r.text
    warnings = " ".join(r.json()["warnings"])
    assert "EARLIER" in warnings
    assert "6 days" in warnings
    # and it is raised on the data-quality page, not only in the response
    names = {f["check_name"] for f in client.get("/api/dq", headers=admin_h).json()}
    assert "Upload is back-dated" in names


def test_forward_dated_upload_is_not_warned_about(client, admin_h):
    client.post("/api/uploads", headers=admin_h,
                files={"file": ("wb.parquet.zip", _workbook())},
                data={"as_of": "2026-07-18"})
    r = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-24"})
    assert "EARLIER" not in " ".join(r.json()["warnings"])


# ── deployment diagnostics ────────────────────────────────────────────
def test_diagnostics_reports_derived_column_fill(client, admin_h):
    """
    An empty filter has two causes that look identical from the interface: the
    column was never derived (workbook loaded by older code) or the export
    never carried it. This endpoint separates them.
    """
    client.post("/api/uploads", headers=admin_h,
                files={"file": ("wb.parquet.zip", _workbook())},
                data={"as_of": "2026-07-24"})
    d = client.get("/api/diagnostics", headers=admin_h).json()
    assert d["ok"] is True
    by = {c["column"]: c for c in d["columns"]}
    assert by["lga_res_norm"]["status"] in ("ok", "partial", "empty")
    assert by["treatment_plan"]["pct"] == 100.0      # every episode gets a plan
    assert "app_version" in d


def test_diagnostics_is_admin_only(client, viewer_h):
    assert client.get("/api/diagnostics", headers=viewer_h).status_code == 403


# ── snapshot comparison ───────────────────────────────────────────────
def test_compare_reports_movement_between_snapshots(client, admin_h):
    a = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-18"}).json()["upload_id"]
    b = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-24"}).json()["upload_id"]
    d = client.get(f"/api/compare?a={a}&b={b}", headers=admin_h).json()
    assert d["ok"] is True
    assert d["days_between"] == 6
    assert d["back_dated"] is False
    assert d["flow"]["carried"] == 2          # same synthetic workbook both times
    assert {m["metric"] for m in d["metrics"]} >= {"Commenced EAC", "Completed EAC"}


def test_compare_flags_a_backwards_pair(client, admin_h):
    a = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-24"}).json()["upload_id"]
    b = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-18"}).json()["upload_id"]
    d = client.get(f"/api/compare?a={a}&b={b}", headers=admin_h).json()
    assert d["back_dated"] is True
    assert d["days_between"] == -6


def test_compare_is_available_to_a_viewer(client, admin_h, viewer_h):
    """Programme movement is an analytical question, not an administrative one."""
    a = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-18"}).json()["upload_id"]
    b = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("wb.parquet.zip", _workbook())},
                    data={"as_of": "2026-07-24"}).json()["upload_id"]
    assert client.get(f"/api/compare?a={a}&b={b}", headers=viewer_h).status_code == 200


def test_compare_rejects_an_unknown_snapshot(client, admin_h):
    assert client.get("/api/compare?a=999998&b=999999",
                      headers=admin_h).status_code == 404


def test_upload_is_audited(client, admin_h):
    client.post("/api/uploads", headers=admin_h,
                files={"file": ("wb.parquet.zip", _workbook())})
    actions = {a["action"] for a in
               client.get("/api/audit", headers=admin_h).json()["actions"]}
    assert "upload.create" in actions


def test_a_broken_upload_does_not_replace_the_current_snapshot(
        client, admin_h, cohort):
    before = client.get("/api/summary", headers=admin_h).json()["n"]
    r = client.post("/api/uploads", headers=admin_h,
                    files={"file": ("junk.xlsx", b"not a workbook at all")})
    assert r.status_code == 400
    assert client.get("/api/summary", headers=admin_h).json()["n"] == before


def test_deleting_a_snapshot_cascades_its_cohort_rows(client, admin_h, cohort):
    from app.main import pool
    with pool.connection() as c:
        c.execute("UPDATE uploads SET is_current=FALSE WHERE id=%s", (cohort,))
    assert client.delete(f"/api/uploads/{cohort}",
                         headers=admin_h).status_code == 200
    with pool.connection() as c:
        left = c.execute("SELECT count(*) AS n FROM cohort WHERE upload_id=%s",
                         (cohort,)).fetchone()["n"]
    assert left == 0


def test_the_current_snapshot_cannot_be_deleted(client, admin_h, cohort):
    r = client.delete(f"/api/uploads/{cohort}", headers=admin_h)
    assert r.status_code == 400
