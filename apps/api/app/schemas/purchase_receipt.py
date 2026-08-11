"""Internal Sprint 4.1 Purchase Receipt command schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator


class PurchaseReceiptLineCommand(BaseModel):
    purchase_order_line_id: uuid.UUID
    lot_code: str = Field(min_length=1, max_length=128)
    quantity: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    storage_location_id: uuid.UUID | None = None
    expiry_date: date | None = None

    @field_validator("lot_code", mode="before")
    @classmethod
    def normalize_lot_code(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("quantity", mode="before")
    @classmethod
    def reject_float(cls, value: object) -> object:
        if isinstance(value, float):
            raise ValueError("quantity must not be supplied as binary floating point")
        return value


class PurchaseReceiptCommand(BaseModel):
    warehouse_id: uuid.UUID
    supplier_delivery_reference: str | None = Field(default=None, max_length=120)
    received_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=4000)
    lines: list[PurchaseReceiptLineCommand] = Field(min_length=1)

    @field_validator("received_at")
    @classmethod
    def validate_received_at(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("received_at must include a timezone")
        if not 2000 <= value.year <= 9999:
            raise ValueError("received_at year must be between 2000 and 9999")
        return value


__all__ = ["PurchaseReceiptCommand", "PurchaseReceiptLineCommand"]
