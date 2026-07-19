"""JWT issuing/verification and password hashing.

We call bcrypt directly rather than through passlib: passlib 1.7.4 probes the
bcrypt backend in a way that raises "password cannot be longer than 72 bytes"
against bcrypt >= 4.1. One less dependency, one less landmine.
"""
from __future__ import annotations

import datetime as dt
import os

import bcrypt
import jwt
from fastapi import HTTPException

SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
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
