"""Release 6.0.4 immutable Purchase Receipt aggregate."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    DDL,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    event,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.farm import Farm
    from app.models.inventory import (
        InventoryItem,
        InventoryLot,
        InventoryTransaction,
        StorageLocation,
        Warehouse,
    )
    from app.models.organization import Organization
    from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
    from app.models.user import User


_SHA256_CHECK = (
    "length(payload_hash) = 64 AND payload_hash = lower(payload_hash) AND "
    "length(replace(replace(replace(replace(replace(replace(replace(replace("
    "replace(replace(replace(replace(replace(replace(replace(replace("
    "payload_hash,'0',''),'1',''),'2',''),'3',''),'4',''),'5',''),'6',''),'7',''),"
    "'8',''),'9',''),'a',''),'b',''),'c',''),'d',''),'e',''),'f','')) = 0"
)


class PurchaseReceiptSequence(Base):
    """Organization/year-scoped GRN allocator."""

    __tablename__ = "purchase_receipt_sequences"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="RESTRICT"), primary_key=True
    )
    year: Mapped[int] = mapped_column(primary_key=True)
    last_value: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("year BETWEEN 2000 AND 9999", name="ck_receipt_sequence_year_range"),
        CheckConstraint("last_value >= 0", name="ck_receipt_sequence_value_non_negative"),
    )


class PurchaseReceipt(Base, UUIDPrimaryKeyMixin):
    """A posted, append-only goods receipt. There is no draft or status."""

    __tablename__ = "purchase_receipts"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    farm_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("farms.id", ondelete="RESTRICT"), nullable=True
    )
    purchase_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="RESTRICT"), nullable=False
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    grn: Mapped[str] = mapped_column(String(32), nullable=False)
    supplier_delivery_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    notes: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )

    organization: Mapped[Organization] = relationship("Organization")
    farm: Mapped[Farm | None] = relationship("Farm")
    purchase_order: Mapped[PurchaseOrder] = relationship("PurchaseOrder")
    warehouse: Mapped[Warehouse] = relationship("Warehouse")
    received_by: Mapped[User] = relationship("User")
    lines: Mapped[list[PurchaseReceiptLine]] = relationship(
        back_populates="receipt", order_by="PurchaseReceiptLine.line_number"
    )

    __table_args__ = (
        UniqueConstraint("organization_id", "grn", name="uq_purchase_receipt_org_grn"),
        UniqueConstraint(
            "organization_id", "idempotency_key", name="uq_purchase_receipt_org_idempotency"
        ),
        CheckConstraint("length(trim(grn)) > 0", name="ck_purchase_receipt_grn_non_empty"),
        CheckConstraint(_SHA256_CHECK, name="ck_purchase_receipt_payload_hash_sha256"),
    )


class PurchaseReceiptLine(Base, UUIDPrimaryKeyMixin):
    """Immutable line linking one PO line to one lot and ledger row."""

    __tablename__ = "purchase_receipt_lines"

    purchase_receipt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "purchase_receipts.id",
            ondelete="RESTRICT",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
    )
    line_number: Mapped[int] = mapped_column(nullable=False)
    purchase_order_line_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("purchase_order_lines.id", ondelete="RESTRICT"),
        nullable=False,
    )
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("inventory_items.id", ondelete="RESTRICT"), nullable=False
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("warehouses.id", ondelete="RESTRICT"), nullable=False
    )
    storage_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="RESTRICT"), nullable=True
    )
    inventory_lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("inventory_lots.id", ondelete="RESTRICT"), nullable=False
    )
    inventory_transaction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_transactions.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    lot_code: Mapped[str] = mapped_column(String(128), nullable=False)
    expiry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    ordered_unit: Mapped[str] = mapped_column(String(32), nullable=False)
    quantity_canonical: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    canonical_unit: Mapped[str] = mapped_column(String(32), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(20, 6), nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )

    receipt: Mapped[PurchaseReceipt] = relationship(back_populates="lines")
    purchase_order_line: Mapped[PurchaseOrderLine] = relationship("PurchaseOrderLine")
    inventory_item: Mapped[InventoryItem] = relationship("InventoryItem")
    inventory_lot: Mapped[InventoryLot] = relationship("InventoryLot")
    inventory_transaction: Mapped[InventoryTransaction] = relationship("InventoryTransaction")
    storage_location: Mapped[StorageLocation | None] = relationship("StorageLocation")

    __table_args__ = (
        UniqueConstraint(
            "purchase_receipt_id", "line_number", name="uq_purchase_receipt_line_number"
        ),
        CheckConstraint("line_number > 0", name="ck_purchase_receipt_line_number_positive"),
        CheckConstraint("quantity > 0", name="ck_purchase_receipt_line_quantity_positive"),
        CheckConstraint(
            "quantity_canonical > 0", name="ck_purchase_receipt_line_canonical_positive"
        ),
        CheckConstraint("unit_price >= 0", name="ck_purchase_receipt_line_price_non_negative"),
        Index("ix_purchase_receipt_lines_po_line", "purchase_order_line_id"),
    )


Index(
    "ix_purchase_receipts_po_created_id",
    PurchaseReceipt.purchase_order_id,
    PurchaseReceipt.created_at.desc(),
    PurchaseReceipt.id.desc(),
)


def _reject_mutation(_mapper, _connection, target) -> None:
    raise ValueError(f"{type(target).__name__} is an immutable posted record")


for _immutable_model in (PurchaseReceipt, PurchaseReceiptLine):
    event.listen(_immutable_model, "before_update", _reject_mutation)
    event.listen(_immutable_model, "before_delete", _reject_mutation)


for _receipt_ddl in (
    """
    CREATE OR REPLACE FUNCTION prevent_purchase_receipt_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION '%% is an immutable posted record', TG_TABLE_NAME;
    END; $$
    """,
    """
    CREATE OR REPLACE FUNCTION prevent_purchase_receipt_line_append() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM public.purchase_receipts
        WHERE id = NEW.purchase_receipt_id
      ) THEN
        RAISE EXCEPTION 'purchase_receipt_lines is an immutable posted record';
      END IF;
      RETURN NEW;
    END; $$
    """,
    """
    CREATE TRIGGER trg_purchase_receipts_immutable
    BEFORE UPDATE OR DELETE ON purchase_receipts
    FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_mutation()
    """,
    """
    CREATE TRIGGER trg_purchase_receipt_lines_immutable
    BEFORE UPDATE OR DELETE ON purchase_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_mutation()
    """,
    """
    CREATE TRIGGER trg_purchase_receipt_lines_no_append
    BEFORE INSERT ON purchase_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_line_append()
    """,
):
    event.listen(
        PurchaseReceiptLine.__table__,
        "after_create",
        DDL(_receipt_ddl).execute_if(dialect="postgresql"),
    )
Index(
    "ix_purchase_receipts_warehouse_created_id",
    PurchaseReceipt.warehouse_id,
    PurchaseReceipt.created_at.desc(),
    PurchaseReceipt.id.desc(),
)


__all__ = ["PurchaseReceipt", "PurchaseReceiptLine", "PurchaseReceiptSequence"]
