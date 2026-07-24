"""
ECEWS SPEED · Treatment Failure Monitor - API

Roles
  admin    upload workbooks, manage users
  analyst  read everything, export line lists
  viewer   read only, row-scoped to their state / facility

Viewers never touch a workbook. An admin uploads once per cycle and everyone
else reads the current snapshot. Each upload is immutable, so you can always
say what the dashboard showed on a given date.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import pandas as pd
from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException, Query,
                     Request, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

from . import indicators as ind
from .ingest import COHORT_COLS, cohort_records, ingest_workbook
from .security import create_token, decode_token, hash_password, verify_password

log = logging.getLogger("ecews")
DSN = os.getenv("DATABASE_URL", "postgresql://ecews:ecews@db:5432/ecews")
pool: ConnectionPool


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    pool = ConnectionPool(DSN, min_size=1, max_size=10,
                          kwargs={"row_factory": dict_row})
    with pool.connection() as c:
        c.execute((Path(__file__).parent / "schema.sql").read_text())
        # seed each account only if absent, so both survive an existing DB
        def _seed(email, name, role, pw):
            if not c.execute("SELECT 1 FROM users WHERE email=%s", (email,)).fetchone():
                c.execute("INSERT INTO users (email,password_hash,full_name,role) "
                          "VALUES (%s,%s,%s,%s)", (email, hash_password(pw), name, role))
                log.warning("Seeded %s (%s) - change this password.", email, role)
        _seed("admin@ecews.org", "Administrator", "admin",
              os.getenv("ADMIN_PASSWORD", "changeme"))
        # a shared read-only account so others can log in and test immediately
        _seed("viewer@ecews.org", "Viewer", "viewer",
              os.getenv("VIEWER_PASSWORD", "viewer1234"))
    yield
    pool.close()


app = FastAPI(title="ECEWS TF Monitor", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"], allow_headers=["*"])


# ── auth ──────────────────────────────────────────────────────────────
class Login(BaseModel):
    email: str
    password: str


def auth(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")
    uid = decode_token(authorization[7:])["sub"]
    with pool.connection() as c:
        u = c.execute("SELECT * FROM users WHERE id=%s AND is_active",
                      (int(uid),)).fetchone()
    if not u:
        raise HTTPException(401, "User not found")
    return u


def admin(u: Annotated[dict, Depends(auth)]) -> dict:
    if u["role"] != "admin":
        raise HTTPException(403, "Admin only")
    return u


def _public(u: dict) -> dict:
    return {"email": u["email"], "name": u["full_name"], "role": u["role"],
            "scope_state": u["scope_state"], "scope_facility": u["scope_facility"]}


# ── audit trail ───────────────────────────────────────────────────────
# Every authentication attempt and every access to patient-level data is
# recorded. The dashboard holds PPI-removed but still identifiable-in-context
# clinical line lists, so "who looked at what, and when" has to be answerable
# after the fact rather than reconstructed from platform logs.

LOCKOUT_FAILS = int(os.getenv("LOGIN_LOCKOUT_FAILS", "5"))
LOCKOUT_MINUTES = int(os.getenv("LOGIN_LOCKOUT_MINUTES", "15"))


def _client_ip(request: Request | None) -> str | None:
    """Caller IP, honouring the proxy header the hosting platform sets."""
    if request is None:
        return None
    # Railway/Render/nginx terminate TLS and forward the original address.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return request.client.host[:64] if request.client else None


def _audit(action: str, *, user_id: int | None = None, email: str | None = None,
           detail: str | None = None, request: Request | None = None) -> None:
    """Append one audit row. Never raises: an audit failure must not 500 a request."""
    try:
        with pool.connection() as c:
            c.execute(
                "INSERT INTO audit_log (user_id,email,action,detail,ip) "
                "VALUES (%s,%s,%s,%s,%s)",
                (user_id, (email or "").lower().strip() or None, action,
                 (detail or "")[:500] or None, _client_ip(request)))
    except Exception:  # noqa: BLE001
        log.exception("audit write failed for action=%s", action)


# How long a gap ends a session. There is no logout event to rely on - the
# token is stateless and people close the tab - so sessions are inferred from
# inactivity, the same way web analytics does it. This makes durations an
# ESTIMATE, and a session containing a single request measures as zero.
SESSION_GAP_MINUTES = int(os.getenv("SESSION_GAP_MINUTES", "30"))


@app.middleware("http")
async def _record_usage(request: Request, call_next):
    """
    One row per authenticated API call, for the usage panel.

    The user is taken from the token rather than the database: this runs on
    every request, and a lookup per request would be a real cost for a figure
    nobody needs to be exact. Anything that goes wrong here is swallowed -
    usage tracking must never be the reason a page fails to load.
    """
    response = await call_next(request)
    try:
        path = request.url.path
        head = request.headers.get("authorization", "")
        if (path.startswith("/api/") and path not in ("/api/health", "/api/login")
                and head.startswith("Bearer ")):
            uid = int(decode_token(head[7:])["sub"])
            with pool.connection() as c:
                c.execute("INSERT INTO usage_log (user_id, path) VALUES (%s,%s)",
                          (uid, path[:120]))
    except Exception:  # noqa: BLE001
        pass
    return response


def _recent_failures(email: str) -> int:
    """
    Failed sign-ins for this address since the later of the lockout window and
    the last successful sign-in.

    Counting from the last success is what makes the lockout usable: someone who
    fumbles a password twice, gets in, then mistypes again on a new device is not
    three-fifths of the way to being locked out.

    Backed by audit_log rather than process memory so the limit survives a
    restart and holds across every worker.
    """
    with pool.connection() as c:
        r = c.execute(
            "WITH last_ok AS ("
            "  SELECT max(ts) AS t FROM audit_log"
            "   WHERE action='login.success' AND email=%s)"
            " SELECT count(*) AS n FROM audit_log, last_ok"
            "  WHERE action='login.failure' AND email=%s"
            f"   AND ts > now() - interval '{LOCKOUT_MINUTES} minutes'"
            "    AND ts > COALESCE(last_ok.t, '-infinity'::timestamptz)",
            (email, email)).fetchone()
    return int(r["n"]) if r else 0


@app.post("/api/login")
def login(body: Login, request: Request):
    email = body.email.lower().strip()

    if _recent_failures(email) >= LOCKOUT_FAILS:
        _audit("login.blocked", email=email, request=request,
               detail=f"{LOCKOUT_FAILS} failed attempts within "
                      f"{LOCKOUT_MINUTES} minutes")
        raise HTTPException(429, f"Too many failed attempts. Try again in "
                                 f"{LOCKOUT_MINUTES} minutes.")

    with pool.connection() as c:
        u = c.execute("SELECT * FROM users WHERE email=%s AND is_active",
                      (email,)).fetchone()
    if not u or not verify_password(body.password, u["password_hash"]):
        # Deliberately does not distinguish unknown address from wrong password:
        # the response must not confirm whether an account exists.
        _audit("login.failure", email=email, request=request,
               user_id=u["id"] if u else None)
        raise HTTPException(401, "Wrong email or password")

    _audit("login.success", user_id=u["id"], email=email, request=request)
    return {"token": create_token(u["id"]), "user": _public(u)}


@app.get("/api/me")
def me(u: Annotated[dict, Depends(auth)]):
    return _public(u)


# ── filters as a dependency ───────────────────────────────────────────
class Filters(BaseModel):
    state: str | None = None
    lga: str | None = None
    facility: str | None = None
    sex: str | None = None
    age_band: str | None = None
    quarter: str | None = None
    fy: str | None = None
    plan: str | None = None


def filters(
    state: str | None = Query(None), lga: str | None = Query(None),
    facility: str | None = Query(None), sex: str | None = Query(None),
    age_band: str | None = Query(None), quarter: str | None = Query(None),
    fy: str | None = Query(None), plan: str | None = Query(None),
) -> Filters:
    return Filters(state=state, lga=lga, facility=facility, sex=sex,
                   age_band=age_band, quarter=quarter, fy=fy, plan=plan)


F = Annotated[Filters, Depends(filters)]
U = Annotated[dict, Depends(auth)]


def _current_upload(c) -> int:
    r = c.execute("SELECT id FROM uploads WHERE is_current").fetchone()
    if not r:
        raise HTTPException(404, "No data loaded yet. An admin needs to upload a workbook.")
    return r["id"]


def _load(u: dict, f: Filters) -> pd.DataFrame:
    """Current cohort, with filters AND the user's row scope applied."""
    clauses, args = ["upload_id = %s"], []

    # Scope wins over a requested filter: a Delta viewer cannot ask for Osun.
    state = u["scope_state"] or (f.state if f.state and f.state != "All" else None)
    facility = u["scope_facility"] or (
        f.facility if f.facility and f.facility != "All" else None)

    for col, val in (("state", state), ("facility", facility), ("lga", f.lga),
                     ("sex", f.sex), ("age_band", f.age_band),
                     ("enrol_quarter", f.quarter), ("fy", f.fy),
                     ("treatment_plan", f.plan)):
        if val and val != "All":
            clauses.append(f"{col} = %s")
            args.append(val)

    with pool.connection() as c:
        uid = _current_upload(c)
        rows = c.execute(
            f"SELECT * FROM cohort WHERE {' AND '.join(clauses)}",
            (uid, *args)).fetchall()

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # Booleans come back as object when any NULL is present. `~` misbehaves
    # silently on object dtype, so coerce before any negation happens.
    for b in ("eac1", "eac2", "eac3", "eac_extended", "eac_completed", "post_sample",
              "post_result", "resuppressed", "undetectable", "llv", "eac_valid",
              "still_unsuppressed", "switched", "eac_prior_cycle", "eac_truncated",
              "dtc_review", "paed"):
        if b in df:
            df[b] = df[b].fillna(False).astype(bool)
    for d in ("idx_date", "fu_date"):
        if d in df:
            df[d] = pd.to_datetime(df[d], errors="coerce")
    for n in ("idx_vl", "fu_vl", "age", "months_unsuppressed", "time_to_eac",
              "time_to_resupp", "eac_lead_time", "sessions"):
        if n in df:
            df[n] = pd.to_numeric(df[n], errors="coerce")
    return df


