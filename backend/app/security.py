"""JWT issuing/verification and password hashing.

We call bcrypt directly rather than through passlib: passlib 1.7.4 probes the
bcrypt backend in a way that raises "password cannot be longer than 72 bytes"
against bcrypt >= 4.1. One less dependency, one less landmine.
"""
from __future__ import annotations

import datetime as dt
import logging
import os

import bcrypt
import jwt
from fastapi import HTTPException

log = logging.getLogger("ecews")

# JWT_SECRET signs every session token. A deployment that forgets to set it used
# to fall back to a hard-coded string, which means anyone holding this source
# could mint a valid admin token. It now FAILS CLOSED: the fallback exists only
# when APP_ENV explicitly says this is a development box, and APP_ENV defaults to
# production precisely so that forgetting it is the safe mistake, not the unsafe
# one.
_DEV_ENVS = ("dev", "development", "local", "test")
APP_ENV = os.getenv("APP_ENV", "production").strip().lower()
SECRET = os.getenv("JWT_SECRET", "").strip()

if not SECRET:
    if APP_ENV in _DEV_ENVS:
        SECRET = "dev-secret-change-me"
        log.warning("JWT_SECRET unset - using the development fallback because "
                    "APP_ENV=%s. Never do this in a hosted environment.", APP_ENV)
    else:
        raise RuntimeError(
            "JWT_SECRET is not set. Generate one with "
            "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"` "
            "and set it in the environment. (For local development set "
            "APP_ENV=development to allow an insecure fallback.)")

ALGO = "HS256"
TTL_HOURS = int(os.getenv("JWT_TTL_HOURS", "12"))


def create_token(user_id: int) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    return jwt.encode(
        {"sub": str(user_id), "iat": now, "exp": now + dt.timedelta(hours=TTL_HOURS)},
        SECRET, algorithm=ALGO)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired, please sign in again") from None
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token") from None


# bcrypt truncates at 72 bytes; hash long inputs deterministically first so a
# long passphrase can never silently collide with its own prefix.
def _prep(password: str) -> bytes:
    raw = password.encode()
    if len(raw) > 72:
        import hashlib
        raw = hashlib.sha256(raw).hexdigest().encode()
    return raw


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prep(password), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prep(password), hashed.encode())
    except (ValueError, TypeError):
        return False
