"""Internal Sprint 4.1 Purchase Receipt command schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator

DecimalString = Annotated[
    Decimal,
    PlainSerializer(lambda value: f"{value:.6f}", return_type=str, when_used="json"),
]


class ReceiptWarehouseOption(BaseModel):
    """Minimal warehouse projection used by Purchase Receiving selection."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    farm_id: uuid.UUID | None
    name: str
    code: str


class PurchaseReceiptLineCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

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
    model_config = ConfigDict(extra="forbid")

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


class PurchaseReceiptLineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    purchase_order_line_id: uuid.UUID
    inventory_item_id: uuid.UUID
    line_number: int
    quantity: DecimalString
    quantity_canonical: DecimalString
    ordered_unit: str
    canonical_unit: str
    unit_price: DecimalString
    currency_code: str
    lot_code: str
    expiry_date: date | None
    storage_location_id: uuid.UUID | None
    inventory_lot_id: uuid.UUID
    inventory_transaction_id: uuid.UUID
    created_at: datetime


class PurchaseReceiptResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    purchase_order_id: uuid.UUID
    farm_id: uuid.UUID | None
    warehouse_id: uuid.UUID
    grn: str
    supplier_delivery_reference: str | None
    received_at: datetime
    received_by_id: uuid.UUID
    notes: str | None
    created_at: datetime
    lines: list[PurchaseReceiptLineResponse]


class PurchaseReceiptPage(BaseModel):
    items: list[PurchaseReceiptResponse]
    next_cursor: str | None = None


__all__ = [
    "PurchaseReceiptCommand",
    "PurchaseReceiptLineCommand",
    "PurchaseReceiptLineResponse",
    "PurchaseReceiptPage",
    "PurchaseReceiptResponse",
]