# ── upload (admin only) ───────────────────────────────────────────────
@app.post("/api/uploads")
def create_upload(
    u: Annotated[dict, Depends(admin)],
    request: Request,
    file: UploadFile = File(...),
    as_of: str | None = Form(None),
    cohort_mode: str = Form("event"),
):
    when = pd.Timestamp(as_of) if as_of else pd.Timestamp(dt.date.today())
    raw = file.file.read()

    with pool.connection() as c:
        uid = c.execute(
            "INSERT INTO uploads (filename,as_of,uploaded_by,status,cohort_mode) "
            "VALUES (%s,%s,%s,'processing',%s) RETURNING id",
            (file.filename, when.date(), u["id"], cohort_mode)).fetchone()["id"]

    try:
        coh, findings, warns, infos, primary = ingest_workbook(
            raw, when, cohort_mode, filename=file.filename or "")
        rows = cohort_records(coh.df, uid)
        cols = ", ".join(["upload_id"] + [f'"{c}"' for c in COHORT_COLS])
        ph = ", ".join(["%s"] * (len(COHORT_COLS) + 1))

        with pool.connection() as c:
            with c.cursor() as cur:
                cur.executemany(f"INSERT INTO cohort ({cols}) VALUES ({ph})", rows)
                cur.executemany(
                    "INSERT INTO dq_findings (upload_id,sheet,check_name,severity,"
                    "n_records,detail) VALUES (%s,%s,%s,%s,%s,%s)",
                    [(uid, f["sheet"], f["check_name"], f["severity"],
                      f["n_records"], f["detail"]) for f in findings])
            # Exactly one snapshot is ever current; the flip is atomic.
            c.execute("UPDATE uploads SET is_current=FALSE WHERE is_current")
            sources = [{"name": i.name, "kind": i.kind, "rows": i.rows,
                        "censored": i.censored} for i in infos]
            c.execute(
                "UPDATE uploads SET status='ready', n_cohort=%s, n_eac=%s, "
                "n_treatment=%s, warnings=%s::jsonb, sources=%s::jsonb, "
                "is_current=TRUE WHERE id=%s",
                (len(rows),
                 sum(i.rows for i in infos if i.kind == "eac"),
                 sum(i.rows for i in infos if i.kind == "treatment"),
                 json.dumps(warns), json.dumps(sources), uid))
    except Exception as e:  # noqa: BLE001
        log.exception("ingest failed")
        with pool.connection() as c:
            c.execute("UPDATE uploads SET status='failed', error=%s WHERE id=%s",
                      (str(e)[:800], uid))
        _audit("upload.failed", user_id=u["id"], email=u["email"], request=request,
               detail=f"upload {uid} ({file.filename}): {str(e)[:200]}")
        raise HTTPException(400, f"Ingest failed: {e}") from e

    _audit("upload.create", user_id=u["id"], email=u["email"], request=request,
           detail=f"upload {uid} ({file.filename}), as_of {when.date()}, "
                  f"{len(rows)} cohort rows, now the current snapshot")
    return {"upload_id": uid, "cohort": len(rows), "primary_eac_sheet": primary,
            "warnings": warns,
            "sheets": [{"name": i.name, "kind": i.kind, "rows": i.rows,
                        "censored": i.censored} for i in infos]}


