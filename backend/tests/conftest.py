"""
Fixtures for the API integration tests.

These run against a REAL Postgres, not a mock. The things worth testing here -
row-level scoping, the lockout counter, cascade deletes, the append-only audit
trail - are all database behaviour, and a mock would only ever confirm that the
mock works.

The environment is configured before `app.main` is imported, because
`security.py` reads JWT_SECRET at module scope and would otherwise refuse to
load under the production default.

Where the database lives:
  local  - the compose Postgres is not published to the host, so run these
           inside the api container:  docker compose exec api pytest
  CI     - a postgres service container on localhost; the workflow sets
           TEST_DATABASE_URL explicitly.
"""
from __future__ import annotations

import os

import psycopg
import pytest

def _default_dsn() -> str:
    """
    Same server and credentials as the app, different database.

    Derived from DATABASE_URL rather than hard-coded, because the compose stack
    takes its password from .env - assuming the default silently breaks the
    suite on any machine where that has been set.
    """
    base = os.getenv("DATABASE_URL")
    if base:
        return base.rsplit("/", 1)[0] + "/ecews_test"
    return "postgresql://ecews:ecews@db:5432/ecews_test"


TEST_DSN = os.getenv("TEST_DATABASE_URL") or _default_dsn()

# Must precede the `app.main` import below.
os.environ["DATABASE_URL"] = TEST_DSN
os.environ.setdefault("APP_ENV", "development")
os.environ.setdefault("JWT_SECRET", "test-only-secret-never-deployed")
os.environ.setdefault("ADMIN_PASSWORD", "admin-test-pw")
os.environ.setdefault("VIEWER_PASSWORD", "viewer-test-pw")

ADMIN = ("admin@ecews.org", "admin-test-pw")
VIEWER = ("viewer@ecews.org", "viewer-test-pw")


def _ensure_database() -> None:
    """CREATE DATABASE has no IF NOT EXISTS, so check first."""
    target = TEST_DSN.rsplit("/", 1)[-1]
    admin_dsn = TEST_DSN.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_dsn, autocommit=True) as c:
        exists = c.execute("SELECT 1 FROM pg_database WHERE datname=%s",
                           (target,)).fetchone()
        if not exists:
            c.execute(f'CREATE DATABASE "{target}"')


_ensure_database()

from app.main import app  # noqa: E402  (import must follow the env setup)
from starlette.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client():
    """
    One client for the session; entering it runs lifespan, so the schema is
    applied and the seed accounts created.

    The passwords are then forced to the known test values. This is not
    belt-and-braces - `_seed()` only sets a password when it CREATES the
    account, so on any run after the first (or when the container already
    exports ADMIN_PASSWORD, which compose does) the seeded password is
    whatever it was originally and every admin test 401s. Overwriting here
    makes the suite idempotent regardless of what the database already held.
    """
    with TestClient(app) as c:
        from app.main import pool
        from app.security import hash_password
        with pool.connection() as conn:
            for email, pw in (ADMIN, VIEWER):
                conn.execute(
                    "UPDATE users SET password_hash=%s, is_active=TRUE "
                    "WHERE email=%s", (hash_password(pw), email))
        yield c


@pytest.fixture(autouse=True)
def reset(client):
    """
    Clean slate per test.

    audit_log MUST be truncated: the lockout counter is derived from it, so a
    test that fails a login five times would otherwise lock the account for
    every test that follows.

    The two seeded accounts are kept - they are created by lifespan, which only
    runs once per session.
    """
    from app.main import pool
    with pool.connection() as c:
        c.execute("TRUNCATE audit_log")
        c.execute("DELETE FROM uploads")          # cohort + dq_findings cascade
        c.execute("DELETE FROM feedback")
        c.execute("DELETE FROM users WHERE email NOT IN (%s, %s)",
                  (ADMIN[0], VIEWER[0]))
    yield


def token(client, creds) -> str:
    r = client.post("/api/login", json={"email": creds[0], "password": creds[1]})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def hdr(client, creds) -> dict:
    return {"Authorization": f"Bearer {token(client, creds)}"}


@pytest.fixture
def admin_h(client):
    return hdr(client, ADMIN)


@pytest.fixture
def viewer_h(client):
    return hdr(client, VIEWER)


@pytest.fixture
def cohort(client):
    """
    A current snapshot with five episodes: three in Delta, two in Osun.

    Inserted directly rather than through an upload, so the scoping tests are
    testing scoping and not the ingest pipeline. The upload path has its own
    test.
    """
    from app.main import pool
    # art_status is 'Active' on every seeded row. The CSV export carries only
    # active clients - a worklist of people who have died or transferred out
    # wastes the team's time - so a NULL status here silently emptied every
    # export assertion below.
    rows = [("Delta", "Warri", "Clinic A"), ("Delta", "Warri", "Clinic A"),
            ("Delta", "Sapele", "Clinic B"), ("Osun", "Ife", "Clinic C"),
            ("Osun", "Ife", "Clinic C")]
    with pool.connection() as c:
        uid = c.execute(
            "INSERT INTO uploads (filename,as_of,status,is_current) "
            "VALUES ('test.xlsx','2026-07-11','ready',TRUE) RETURNING id"
        ).fetchone()["id"]
        for i, (st, lga, fac) in enumerate(rows):
            c.execute(
                "INSERT INTO cohort (upload_id,sn,episode,state,lga,facility,"
                "sex,age,age_band,art_status,idx_vl,idx_date,fy_quarter,"
                "enrol_quarter,fy,eac1,post_result,resuppressed) VALUES "
                "(%s,%s,%s,%s,%s,%s,'Female',30,'25-34','Active',5000,"
                "'2026-01-15','FY26Q2','FY26Q2','FY26',TRUE,FALSE,FALSE)",
                (uid, f"0.10000000000{i}", f"0.10000000000{i}|2026-01-15",
                 st, lga, fac))
    return uid
