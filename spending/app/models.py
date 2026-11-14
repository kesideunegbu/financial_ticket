"""Request/response shapes and validation."""
import datetime as dt
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

TransactionType = Literal["expense", "income"]

CATEGORIES: dict[str, list[str]] = {
    "expense": [
        "Housing", "Food", "Transportation", "Utilities", "Health",
        "Entertainment", "Shopping", "Education", "Debt Payments",
        "Subscriptions", "Personal Care", "Gifts & Donations", "Other",
    ],
    "income": [
        "Salary", "Part-time Job", "Freelance", "Allowance",
        "Scholarship", "Investments", "Gifts", "Other",
    ],
}

# Money in: up to 2 decimal places, positive, at most 10 million.
Amount = Annotated[Decimal, Field(gt=0, le=10_000_000, max_digits=10, decimal_places=2)]


def _check_category(type_: str, category: str) -> None:
    if category not in CATEGORIES[type_]:
        allowed = ", ".join(CATEGORIES[type_])
        raise ValueError(f"'{category}' is not a valid {type_} category. Choose one of: {allowed}")


def _check_date(date: dt.date) -> None:
    if date > dt.date.today() + dt.timedelta(days=1):  # 1 day slack for time zones
        raise ValueError("Date can't be in the future")


class TransactionCreate(BaseModel):
    type: TransactionType
    amount: Amount
    category: str
    date: dt.date
    note: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_fields(self):
        _check_category(self.type, self.category)
        _check_date(self.date)
        return self


class TransactionUpdate(BaseModel):
    """Every field optional: send only what changed."""
    type: TransactionType | None = None
    amount: Amount | None = None
    category: str | None = None
    date: dt.date | None = None
    note: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_fields(self):
        if self.date is not None:
            _check_date(self.date)
        return self


class Transaction(BaseModel):
    id: int
    type: TransactionType
    amount: float
    category: str
    date: dt.date
    note: str | None
    created_at: str