@app.get("/api/uploads")
def list_uploads(u: U):
    with pool.connection() as c:
        return c.execute(
            "SELECT id,filename,as_of,uploaded_at,status,n_cohort,warnings,"
            "is_current,error FROM uploads ORDER BY uploaded_at DESC LIMIT 50"
        ).fetchall()


@app.delete("/api/uploads/{uid}")
def delete_upload(uid: int, u: Annotated[dict, Depends(admin)], request: Request):
    """Delete one immutable snapshot. Cohort + DQ rows cascade. Never the current one."""
    with pool.connection() as c:
        row = c.execute("SELECT is_current,filename FROM uploads WHERE id=%s",
                        (uid,)).fetchone()
        if not row:
            raise HTTPException(404, "Upload not found.")
        if row["is_current"]:
            raise HTTPException(400, "Cannot delete the current upload - it is the active data.")
        c.execute("DELETE FROM uploads WHERE id=%s", (uid,))
    _audit("upload.delete", user_id=u["id"], email=u["email"], request=request,
           detail=f"upload {uid} ({row['filename']}), cohort rows cascaded")
    return {"ok": True}


@app.post("/api/uploads/prune")
def prune_uploads(u: Annotated[dict, Depends(admin)], request: Request):
    """Delete every snapshot except the current one - a one-click cleanup."""
    with pool.connection() as c:
        cur = c.execute("DELETE FROM uploads WHERE is_current IS NOT TRUE")
    _audit("upload.prune", user_id=u["id"], email=u["email"], request=request,
           detail=f"{cur.rowcount} non-current snapshots deleted")
    return {"ok": True, "deleted": cur.rowcount}


# ── analytics ─────────────────────────────────────────────────────────
@app.get("/api/summary")
def summary(u: U, f: F):
    df = _load(u, f)
    with pool.connection() as c:
        up = c.execute("SELECT * FROM uploads WHERE is_current").fetchone()
    if df.empty:
        return {"n": 0, "as_of": up["as_of"], "warnings": up["warnings"]}
    n, r = len(df), int(df["post_result"].sum())
    resupp = int(df["resuppressed"].sum())
    return {
        "n": n, "clients": int(df["sn"].nunique()),
        "as_of": up["as_of"], "filename": up["filename"],
        "warnings": up["warnings"],
        "eac1": int(df["eac1"].sum()),
        "eac1_pct": round(int(df["eac1"].sum()) / n * 100, 1),
        "eac_completed": int(df["eac_completed"].sum()),
        "post_result": r,
        "post_result_pct": round(r / n * 100, 1),
        "resuppressed": resupp,
        "resupp_pct": round(resupp / r * 100, 1) if r else None,
        "still_unsuppressed": int(df["still_unsuppressed"].sum()),
        "switched": int(df["switched"].sum()),
        "awaiting_switch": int(df["awaiting_switch"].sum()),
        "dtc_review": int(df["dtc_review"].sum()),
        "median_time_to_eac": (None if df["time_to_eac"].dropna().empty
                               else float(df["time_to_eac"].median())),
    }


@app.get("/api/cascade")
def get_cascade(u: U, f: F):
    df = _load(u, f)
    return ind.cascade(df) if not df.empty else []


