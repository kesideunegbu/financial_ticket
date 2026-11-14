"""Spending tracker endpoints. Every query is filtered by the logged-in user's id."""
import datetime as dt
import sqlite3
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from .auth import User, current_user
from .db import get_db
from .models import CATEGORIES, Transaction, TransactionCreate, TransactionType, TransactionUpdate, _check_category

router = APIRouter(prefix="/api/spending")


def to_cents(amount: Decimal) -> int:
    return int(amount * 100)


def money(cents: int | None) -> float:
    return round((cents or 0) / 100, 2)


def row_to_transaction(row: sqlite3.Row) -> Transaction:
    return Transaction(
        id=row["id"], type=row["type"], amount=money(row["amount_cents"]),
        category=row["category"], date=row["date"], note=row["note"], created_at=row["created_at"],
    )


def get_owned(db: sqlite3.Connection, user: User, transaction_id: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM transactions WHERE id = ? AND user_id = ?", (transaction_id, user.id)
    ).fetchone()
    if row is None:  # also covers "belongs to someone else", so ids can't be probed
        raise HTTPException(status_code=404, detail="Transaction not found")
    return row


@router.get("/categories")
def list_categories():
    return CATEGORIES


@router.post("/transactions", status_code=201, response_model=Transaction)
def create_transaction(body: TransactionCreate, user: User = Depends(current_user), db=Depends(get_db)):
    cur = db.execute(
        "INSERT INTO transactions (user_id, type, amount_cents, category, date, note) VALUES (?, ?, ?, ?, ?, ?)",
        (user.id, body.type, to_cents(body.amount), body.category, body.date.isoformat(), body.note),
    )
    return row_to_transaction(get_owned(db, user, cur.lastrowid))


@router.get("/transactions")
def list_transactions(
    type: TransactionType | None = None,
    category: str | None = None,
    start: dt.date | None = Query(default=None, description="Earliest date, inclusive"),
    end: dt.date | None = Query(default=None, description="Latest date, inclusive"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(current_user),
    db=Depends(get_db),
):
    where, params = ["user_id = ?"], [user.id]
    if type:
        where.append("type = ?"); params.append(type)
    if category:
        where.append("category = ?"); params.append(category)
    if start:
        where.append("date >= ?"); params.append(start.isoformat())
    if end:
        where.append("date <= ?"); params.append(end.isoformat())
    clause = " AND ".join(where)

    total = db.execute(f"SELECT COUNT(*) FROM transactions WHERE {clause}", params).fetchone()[0]
    rows = db.execute(
        f"SELECT * FROM transactions WHERE {clause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return {"transactions": [row_to_transaction(r) for r in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/transactions/{transaction_id}", response_model=Transaction)
def get_transaction(transaction_id: int, user: User = Depends(current_user), db=Depends(get_db)):
    return row_to_transaction(get_owned(db, user, transaction_id))


@router.patch("/transactions/{transaction_id}", response_model=Transaction)
def update_transaction(
    transaction_id: int, body: TransactionUpdate, user: User = Depends(current_user), db=Depends(get_db)
):
    existing = get_owned(db, user, transaction_id)
    changes = body.model_dump(exclude_unset=True)

    # Re-check the category against the (possibly new) type, e.g. switching expense -> income.
    new_type = changes.get("type") or existing["type"]
    new_category = changes.get("category") or existing["category"]
    try:
        _check_category(new_type, new_category)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    columns = {
        "type": new_type,
        "category": new_category,
        "amount_cents": to_cents(changes["amount"]) if changes.get("amount") is not None else existing["amount_cents"],
        "date": changes["date"].isoformat() if changes.get("date") else existing["date"],
        "note": changes["note"] if "note" in changes else existing["note"],
    }
    db.execute(
        "UPDATE transactions SET type = ?, category = ?, amount_cents = ?, date = ?, note = ? WHERE id = ? AND user_id = ?",
        (*columns.values(), transaction_id, user.id),
    )
    return row_to_transaction(get_owned(db, user, transaction_id))


@router.delete("/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: int, user: User = Depends(current_user), db=Depends(get_db)):
    get_owned(db, user, transaction_id)
    db.execute("DELETE FROM transactions WHERE id = ? AND user_id = ?", (transaction_id, user.id))
    return Response(status_code=204)


@router.get("/summary")
def summary(
    start: dt.date | None = Query(default=None, description="Defaults to the 1st of this month"),
    end: dt.date | None = Query(default=None, description="Defaults to today"),
    user: User = Depends(current_user),
    db=Depends(get_db),
):
    """Totals for a date range, plus a per-category breakdown (good for pie charts)."""
    today = dt.date.today()
    start = start or today.replace(day=1)
    end = end or today
    if start > end:
        raise HTTPException(status_code=422, detail="start must be on or before end")

    rows = db.execute(
        """
        SELECT type, category, SUM(amount_cents) AS cents, COUNT(*) AS n
        FROM transactions
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY type, category
        ORDER BY cents DESC
        """,
        (user.id, start.isoformat(), end.isoformat()),
    ).fetchall()

    totals = {"expense": 0, "income": 0}
    for r in rows:
        totals[r["type"]] += r["cents"]

    def breakdown(type_: str):
        return [
            {
                "category": r["category"],
                "total": money(r["cents"]),
                "count": r["n"],
                "percent": round(100 * r["cents"] / totals[type_], 1),
            }
            for r in rows if r["type"] == type_
        ]

    return {
        "start": start, "end": end,
        "income": money(totals["income"]),
        "expenses": money(totals["expense"]),
        "net": money(totals["income"] - totals["expense"]),
        "expenses_by_category": breakdown("expense"),
        "income_by_category": breakdown("income"),
    }


@router.get("/summary/monthly")
def monthly_summary(
    months: int = Query(default=6, ge=1, le=24),
    user: User = Depends(current_user),
    db=Depends(get_db),
):
    """Income, expenses and net for each of the last N months (good for bar/line charts).
    Months with no transactions are included with zeros so charts have no gaps."""
    today = dt.date.today()
    keys = []
    y, m = today.year, today.month
    for _ in range(months):
        keys.append(f"{y:04d}-{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    keys.reverse()

    rows = db.execute(
        """
        SELECT substr(date, 1, 7) AS month, type, SUM(amount_cents) AS cents
        FROM transactions
        WHERE user_id = ? AND date >= ?
        GROUP BY month, type
        """,
        (user.id, f"{keys[0]}-01"),
    ).fetchall()

    data = {k: {"income": 0, "expense": 0} for k in keys}
    for r in rows:
        if r["month"] in data:
            data[r["month"]][r["type"]] = r["cents"]

    return {
        "months": [
            {"month": k, "income": money(v["income"]), "expenses": money(v["expense"]),
             "net": money(v["income"] - v["expense"])}
            for k, v in data.items()
        ]
    }
