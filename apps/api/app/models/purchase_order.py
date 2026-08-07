"""Release 6.0.3 — Purchase Order aggregate.

Frozen contract: ``docs/release_6.0/purchase-orders.md``. Every shape
below maps 1:1 to §4 / §5 / §10 of that document. Any semantic change
must return to architecture review before code changes.

The aggregate is four tables plus one status enum:

* ``purchase_order_sequences`` — org/year monotonic PO-number source.
* ``purchase_orders`` — aggregate-root header (§4.1 / §10.3).
* ``purchase_order_lines`` — draft lines with frozen snapshots (§4.2 / §10.4).
* ``purchase_order_transitions`` — append-only lifecycle history (§8.2 / §10.5).

Received accumulators (``received_quantity`` / ``received_quantity_canonical``)
exist now with DB check constraints so 6.0.4 can post receipts under a lock
WITHOUT a competing PO migration — Release 6.0.3 never writes them.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy import (
    Enum as SQLEnum,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

_PO_JSONB = JSONB().with_variant(JSON(), "sqlite")

if TYPE_CHECKING:
    from app.models.business_partner import BusinessPartner
    from app.models.farm import Farm
    from app.models.inventory import InventoryItem
    from app.models.organization import Organization
    from app.models.user import User


# --------------------------------------------------------------------- #
# Frozen status enum — §5. Eight values assigned to migration 0012 by the
# cross-release database contract. 6.0.3 can only ENTER the first four
# non-reserved states; the receipt-reserved states exist for 6.0.4.
# --------------------------------------------------------------------- #
class PurchaseOrderStatus(enum.StrEnum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"  # reserved for 6.0.4
    RECEIVED = "RECEIVED"  # reserved for 6.0.4
    CANCELLED = "CANCELLED"
    CANCELLED_WITH_RECEIPTS = "CANCELLED_WITH_RECEIPTS"  # reserved for 6.0.4


# States a Release 6.0.3 operation may ever place a PO in.
REACHABLE_STATUSES: frozenset[PurchaseOrderStatus] = frozenset(
    {
        PurchaseOrderStatus.DRAFT,
        PurchaseOrderStatus.SUBMITTED,
        PurchaseOrderStatus.APPROVED,
        PurchaseOrderStatus.REJECTED,
        PurchaseOrderStatus.CANCELLED,
    }
)

# Non-terminal statuses that pin a supplier capability in use (§2). The
# fourth (PARTIALLY_RECEIVED) is unreachable in 6.0.3 but included so the
# future 6.0.4 invariant is already correct.
NON_TERMINAL_STATUSES: frozenset[PurchaseOrderStatus] = frozenset(
    {
        PurchaseOrderStatus.DRAFT,
        PurchaseOrderStatus.SUBMITTED,
        PurchaseOrderStatus.APPROVED,
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
    }
)

# One shared Enum type object reused by every status column so the
# Postgres type is created exactly once by ``metadata.create_all``.
PO_STATUS_ENUM = SQLEnum(
    PurchaseOrderStatus,
    name="purchase_order_status",
    native_enum=True,
    values_callable=lambda e: [m.value for m in e],
)


# --------------------------------------------------------------------- #
# purchase_order_sequences — §10.2
# --------------------------------------------------------------------- #
class PurchaseOrderSequence(Base):
    """Org/year monotonic allocator. Composite PK ``(organization_id, year)``.

    Allocation locks/upserts exactly one row and formats
    ``PO-{year}-{last_value:06d}``. Gaps from rollback are acceptable;
    reuse is forbidden (guarded by the unique PO number constraint).
    """

    __tablename__ = "purchase_order_sequences"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_value: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("year BETWEEN 2000 AND 9999", name="ck_po_sequence_year_range"),
        CheckConstraint("last_value >= 0", name="ck_po_sequence_last_value_non_negative"),
    )


# --------------------------------------------------------------------- #
# purchase_orders — §4.1 / §10.3
# --------------------------------------------------------------------- #
class PurchaseOrder(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "purchase_orders"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
    )
    farm_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("farms.id", ondelete="RESTRICT"),
        nullable=True,
    )
    business_partner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("business_partners.id", ondelete="RESTRICT"),
        nullable=False,
    )
    po_number: Mapped[str] = mapped_column(String(32), nullable=False)
    supplier_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[PurchaseOrderStatus] = mapped_column(
        PO_STATUS_ENUM,
        nullable=False,
        default=PurchaseOrderStatus.DRAFT,
        server_default=PurchaseOrderStatus.DRAFT.value,
    )
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    expected_delivery_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    delivery_address: Mapped[dict | None] = mapped_column(_PO_JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(String(4000), nullable=True)

    # Supplier snapshots — refreshed from the partner while a draft,
    # frozen on submit. legal_name/code required; trading_name optional.
    supplier_code: Mapped[str] = mapped_column(String(64), nullable=False)
    supplier_legal_name: Mapped[str] = mapped_column(String(255), nullable=False)
    supplier_trading_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")

    # Lifecycle attribution (§10.3). Withdraw/revise attribution lives in
    # the immutable transition history — no header duplication.
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    organization: Mapped[Organization] = relationship("Organization")
    farm: Mapped[Farm | None] = relationship("Farm")
    business_partner: Mapped[BusinessPartner] = relationship("BusinessPartner")
    lines: Mapped[list[PurchaseOrderLine]] = relationship(
        back_populates="purchase_order",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PurchaseOrderLine.line_number",
    )

    __table_args__ = (
        UniqueConstraint("organization_id", "po_number", name="uq_purchase_order_org_number"),
        CheckConstraint("version >= 1", name="ck_purchase_order_version_positive"),
        CheckConstraint("length(trim(po_number)) > 0", name="ck_purchase_order_number_non_empty"),
        CheckConstraint("length(trim(currency_code)) = 3", name="ck_purchase_order_currency_len3"),
        CheckConstraint(
            "length(trim(supplier_code)) > 0", name="ck_purchase_order_supplier_code_non_empty"
        ),
        CheckConstraint(
            "length(trim(supplier_legal_name)) > 0",
            name="ck_purchase_order_supplier_legal_name_non_empty",
        ),
        CheckConstraint(
            "expected_delivery_date IS NULL OR expected_delivery_date >= order_date",
            name="ck_purchase_order_delivery_after_order",
        ),
        Index("ix_purchase_orders_business_partner_id", "business_partner_id"),
        Index("ix_purchase_orders_order_date", "order_date"),
        Index("ix_purchase_orders_expected_delivery_date", "expected_delivery_date"),
    )


# Composite descending indexes (§10.3) — declared after the class so we
# can reference mapped columns with ``.desc()``; portable to SQLite too.
Index(
    "ix_purchase_orders_org_status_created_id",
    PurchaseOrder.organization_id,
    PurchaseOrder.status,
    PurchaseOrder.created_at.desc(),
    PurchaseOrder.id.desc(),
)
Index(
    "ix_purchase_orders_farm_status_created_id",
    PurchaseOrder.farm_id,
    PurchaseOrder.status,
    PurchaseOrder.created_at.desc(),
    PurchaseOrder.id.desc(),
)


# --------------------------------------------------------------------- #
# purchase_order_lines — §4.2 / §10.4
# --------------------------------------------------------------------- #
class PurchaseOrderLine(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "purchase_order_lines"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    line_number: Mapped[int] = mapped_column(Integer, nullable=False)
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    item_code: Mapped[str] = mapped_column(String(64), nullable=False)
    item_name: Mapped[str] = mapped_column(String(255), nullable=False)
    item_sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    line_note: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    ordered_quantity: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False)
    ordered_unit: Mapped[str] = mapped_column(String(32), nullable=False)
    canonical_unit: Mapped[str] = mapped_column(String(32), nullable=False)
    ordered_quantity_canonical: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False)
    received_quantity: Mapped[float] = mapped_column(
        Numeric(18, 6), nullable=False, default=0, server_default="0"
    )
    received_quantity_canonical: Mapped[float] = mapped_column(
        Numeric(18, 6), nullable=False, default=0, server_default="0"
    )
    unit_price: Mapped[float] = mapped_column(Numeric(20, 6), nullable=False)

    purchase_order: Mapped[PurchaseOrder] = relationship(back_populates="lines")
    inventory_item: Mapped[InventoryItem] = relationship("InventoryItem")

    __table_args__ = (
        UniqueConstraint("purchase_order_id", "line_number", name="uq_purchase_order_line_number"),
        CheckConstraint("line_number > 0", name="ck_purchase_order_line_number_positive"),
        CheckConstraint("ordered_quantity > 0", name="ck_purchase_order_line_qty_positive"),
        CheckConstraint(
            "ordered_quantity_canonical > 0", name="ck_purchase_order_line_qty_canonical_positive"
        ),
        CheckConstraint(
            "received_quantity >= 0 AND received_quantity <= ordered_quantity",
            name="ck_purchase_order_line_received_within_ordered",
        ),
        CheckConstraint(
            "received_quantity_canonical >= 0 "
            "AND received_quantity_canonical <= ordered_quantity_canonical",
            name="ck_purchase_order_line_received_canonical_within_ordered",
        ),
        CheckConstraint("unit_price >= 0", name="ck_purchase_order_line_price_non_negative"),
        CheckConstraint(
            "unit_price > 0 OR (line_note IS NOT NULL AND length(trim(line_note)) > 0)",
            name="ck_purchase_order_line_zero_price_requires_note",
        ),
        CheckConstraint(
            "length(trim(item_code)) > 0", name="ck_purchase_order_line_item_code_non_empty"
        ),
        CheckConstraint(
            "length(trim(item_name)) > 0", name="ck_purchase_order_line_item_name_non_empty"
        ),
        CheckConstraint(
            "length(trim(description)) > 0", name="ck_purchase_order_line_description_non_empty"
        ),
        CheckConstraint(
            "length(trim(ordered_unit)) > 0", name="ck_purchase_order_line_ordered_unit_non_empty"
        ),
        CheckConstraint(
            "length(trim(canonical_unit)) > 0",
            name="ck_purchase_order_line_canonical_unit_non_empty",
        ),
        Index("ix_purchase_order_lines_po_number", "purchase_order_id", "line_number"),
        Index("ix_purchase_order_lines_inventory_item_id", "inventory_item_id"),
    )


# --------------------------------------------------------------------- #
# purchase_order_transitions — §8.2 / §10.5 (append-only)
# --------------------------------------------------------------------- #
class PurchaseOrderTransition(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "purchase_order_transitions"

    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    from_status: Mapped[PurchaseOrderStatus | None] = mapped_column(PO_STATUS_ENUM, nullable=True)
    to_status: Mapped[PurchaseOrderStatus] = mapped_column(PO_STATUS_ENUM, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", _PO_JSONB, nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    actor: Mapped[User] = relationship("User")

    __table_args__ = (
        Index(
            "ix_purchase_order_transitions_po_occurred_id",
            "purchase_order_id",
            "occurred_at",
            "id",
        ),
    )


__all__ = [
    "NON_TERMINAL_STATUSES",
    "PO_STATUS_ENUM",
    "REACHABLE_STATUSES",
    "PurchaseOrder",
    "PurchaseOrderLine",
    "PurchaseOrderSequence",
    "PurchaseOrderStatus",
    "PurchaseOrderTransition",
]