@app.get("/api/time-metrics")
def get_times(u: U, f: F):
    df = _load(u, f)
    return ind.time_metrics(df) if not df.empty else {}


@app.get("/api/survival")
def get_survival(u: U, f: F):
    df = _load(u, f)
    return ind.kaplan_meier(df) if not df.empty else []


DIMS = {"state", "lga", "facility", "sex", "age_band", "regimen_line",
        "vl_magnitude", "fy_quarter", "enrol_quarter", "fy", "treatment_plan"}


@app.get("/api/breakdown/{by}")
def get_breakdown(by: str, u: U, f: F):
    if by not in DIMS:
        raise HTTPException(400, f"Unsupported dimension. Try: {', '.join(sorted(DIMS))}")
    df = _load(u, f)
    return ind.breakdown(df, by) if not df.empty else []


@app.get("/api/plans")
def get_plans(u: U, f: F):
    df = _load(u, f)
    if df.empty:
        return []
    vc = df["treatment_plan"].value_counts()
    return [{"plan": k, "n": int(v), "pct": round(v / len(df) * 100, 1)}
            for k, v in vc.items()]


# Deep-dive flags (spec §3) - each one is a facility worklist.
FLAGS = {
    "no_eac": lambda d: ~d["eac1"],
    "eac_incomplete": lambda d: d["eac1"] & ~d["eac_completed"],
    # the new gap (team review): completed the course >=30 days ago but no VL
    # sample has been collected on/after session 3
    "awaiting_vl": lambda d: d["eac_completed"] & ~d["post_eac_vl"],
    "awaiting_switch": lambda d: d["awaiting_switch"],
    "prior_switch": lambda d: d["prior_switch"],
    # left care (LTFU/died/IIT/stopped/transferred out) and never retested
    "exited_no_vl": lambda d: ind.care_status(d).isin(ind._NEG_OUTCOMES)
                              & ~d["post_result"].fillna(False).astype(bool),
    "long_unsuppressed": lambda d: d["months_unsuppressed"] > 6,
    "dtc_review": lambda d: d["dtc_review"],
    # two separate truncation cohorts - see indicators.build_cohort
    "trunc_pre": lambda d: d["eac_trunc_pre"],
    "trunc_mid": lambda d: d["eac_trunc_mid"],
    "prior_cycle": lambda d: d["eac_prior_cycle"],
}
CLIENT_COLS = ["sn", "state", "lga", "facility", "sex", "age", "art_status",
               "idx_vl", "idx_date", "sessions", "eac_completed", "fu_vl",
               "still_unsuppressed", "switched", "months_unsuppressed",
               "treatment_plan"]


def _json_safe(df: pd.DataFrame) -> list[dict]:
    """NaN/NaT are not valid JSON. Convert to null before serialising."""
    return df.astype(object).where(pd.notna(df), None).to_dict("records")


def _clients(u: dict, f: Filters, flag: str | None, limit: int) -> pd.DataFrame:
    df = _load(u, f)
    if df.empty:
        return df
    if flag:
        if flag not in FLAGS:
            raise HTTPException(400, f"Unknown flag. Try: {', '.join(FLAGS)}")
        df = df[FLAGS[flag](df)]
    return df[CLIENT_COLS].head(limit)


def _access_note(f: Filters, flag: str | None, n: int) -> str:
    """Human-readable record of exactly which slice was retrieved."""
    where = ", ".join(f"{k}={v}" for k, v in f.model_dump().items()
                      if v and v != "All") or "no filters"
    return f"{n} client rows; {where}; flag={flag or 'none'}"


@app.get("/api/clients")
def get_clients(u: U, f: F, request: Request, flag: str | None = Query(None),
                limit: int = Query(500, le=5000)):
    df = _clients(u, f, flag, limit)
    _audit("clients.view", user_id=u["id"], email=u["email"], request=request,
           detail=_access_note(f, flag, len(df)))
    return [] if df.empty else _json_safe(df)


@app.get("/api/export")
def export_csv(u: U, f: F, request: Request, flag: str | None = Query(None)):
    # Bulk extraction of patient-level records. Restricted to admin/analyst:
    # a scoped viewer reads the dashboard, but pulling the line list out of it
    # is a different act and is logged as such.
    if u["role"] not in ("admin", "analyst"):
        _audit("export.denied", user_id=u["id"], email=u["email"], request=request,
               detail=f"role={u['role']}")
        raise HTTPException(403, "Exporting the line list requires an analyst "
                                 "or administrator account.")
    df = _clients(u, f, flag, 100_000)
    _audit("export.csv", user_id=u["id"], email=u["email"], request=request,
           detail=_access_note(f, flag, len(df)))
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    name = f"ecews_tf_{flag or 'cohort'}_{dt.date.today()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/risk")
def get_risk(u: U, f: F):
    df = _load(u, f)
    return ind.resuppression_model(df) if not df.empty else {"ok": False, "reason": "No data."}


@app.get("/api/mortality")
def get_mortality(u: U, f: F):
    df = _load(u, f)
    return ind.mortality(df) if not df.empty else {"ok": False}


@app.get("/api/deep-dive")
def get_deep_dive(u: U, f: F):
    df = _load(u, f)
    return ind.deep_dive(df) if not df.empty else {"ok": False, "reason": "No data."}


@app.get("/api/profile")
def get_profile(u: U, f: F):
    """Descriptive who/what/when/where composition of the cohort."""
    df = _load(u, f)
    return ind.profile(df) if not df.empty else {"n": 0}


