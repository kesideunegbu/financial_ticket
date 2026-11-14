import datetime as dt
import hashlib
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

TODAY = dt.date.today()
THIS_MONTH = TODAY.replace(day=1)


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DB_FILE", str(db_file))

    # Same users/sessions schema the Node backend creates (backend/src/db.js)
    conn = sqlite3.connect(db_file)
    conn.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
                            name TEXT, password_hash TEXT NOT NULL,
                            created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL
                               REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
        """
    )
    future = int(time.time() * 1000) + 3_600_000
    past = int(time.time() * 1000) - 1
    for uid, email in [(1, "ada@example.com"), (2, "bob@example.com")]:
        conn.execute("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')", (uid, email))
        conn.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                     (hashlib.sha256(f"token-{uid}".encode()).hexdigest(), uid, future))
    conn.execute("INSERT INTO sessions VALUES (?, 1, ?)", (hashlib.sha256(b"expired").hexdigest(), past))
    conn.commit()
    conn.close()

    from app.main import app
    with TestClient(app) as c:
        yield c


def as_user(client, uid):
    client.cookies.set("sid", f"token-{uid}")
    return client


def add(client, **overrides):
    body = {"type": "expense", "amount": 12.5, "category": "Food", "date": TODAY.isoformat()} | overrides
    res = client.post("/api/spending/transactions", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def test_requires_login(client):
    assert client.get("/api/spending/transactions").status_code == 401
    client.cookies.set("sid", "expired")
    assert client.get("/api/spending/transactions").status_code == 401
    client.cookies.set("sid", "made-up")
    res = client.get("/api/spending/transactions")
    assert res.status_code == 401
    assert res.json() == {"error": "Not logged in"}


def test_create_list_update_delete(client):
    as_user(client, 1)
    t = add(client, amount="19.99", note="groceries")
    assert t["amount"] == 19.99 and t["note"] == "groceries"

    listed = client.get("/api/spending/transactions").json()
    assert listed["total"] == 1 and listed["transactions"][0]["id"] == t["id"]

    res = client.patch(f"/api/spending/transactions/{t['id']}", json={"amount": 25, "note": None})
    assert res.status_code == 200
    assert res.json()["amount"] == 25.0 and res.json()["note"] is None
    assert res.json()["category"] == "Food"  # unchanged fields are kept

    assert client.delete(f"/api/spending/transactions/{t['id']}").status_code == 204
    assert client.get(f"/api/spending/transactions/{t['id']}").status_code == 404


def test_users_cannot_see_or_touch_each_others_data(client):
    t = add(as_user(client, 1))
    as_user(client, 2)
    assert client.get("/api/spending/transactions").json()["total"] == 0
    assert client.get(f"/api/spending/transactions/{t['id']}").status_code == 404
    assert client.patch(f"/api/spending/transactions/{t['id']}", json={"amount": 1}).status_code == 404
    assert client.delete(f"/api/spending/transactions/{t['id']}").status_code == 404


@pytest.mark.parametrize("body", [
    {"amount": 0},
    {"amount": -5},
    {"amount": 1.234},                                # more than 2 decimal places
    {"category": "Salary"},                           # income category on an expense
    {"category": "Nonsense"},
    {"type": "gift"},
    {"date": (TODAY + dt.timedelta(days=10)).isoformat()},
    {"date": "not-a-date"},
    {"note": "x" * 201},
])
def test_rejects_bad_input(client, body):
    as_user(client, 1)
    base = {"type": "expense", "amount": 10, "category": "Food", "date": TODAY.isoformat()}
    res = client.post("/api/spending/transactions", json=base | body)
    assert res.status_code == 422
    assert "error" in res.json()


def test_update_rechecks_category_against_type(client):
    t = add(as_user(client, 1), category="Food")
    res = client.patch(f"/api/spending/transactions/{t['id']}", json={"type": "income"})
    assert res.status_code == 422  # "Food" isn't an income category
    ok = client.patch(f"/api/spending/transactions/{t['id']}", json={"type": "income", "category": "Salary"})
    assert ok.status_code == 200


def test_list_filters(client):
    as_user(client, 1)
    add(client, category="Food")
    add(client, category="Housing", amount=800)
    add(client, type="income", category="Salary", amount=2000)
    add(client, date="2020-01-15")

    get = lambda **q: client.get("/api/spending/transactions", params=q).json()["total"]
    assert get(type="income") == 1
    assert get(category="Food") == 2
    assert get(start=THIS_MONTH.isoformat()) == 3
    assert get(end="2020-12-31") == 1
    page = client.get("/api/spending/transactions", params={"limit": 2}).json()
    assert len(page["transactions"]) == 2 and page["total"] == 4


def test_summary(client):
    as_user(client, 1)
    add(client, category="Food", amount="30.10")
    add(client, category="Food", amount="20.20")
    add(client, category="Housing", amount=150)
    add(client, type="income", category="Salary", amount=1000)
    add(client, date="2020-01-15", amount=999)  # outside the default range (this month)

    s = client.get("/api/spending/summary").json()
    assert s["expenses"] == 200.3        # exact: stored as cents, no float drift
    assert s["income"] == 1000.0
    assert s["net"] == 799.7
    assert s["expenses_by_category"][0] == {"category": "Housing", "total": 150.0, "count": 1, "percent": 74.9}
    assert s["expenses_by_category"][1]["category"] == "Food"

    assert client.get("/api/spending/summary", params={"start": "2021-01-01", "end": "2020-01-01"}).status_code == 422


def test_monthly_summary_fills_empty_months(client):
    as_user(client, 1)
    add(client, amount=40)
    add(client, type="income", category="Allowance", amount=100)
    months = client.get("/api/spending/summary/monthly", params={"months": 3}).json()["months"]
    assert len(months) == 3
    assert months[-1] == {"month": TODAY.strftime("%Y-%m"), "income": 100.0, "expenses": 40.0, "net": 60.0}
    assert months[0]["income"] == 0 and months[0]["expenses"] == 0


def test_categories_are_public(client):
    cats = client.get("/api/spending/categories").json()
    assert "Food" in cats["expense"] and "Salary" in cats["income"]


def test_connection_works_across_threads(tmp_path, monkeypatch):
    """FastAPI can run a request's login check and endpoint on different threads.
    Regression: summary requests failed with 'SQLite objects created in a thread
    can only be used in that same thread'."""
    import threading
    from app.db import connect

    monkeypatch.setenv("DB_FILE", str(tmp_path / "threads.db"))
    conn = connect()
    errors = []

    def use_connection():
        try:
            conn.execute("SELECT 1").fetchone()
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=use_connection)
    t.start()
    t.join()
    conn.close()
    assert errors == []
