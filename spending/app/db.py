"""SQLite access. Shares the same database file as the Node login backend.

The Node backend owns the `users` and `sessions` tables; this service only reads
them to check who is logged in. This service owns the `transactions` table.
"""
import os
import sqlite3
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parents[2] / "backend" / "data" / "app.db"


def db_path() -> str:
    return os.environ.get("DB_FILE", str(DEFAULT_DB))


def connect() -> sqlite3.Connection:
    # FastAPI may run a request's dependencies (e.g. the login check) and its endpoint on
    # different worker threads. Each request gets its own connection and those steps run
    # one after another, never at the same time, so sharing it across threads is safe.
    conn = sqlite3.connect(db_path(), timeout=5, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def get_db():
    """FastAPI dependency: one connection per request, committed on success."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    path = db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")  # lets Node and Python read/write side by side
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type         TEXT NOT NULL CHECK (type IN ('expense', 'income')),
                amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                category     TEXT NOT NULL,
                date         TEXT NOT NULL,  -- YYYY-MM-DD
                note         TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_transactions_user_date
                ON transactions (user_id, date);
            """
        )