@app.get("/api/unsupp-curve")
def get_unsupp_curve(u: U, f: F):
    """Cumulative % reaching first unsuppressed VL by years on ART, by era."""
    df = _load(u, f)
    return ind.time_to_unsupp_curve(df) if not df.empty else {}


@app.get("/api/dtc")
def get_dtc(u: U, f: F):
    """Repeat-unsuppression + switch-gap cohort for the DTC-review page."""
    df = _load(u, f)
    return ind.dtc_review(df) if not df.empty else {"ok": False}


class Feedback(BaseModel):
    message: str
    page: str | None = None


@app.post("/api/feedback")
def post_feedback(body: Feedback, u: Annotated[dict, Depends(auth)]):
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "Message is empty.")
    with pool.connection() as c:
        c.execute(
            "INSERT INTO feedback (user_id,email,page,message) VALUES (%s,%s,%s,%s)",
            (u["id"], u["email"], (body.page or "")[:60], msg[:4000]))
    return {"ok": True}


@app.get("/api/feedback")
def list_feedback(u: Annotated[dict, Depends(admin)]):
    with pool.connection() as c:
        return c.execute(
            "SELECT email,page,message,created_at FROM feedback "
            "ORDER BY created_at DESC LIMIT 200").fetchall()


# ── user management (admin only) ──────────────────────────────────────
class NewUser(BaseModel):
    email: str
    full_name: str | None = None
    role: str = "viewer"
    password: str
    scope_state: str | None = None


class NewPassword(BaseModel):
    password: str
    current_password: str | None = None   # required when changing your own


# Minimum length, configurable so ECEWS policy can raise it without a code
# change. The seeded defaults are refused outright: the whole point of a reset
# is to stop an account sitting on a password that is printed in this source.
MIN_PASSWORD = int(os.getenv("MIN_PASSWORD_LENGTH", "10"))
_BANNED = {"changeme", "viewer1234", "blindalley", "password", "admin",
           "12345678", "password123"}


def _check_password(pw: str) -> None:
    pw = pw or ""
    if len(pw) < MIN_PASSWORD:
        raise HTTPException(
            400, f"Password must be at least {MIN_PASSWORD} characters.")
    if pw.lower() in _BANNED:
        raise HTTPException(
            400, "That password is one of the known defaults. Choose another.")


@app.get("/api/users")
def list_users(u: Annotated[dict, Depends(admin)]):
    with pool.connection() as c:
        return c.execute(
            "SELECT id,email,full_name,role,scope_state,is_active,created_at "
            "FROM users ORDER BY role, created_at").fetchall()


@app.post("/api/users")
def create_user(body: NewUser, u: Annotated[dict, Depends(admin)], request: Request):
    email = (body.email or "").lower().strip()
    if "@" not in email:
        raise HTTPException(400, "A valid email is required.")
    _check_password(body.password)
    role = body.role if body.role in ("admin", "analyst", "viewer") else "viewer"
    with pool.connection() as c:
        if c.execute("SELECT 1 FROM users WHERE email=%s", (email,)).fetchone():
            raise HTTPException(409, "A user with that email already exists.")
        c.execute(
            "INSERT INTO users (email,password_hash,full_name,role,scope_state) "
            "VALUES (%s,%s,%s,%s,%s)",
            (email, hash_password(body.password),
             body.full_name or email.split("@")[0], role,
             (body.scope_state or None) if (body.scope_state or "") != "All" else None))
    _audit("user.create", user_id=u["id"], email=u["email"], request=request,
           detail=f"created {email} role={role} scope={body.scope_state or 'all states'}")
    return {"ok": True}


@app.patch("/api/users/{uid}")
def toggle_user(uid: int, u: Annotated[dict, Depends(admin)], request: Request):
    if uid == u["id"]:
        raise HTTPException(400, "You cannot deactivate your own account.")
    with pool.connection() as c:
        r = c.execute("UPDATE users SET is_active = NOT is_active WHERE id=%s "
                      "RETURNING email, is_active", (uid,)).fetchone()
    if not r:
        raise HTTPException(404, "User not found.")
    _audit("user.toggle", user_id=u["id"], email=u["email"], request=request,
           detail=f"{r['email']} -> {'activated' if r['is_active'] else 'deactivated'}")
    return {"ok": True}


@app.post("/api/users/{uid}/password")
def reset_password(uid: int, body: NewPassword, request: Request,
                   u: Annotated[dict, Depends(admin)]):
    """
    Administrative reset. Does NOT require the target's current password - that
    is the point: it is how an account whose password is unknown, forgotten or
    still on a seeded default gets recovered.
    """
    _check_password(body.password)
    with pool.connection() as c:
        r = c.execute("UPDATE users SET password_hash=%s WHERE id=%s "
                      "RETURNING email", (hash_password(body.password), uid)
                      ).fetchone()
    if not r:
        raise HTTPException(404, "User not found.")
    _audit("user.password_reset", user_id=u["id"], email=u["email"],
           request=request, detail=f"reset the password for {r['email']}")
    return {"ok": True}


@app.post("/api/me/password")
def change_own_password(body: NewPassword, request: Request, u: U):
    """
    Self-service change. Requires the current password, so a walk-up at an
    unattended signed-in browser cannot lock the real owner out of the account.
    """
    if not body.current_password or not verify_password(
            body.current_password, u["password_hash"]):
        _audit("user.password_change_failed", user_id=u["id"], email=u["email"],
               request=request, detail="current password did not match")
        raise HTTPException(403, "Your current password is not correct.")
    _check_password(body.password)
    with pool.connection() as c:
        c.execute("UPDATE users SET password_hash=%s WHERE id=%s",
                  (hash_password(body.password), u["id"]))
    _audit("user.password_change", user_id=u["id"], email=u["email"],
           request=request, detail="changed their own password")
    return {"ok": True}


