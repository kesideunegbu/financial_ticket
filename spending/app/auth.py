"""Login check that matches the Node backend (backend/src/auth/sessions.js).

The browser sends the `sid` cookie. We SHA-256 it and look it up in the shared
`sessions` table, exactly like Node does, so one login works for both services.
"""
import hashlib
import sqlite3
import time
from dataclasses import dataclass

from fastapi import Cookie, Depends, HTTPException

from .db import get_db

COOKIE_NAME = "sid"


@dataclass
class User:
    id: int
    email: str
    name: str | None


def current_user(
    sid: str | None = Cookie(default=None, alias=COOKIE_NAME),
    db: sqlite3.Connection = Depends(get_db),
) -> User:
    if not sid:
        raise HTTPException(status_code=401, detail="Not logged in")
    token_hash = hashlib.sha256(sid.encode()).hexdigest()
    row = db.execute(
        """
        SELECT u.id, u.email, u.name, s.expires_at
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        """,
        (token_hash,),
    ).fetchone()
    # expires_at is stored by Node in milliseconds since the epoch
    if row is None or row["expires_at"] < time.time() * 1000:
        raise HTTPException(status_code=401, detail="Not logged in")
    return User(id=row["id"], email=row["email"], name=row["name"])
