"""Release 6.0.3 Purchase Order REST API schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)

from app.models.purchase_order import PurchaseOrderStatus

DecimalString = Annotated[
    Decimal,
    PlainSerializer(lambda value: f"{value:.6f}", return_type=str, when_used="json"),
]


def _require_decimal_string(value: Any) -> Any:
    if not isinstance(value, str):
        raise ValueError("Business numeric values must be supplied as decimal strings.")
    return value


class DeliveryAddress(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line1: str | None = Field(default=None, max_length=200)
    line2: str | None = Field(default=None, max_length=200)
    city: str | None = Field(default=None, max_length=200)
    region: str | None = Field(default=None, max_length=200)
    postal_code: str | None = Field(default=None, max_length=200)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)


class PurchaseOrderLineInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inventory_item_id: uuid.UUID
    ordered_quantity: Decimal
    ordered_unit: str = Field(min_length=1, max_length=32)
    unit_price: Decimal
    description: str | None = Field(default=None, max_length=500)
    line_note: str | None = Field(default=None, max_length=1000)

    _quantity_as_string = field_validator("ordered_quantity", mode="before")(
        _require_decimal_string
    )
    _price_as_string = field_validator("unit_price", mode="before")(_require_decimal_string)


class PurchaseOrderUpdateLineInput(PurchaseOrderLineInput):
    id: uuid.UUID | None = None


class PurchaseOrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    business_partner_id: uuid.UUID
    currency_code: str = Field(min_length=3, max_length=3)
    order_date: date
    expected_delivery_date: date | None = None
    delivery_address: DeliveryAddress | None = None
    supplier_reference: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=4000)
    farm_id: uuid.UUID | None = None
    lines: list[PurchaseOrderLineInput] = Field(default_factory=list)


class PurchaseOrderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    business_partner_id: uuid.UUID | None = None
    currency_code: str | None = Field(default=None, min_length=3, max_length=3)
    order_date: date | None = None
    expected_delivery_date: date | None = None
    delivery_address: DeliveryAddress | None = None
    supplier_reference: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=4000)
    farm_id: uuid.UUID | None = None
    lines: list[PurchaseOrderUpdateLineInput] | None = None

    @model_validator(mode="after")
    def _non_nullable_fields_cannot_be_cleared(self) -> PurchaseOrderUpdate:
        for field in ("business_partner_id", "currency_code", "order_date", "lines"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        return self


class LifecycleReasonPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def _non_blank_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason must not be blank.")
        return value


class ApprovalPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def _strip_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class PurchaseOrderLineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    line_number: int
    inventory_item_id: uuid.UUID
    item_code: str
    item_name: str
    item_sku: str | None
    description: str
    line_note: str | None
    ordered_quantity: DecimalString
    ordered_unit: str
    canonical_unit: str
    ordered_quantity_canonical: DecimalString
    received_quantity: DecimalString
    received_quantity_canonical: DecimalString
    unit_price: DecimalString
    extended_amount: DecimalString
    created_at: datetime
    updated_at: datetime


class PurchaseOrderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    farm_id: uuid.UUID | None
    business_partner_id: uuid.UUID
    po_number: str
    supplier_reference: str | None
    status: PurchaseOrderStatus
    currency_code: str
    order_date: date
    expected_delivery_date: date | None
    delivery_address: DeliveryAddress | None
    notes: str | None
    supplier_code: str
    supplier_legal_name: str
    supplier_trading_name: str | None
    version: int
    created_by_id: uuid.UUID
    submitted_by_id: uuid.UUID | None
    submitted_at: datetime | None
    approved_by_id: uuid.UUID | None
    approved_at: datetime | None
    rejected_by_id: uuid.UUID | None
    rejected_at: datetime | None
    cancelled_by_id: uuid.UUID | None
    cancelled_at: datetime | None
    created_at: datetime
    updated_at: datetime
    subtotal: DecimalString
    lines: list[PurchaseOrderLineResponse]


class PurchaseOrderPage(BaseModel):
    items: list[PurchaseOrderResponse]
    next_cursor: str | None = None


class PurchaseOrderTransitionResponse(BaseModel):
    id: uuid.UUID
    purchase_order_id: uuid.UUID
    actor_id: uuid.UUID
    from_status: PurchaseOrderStatus | None
    to_status: PurchaseOrderStatus
    operation: str
    reason: str | None
    occurred_at: datetime


class PurchaseOrderTransitionPage(BaseModel):
    items: list[PurchaseOrderTransitionResponse]
    next_cursor: str | None = None