@app.get("/api/audit")
def get_audit(u: Annotated[dict, Depends(admin)],
              action: str | None = Query(None),
              limit: int = Query(200, le=2000)):
    """
    The security audit trail, newest first. Admin only, and read-only: there is
    no endpoint that edits or deletes an audit row, by design.
    """
    clauses, args = [], []
    if action:
        clauses.append("action = %s")
        args.append(action)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with pool.connection() as c:
        rows = c.execute(
            f"SELECT id,ts,email,action,detail,ip FROM audit_log {where} "
            f"ORDER BY ts DESC LIMIT %s", (*args, limit)).fetchall()
        kinds = c.execute(
            "SELECT action, count(*) AS n FROM audit_log "
            "GROUP BY action ORDER BY n DESC").fetchall()
    return {"rows": rows, "actions": kinds}


@app.get("/api/usage")
def get_usage(u: Annotated[dict, Depends(admin)], days: int = Query(90, le=365)):
    """
    Who is using the dashboard, how often, and roughly for how long.

    Sessions are inferred from gaps in activity (see SESSION_GAP_MINUTES), so
    `minutes` is an estimate and a one-request session reads as zero. It is
    sound for "is this being used, and by whom"; it is not a precise dwell time
    and should not be reported as one.
    """
    window = f"{int(days)} days"
    with pool.connection() as c:
        people = c.execute(f"""
            WITH marked AS (
              SELECT user_id, ts,
                     CASE WHEN LAG(ts) OVER w IS NULL
                           OR ts - LAG(ts) OVER w >
                              interval '{SESSION_GAP_MINUTES} minutes'
                          THEN 1 ELSE 0 END AS starts
              FROM usage_log
              WHERE ts > now() - interval '{window}'
              WINDOW w AS (PARTITION BY user_id ORDER BY ts)
            ), grouped AS (
              SELECT user_id, ts,
                     SUM(starts) OVER (PARTITION BY user_id ORDER BY ts) AS sid
              FROM marked
            ), spans AS (
              SELECT user_id, sid, MIN(ts) AS started, MAX(ts) AS ended,
                     count(*) AS hits
              FROM grouped GROUP BY user_id, sid
            )
            SELECT us.email, us.role, us.scope_state, us.is_active,
                   count(*)                                   AS sessions,
                   sum(s.hits)                                AS requests,
                   count(DISTINCT s.started::date)            AS active_days,
                   max(s.ended)                               AS last_seen,
                   round(sum(EXTRACT(EPOCH FROM (s.ended - s.started)))
                         / 60.0)::int                         AS minutes
            FROM spans s JOIN users us ON us.id = s.user_id
            GROUP BY us.email, us.role, us.scope_state, us.is_active
            ORDER BY max(s.ended) DESC
        """).fetchall()

        pages = c.execute(f"""
            SELECT path, count(*) AS n, count(DISTINCT user_id) AS users
            FROM usage_log WHERE ts > now() - interval '{window}'
            GROUP BY path ORDER BY n DESC LIMIT 15
        """).fetchall()

        daily = c.execute(f"""
            SELECT ts::date AS day, count(*) AS n,
                   count(DISTINCT user_id) AS users
            FROM usage_log WHERE ts > now() - interval '{window}'
            GROUP BY 1 ORDER BY 1
        """).fetchall()

        never = c.execute("""
            SELECT email, role, created_at FROM users
            WHERE is_active AND id NOT IN (SELECT DISTINCT user_id
                                           FROM usage_log WHERE user_id IS NOT NULL)
            ORDER BY created_at
        """).fetchall()

    return {"people": people, "pages": pages, "daily": daily,
            "never_used": never, "gap_minutes": SESSION_GAP_MINUTES,
            "days": days}


@app.get("/api/dq")
def get_dq(u: U):
    with pool.connection() as c:
        uid = _current_upload(c)
        return c.execute(
            "SELECT sheet,check_name,severity,n_records,detail FROM dq_findings "
            "WHERE upload_id=%s ORDER BY CASE severity WHEN 'critical' THEN 0 "
            "WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, "
            "n_records DESC", (uid,)).fetchall()


