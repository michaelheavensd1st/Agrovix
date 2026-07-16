"""Pydantic schemas for Sprint 4 inventory endpoints."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.inventory import (
    InventoryItemCategory,
    InventoryTransactionType,
    StockUnit,
    WarehouseStatus,
)


# --------------------------------------------------------------------- #
# Warehouse
# --------------------------------------------------------------------- #
class WarehouseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    code: str = Field(min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=1000)
    farm_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    metadata_json: dict | None = None


class WarehouseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    address: str | None = Field(default=None, max_length=1000)
    status: WarehouseStatus | None = None
    metadata_json: dict | None = None


class WarehousePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    organization_id: uuid.UUID
    farm_id: uuid.UUID | None
    site_id: uuid.UUID | None
    name: str
    code: str
    description: str | None
    address: str | None
    status: WarehouseStatus
    metadata_json: dict | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------- #
# Storage location
# --------------------------------------------------------------------- #
class StorageLocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    code: str = Field(min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=1000)


class StorageLocationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    warehouse_id: uuid.UUID
    name: str
    code: str
    description: str | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------- #
# Inventory item
# --------------------------------------------------------------------- #
class InventoryItemCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    category: InventoryItemCategory
    canonical_unit: StockUnit
    sku: str | None = Field(default=None, max_length=128)
    metadata_json: dict | None = None


class InventoryItemUpdate(BaseModel):
    """Cosmetic updates only — ``canonical_unit`` is immutable once
    posted (see service layer for enforcement)."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    is_active: bool | None = None
    sku: str | None = Field(default=None, max_length=128)
    metadata_json: dict | None = None


class InventoryItemPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    organization_id: uuid.UUID
    code: str
    name: str
    description: str | None
    category: InventoryItemCategory
    canonical_unit: StockUnit
    sku: str | None
    is_active: bool
    metadata_json: dict | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------- #
# Inventory lot
# --------------------------------------------------------------------- #
class InventoryLotPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    item_id: uuid.UUID
    warehouse_id: uuid.UUID
    storage_location_id: uuid.UUID | None
    lot_code: str
    expiry_date: date | None
    received_at: datetime | None
    unit_cost_amount: Decimal | None
    unit_cost_currency: str | None
    metadata_json: dict | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class InventoryLotWithBalance(InventoryLotPublic):
    """Read model that includes a projected balance.

    The balance is computed live from the ledger. Two calls a
    millisecond apart may return different values under concurrent
    writes — this is expected. Use projections for reporting, the
    lock-scoped service methods for enforcement.
    """

    balance: Decimal
    balance_unit: StockUnit


# --------------------------------------------------------------------- #
# Transactions
# --------------------------------------------------------------------- #
class ReceiptRequest(BaseModel):
    """POST ``/inventory/warehouses/{wh}/lots:receive``.

    Creates the lot if it doesn't exist at ``(warehouse, item, lot_code)``
    and posts a RECEIPT transaction. Idempotent by ``Idempotency-Key``.
    """

    item_id: uuid.UUID
    lot_code: str = Field(min_length=1, max_length=128)
    quantity: Decimal = Field(gt=0)
    unit: StockUnit
    storage_location_id: uuid.UUID | None = None
    expiry_date: date | None = None
    unit_cost_amount: Decimal | None = Field(default=None, ge=0)
    unit_cost_currency: str | None = Field(default=None, min_length=3, max_length=3)
    reason: str | None = Field(default=None, max_length=500)
    metadata_json: dict | None = None


class IssueRequest(BaseModel):
    lot_id: uuid.UUID
    quantity: Decimal = Field(gt=0)
    unit: StockUnit
    reason: str | None = Field(default=None, max_length=500)
    metadata_json: dict | None = None


class TransferRequest(BaseModel):
    lot_id: uuid.UUID
    destination_warehouse_id: uuid.UUID
    destination_storage_location_id: uuid.UUID | None = None
    quantity: Decimal = Field(gt=0)
    unit: StockUnit
    reason: str | None = Field(default=None, max_length=500)
    metadata_json: dict | None = None


class AdjustmentRequest(BaseModel):
    lot_id: uuid.UUID
    quantity: Decimal = Field(gt=0)
    unit: StockUnit
    direction: str = Field(pattern="^(increase|decrease)$")
    reason: str = Field(min_length=1, max_length=500)  # mandatory
    metadata_json: dict | None = None


class ReversalRequest(BaseModel):
    reverses_transaction_id: uuid.UUID
    reason: str = Field(min_length=1, max_length=500)
    metadata_json: dict | None = None


class InventoryTransactionPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    organization_id: uuid.UUID
    farm_id: uuid.UUID | None
    warehouse_id: uuid.UUID
    item_id: uuid.UUID
    lot_id: uuid.UUID
    transaction_type: InventoryTransactionType
    quantity: Decimal
    unit: StockUnit
    performed_by_id: uuid.UUID
    performed_at: datetime
    reason: str | None
    reference_type: str | None
    reference_id: uuid.UUID | None
    reverses_transaction_id: uuid.UUID | None
    idempotency_key: str | None
    metadata_json: dict | None
    created_at: datetime


class InventoryTransactionPage(BaseModel):
    items: list[InventoryTransactionPublic]
    next_cursor: str | None
    limit: int
