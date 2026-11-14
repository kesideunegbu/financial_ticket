# Spending tracker service

Python (FastAPI) service for tracking expenses and income. It runs next to the Node backend and uses the same login: the Node server forwards every `/api/spending/*` request here, and this service checks the user's session in the shared SQLite database (`backend/data/app.db`).

## Setup

```bash
cd spending
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## Running

Start both services, each in its own terminal:

```bash
cd backend  && npm run dev                            # http://localhost:3000
cd spending && uvicorn app.main:app --reload --port 8000
```

Open http://localhost:3000. The frontend calls `/api/spending/...` on the Node server, never port 8000 directly. If the Python service isn't running, those calls return `502 { "error": "Spending service is unavailable" }`.

Interactive API docs (try requests in the browser): http://localhost:8000/docs. Log in on port 3000 first, though, because the docs page doesn't send your session cookie.

Run the tests with `pytest`.

## API

All routes except `/categories` need the user to be logged in (otherwise `401`). Users only ever see their own transactions. Errors look like `{ "error": "message to show the user" }`, the same as the login API.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/spending/categories` | Allowed categories for `expense` and `income` |
| POST | `/api/spending/transactions` | Add a transaction (`201`) |
| GET | `/api/spending/transactions` | List transactions, newest first |
| GET | `/api/spending/transactions/{id}` | Get one transaction |
| PATCH | `/api/spending/transactions/{id}` | Change some fields of a transaction |
| DELETE | `/api/spending/transactions/{id}` | Delete a transaction (`204`) |
| GET | `/api/spending/summary` | Totals and per-category breakdown for a date range |
| GET | `/api/spending/summary/monthly` | Income, expenses and net per month |

### Adding a transaction

```json
POST /api/spending/transactions
{ "type": "expense", "amount": 12.50, "category": "Food", "date": "2026-11-14", "note": "lunch" }
```

- `type`: `"expense"` or `"income"`
- `amount`: positive, at most 2 decimal places
- `category`: must be one of the categories for that type (see `/categories`)
- `date`: `YYYY-MM-DD`, not in the future
- `note`: optional, up to 200 characters

The response is the saved transaction, with `id` and `created_at` added. `PATCH` takes any subset of the same fields. Send `"note": null` to clear the note.

### Listing

`GET /api/spending/transactions?type=expense&category=Food&start=2026-11-01&end=2026-11-30&limit=50&offset=0`

All query parameters are optional. The response is `{ transactions, total, limit, offset }`, where `total` is the number of matches across all pages.

### Summaries

`GET /api/spending/summary?start=2026-11-01&end=2026-11-30` (defaults to the current month so far)

```json
{
  "start": "2026-11-01", "end": "2026-11-30",
  "income": 300.0, "expenses": 45.5, "net": 254.5,
  "expenses_by_category": [{ "category": "Food", "total": 45.5, "count": 1, "percent": 100.0 }],
  "income_by_category":   [{ "category": "Part-time Job", "total": 300.0, "count": 1, "percent": 100.0 }]
}
```

`GET /api/spending/summary/monthly?months=6` returns the last 1-24 months, oldest first, including months with nothing recorded (as zeros) so charts have no gaps:

```json
{ "months": [{ "month": "2026-11", "income": 300.0, "expenses": 45.5, "net": 254.5 }] }
```

## How it fits together

- Money is stored as whole cents, so totals add up exactly. `0.10 + 0.20` is `0.30`, not `0.30000000000000004`.
- This service creates and owns the `transactions` table. The `users` and `sessions` tables belong to the Node backend and are only read here.
- Deleting a user also deletes their transactions.