@app.get("/api/overview")
def overview(u: U, f: F):
    """Everything the Overview page needs, in one round trip."""
    df = _load(u, f)
    with pool.connection() as c:
        up = c.execute("SELECT * FROM uploads WHERE is_current").fetchone()
    if df.empty:
        return {"n": 0, "as_of": up["as_of"], "warnings": up["warnings"]}

    def rate(a, b):
        return round(a / b * 100, 1) if b else None

    # ── progress by quarter: the maturation story ──────────────────────
    prog = []
    for q in sorted(x for x in df["enrol_quarter"].dropna().unique()):
        d = df[df["enrol_quarter"] == q]
        n = len(d)
        e1 = int(d["eac1"].sum())
        dn = int(d["eac_completed"].sum())
        rs = int(d["post_result"].sum())
        rr = int(d["resuppressed"].sum())
        prog.append({"quarter": q, "n": n,
                     "n_female": int((d["sex"] == "Female").sum()),
                     "n_male": int((d["sex"] == "Male").sum()),
                     "eac1": e1, "completed": dn,
                     "retested": rs, "resuppressed": rr,
                     "eac1_pct": rate(e1, n), "completed_pct": rate(dn, e1),
                     "retest_pct": rate(rs, n), "resupp_pct": rate(rr, rs)})

    # ── monthly incidence by sex, from Jul 2025 ────────────────────────
    # Monthly (not weekly): weekly was spiky and unreadable. Bucketed on
    # recv_date, the same clock the quarters use, and floored at Jul 2025 so
    # the axis starts clean rather than trailing empty pre-programme months.
    START = pd.Timestamp("2025-07-01")
    w = df.dropna(subset=["recv_date"]).copy()
    w["recv_date"] = pd.to_datetime(w["recv_date"])
    w = w[w["recv_date"] >= START]
    w["mo"] = w["recv_date"].dt.to_period("M").dt.start_time
    piv = w.pivot_table(index="mo", columns="sex", values="sn", aggfunc="count").fillna(0)
    for s in ("Female", "Male"):
        if s not in piv:
            piv[s] = 0
    # reindex to a continuous month range so gaps show as zero, not as a jump
    if len(piv):
        full = pd.date_range(piv.index.min(), piv.index.max(), freq="MS")
        piv = piv.reindex(full, fill_value=0)
    piv = piv.sort_index()
    weekly = {"months": [d.strftime("%Y-%m-%d") for d in piv.index],
              "female": [int(x) for x in piv["Female"]],
              "male": [int(x) for x in piv["Male"]]}

    # ── monthly re-suppression trend by sex ────────────────────────────
    # Rate = re-suppressed / episodes-with-a-follow-up-VL, bucketed on the
    # follow-up VL SAMPLE date (when the outcome was actually observed).
    # Months with < 3 results for a sex are blanked, not shown as 0/100%.
    rt = df[df["post_result"].fillna(False).astype(bool)].copy()
    rt["fu_samp"] = pd.to_datetime(rt["fu_samp"], errors="coerce")
    rt = rt[rt["fu_samp"].notna() & (rt["fu_samp"] >= START)]
    rt["mo"] = rt["fu_samp"].dt.to_period("M").dt.start_time
    ridx = (pd.date_range(rt["mo"].min(), rt["mo"].max(), freq="MS")
            if len(rt) else pd.DatetimeIndex([]))

    def _rs(sex):
        g = rt[rt["sex"] == sex].groupby("mo")["resuppressed"]
        num = g.sum().reindex(ridx)
        den = g.size().reindex(ridx)
        pct = (num / den * 100).round(1).where(den >= 3)
        return ([None if pd.isna(x) else float(x) for x in pct],
                [0 if pd.isna(x) else int(x) for x in den])

    f_pct, f_n = _rs("Female")
    m_pct, m_n = _rs("Male")
    resupp_trend = {"months": [d.strftime("%Y-%m-%d") for d in ridx],
                    "female": f_pct, "male": m_pct,
                    "female_n": f_n, "male_n": m_n}

    # ── demographics for the narrative ────────────────────────────────
    age = pd.to_numeric(df["age"], errors="coerce")
    doa = pd.to_numeric(df["days_on_art"], errors="coerce")
    line = df["regimen_line"].astype("string").str.lower()
    first_line = line.str.contains(r"1st|first", regex=True, na=False)
    n = len(df)
    female = int((df["sex"] == "Female").sum())
    male = int((df["sex"] == "Male").sum())
    paeds = int((age < 10).sum())
    adol = int(((age >= 10) & (age < 20)).sum())
    demo = {
        "female": female, "female_pct": rate(female, n),
        "male": male, "male_pct": rate(male, n),
        "paeds": paeds, "paeds_pct": rate(paeds, n),
        "adolescents": adol, "adolescents_pct": rate(adol, n),
        "median_months_art": round(float(doa.median()) / 30.44, 1) if doa.notna().any() else None,
        "first_line": int(first_line.sum()), "first_line_pct": rate(int(first_line.sum()), n),
        "second_line": int((~first_line & line.notna()
                            & line.str.contains(r"2nd|second|3rd|third", regex=True, na=False)).sum()),
    }
    demo["second_line_pct"] = rate(demo["second_line"], n)

    tte = pd.to_numeric(df["time_to_eac"], errors="coerce")
    lead = pd.to_numeric(df["eac_lead_time"], errors="coerce")
    demo["median_time_to_eac"] = round(float(tte.median()), 0) if tte.notna().any() else None
    demo["median_lead_months"] = round(float(lead.median()) / 30.44, 1) if lead.notna().any() else None

    # ── outcomes disaggregated ────────────────────────────────────────
    def resupp_of(mask):
        sub = df[mask & df["post_result"].fillna(False).astype(bool)]
        return {"n": int(len(sub)), "resupp": int(sub["resuppressed"].sum()),
                "pct": rate(int(sub["resuppressed"].sum()), len(sub))}
    disagg = {
        "sex": {s: resupp_of(df["sex"] == s) for s in ("Female", "Male")},
        "state": {st: resupp_of(df["state"] == st)
                  for st in sorted(x for x in df["state"].dropna().unique() if x != "Unknown")},
    }

    # ── per-state summary for the outcome card's state bars ────────────────
    st_grp = (df[df["state"].notna() & (df["state"] != "Unknown")]
              .groupby("state")
              .agg(n=("sn", "size"), eac1=("eac1", "sum"),
                   completed=("eac_completed", "sum"),
                   post=("post_result", "sum"), resupp=("resuppressed", "sum"))
              .reset_index())
    st_grp["eac1"] = st_grp["eac1"].astype(int)
    st_grp["completed"] = st_grp["completed"].astype(int)
    st_grp["eac1_pct"] = [rate(a, b) for a, b in zip(st_grp["eac1"], st_grp["n"])]
    st_grp["resupp_pct"] = [rate(int(a), int(b))
                            for a, b in zip(st_grp["resupp"], st_grp["post"])]
    by_state = _json_safe(st_grp.sort_values("n", ascending=False))

    # ── facility league ───────────────────────────────────────────────
    MIN_VOL = 20   # completion rates on <20 episodes are noise, not signal
    fac = (df.groupby("facility")
             .agg(n=("sn", "size"), eac1=("eac1", "sum"),
                  completed=("eac_completed", "sum"),
                  resupp=("resuppressed", "sum"))
             .reset_index())
    fac["eac1"] = fac["eac1"].astype(int)
    fac["completed"] = fac["completed"].astype(int)
    fac["eac1_pct"] = [rate(a, b) for a, b in zip(fac["eac1"], fac["n"])]
    fac["completed_pct"] = [rate(a, b) for a, b in zip(fac["completed"], fac["eac1"])]

    by_volume = fac.sort_values("n", ascending=False).head(10)
    ranked = fac[fac["n"] >= MIN_VOL].sort_values(
        "completed_pct", ascending=False, na_position="last")

    # Facilities carrying real volume with NO EAC record at all. Cannot tell
    # from the export whether the counselling did not happen or was not
    # recorded - either way it is the highest-yield thing on this page.
    zero = fac[(fac["n"] >= MIN_VOL) & (fac["eac1"] == 0)].sort_values("n", ascending=False)

    e1 = int(df["eac1"].sum())
    dn = int(df["eac_completed"].sum())
    rs = int(df["post_result"].sum())
    rr = int(df["resuppressed"].sum())
    still = int(df["still_unsuppressed"].sum())
    # Switch denominator = still-unsuppressed episodes that were 1st line at the
    # index VL (switchable). Prior-switch (2nd/3rd at index) is a separate group.
    sw_elig = df[df["switch_eligible"].fillna(False).astype(bool)]
    switched = int(sw_elig["switched"].fillna(False).astype(bool).sum())
    prior_sw = int(df["prior_switch"].fillna(False).astype(bool).sum())
    repeats_fail = int(df["repeat_failure"].fillna(False).astype(bool).sum())

    return {
        "n": n,
        "clients": int(df["sn"].nunique()),
        "repeats": n - int(df["sn"].nunique()),          # repeat-occurrence episodes
        "repeat_clients": int((df["sn"].value_counts() > 1).sum()),  # clients with >1
        "as_of": up["as_of"],
        "warnings": up["warnings"],
        "eac1": e1, "eac1_pct": rate(e1, n),
        "never_eac": n - e1,
        "completed": dn, "completed_pct": rate(dn, e1),
        "post_eac_vl": int(df["post_eac_vl"].fillna(False).astype(bool).sum()),
        # A follow-up VL is ANY later VL, so it is not conditional on EAC and
        # cannot be reported against the EAC denominator (that gave >100%).
        "retested": rs, "retest_pct": rate(rs, n),
        "awaiting_retest": n - rs,
        "resuppressed": rr, "resupp_pct": rate(rr, rs),
        "still_unsuppressed": still,
        "switch_eligible": len(sw_elig),
        "switched": switched,
        "prior_switch": prior_sw,
        "switch_pct": rate(switched, len(sw_elig)),
        "awaiting_switch": int(df["awaiting_switch"].fillna(False).astype(bool).sum()),
        "repeat_failure": repeats_fail,
        "progress": prog,
        "weekly": weekly,
        "demo": demo,
        "disagg": disagg,
        "by_state": by_state,
        "resupp_trend": resupp_trend,
        "sources": up["sources"],
        "filename": up["filename"],
        "by_volume": _json_safe(by_volume),
        "best": _json_safe(ranked.head(10)),
        "worst": _json_safe(ranked.tail(5)),
        "zero_eac": _json_safe(zero),
        "min_vol": MIN_VOL,
    }


@app.get("/api/filters")
def get_filters(u: U):
    with pool.connection() as c:
        uid = _current_upload(c)

        def distinct(col: str, drop_unknown: bool = False) -> list[str]:
            rows = [r[col] for r in c.execute(
                f"SELECT DISTINCT {col} FROM cohort WHERE upload_id=%s "
                f"AND {col} IS NOT NULL ORDER BY {col}", (uid,)).fetchall()]
            # 'Unknown' is a data gap, not a population - it stays in 'All'
            # but is not offered as a selectable slice.
            return [v for v in rows if v != "Unknown"] if drop_unknown else rows

        def by_state(col: str) -> dict[str, str]:
            return {r[col]: r["state"] for r in c.execute(
                f"SELECT DISTINCT {col}, state FROM cohort WHERE upload_id=%s "
                f"AND {col} IS NOT NULL AND state IS NOT NULL "
                f"AND state <> 'Unknown'", (uid,)).fetchall()}

        out = {"states": distinct("state", drop_unknown=True),
               "lgas": distinct("lga"),
               "facilities": distinct("facility"),
               "age_bands": distinct("age_band", drop_unknown=True),
               "quarters": distinct("enrol_quarter"), "fys": distinct("fy"),
               "plans": distinct("treatment_plan"),
               # lets the UI cascade LGA/facility options off the chosen state
               "lga_state": by_state("lga"),
               "facility_state": by_state("facility")}

    # A scoped viewer should not even see other states in the dropdown.
    if u["scope_state"]:
        out["states"] = [u["scope_state"]]
    if u["scope_facility"]:
        out["facilities"] = [u["scope_facility"]]
    return out


@app.get("/api/health")
def health():
    return {"ok": True}


_static = Path(__file__).parent.parent / "static"
if _static.exists():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
