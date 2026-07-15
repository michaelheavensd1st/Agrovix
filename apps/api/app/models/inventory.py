"""Sprint 4 — Operational Resources 01 (Inventory).

Design goals (see PRD "Sprint 4"):

* **Append-only ledger.** ``InventoryTransaction`` is the single
  source of truth for stock movements. Lots (:class:`InventoryLot`)
  never carry an editable ``current_quantity`` — the current balance
  is derived from the sum of signed ledger rows for that lot, locked
  under ``SELECT ... FOR UPDATE`` during any write.

* **Immutable history.** Posted transactions cannot be edited or
  deleted. Corrections happen via ``REVERSAL`` or audited
  ``ADJUSTMENT_INCREASE`` / ``ADJUSTMENT_DECREASE`` transactions with
  reason + actor + reference to the original row.

* **Org-scoped catalog, warehouse-scoped stock.** Items live at the
  organization; warehouses live at the org (optionally pinned to a
  farm + site); lots live in warehouses. Farm users only see stock
  from warehouses their farm has been granted access to (either a
  farm-scoped warehouse or an org-shared warehouse).

* **APE integration.** ``ProductionEvent`` types that consume stock
  (Sprint 4: FEEDING only) record a ``CONSUMPTION`` transaction in
  the same DB transaction as the event insert so either both land
  or neither.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy import (
    Enum as SQLEnum,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.farm import Farm
    from app.models.organization import Organization
    from app.models.production import ProductionSite


# --------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------- #
class WarehouseStatus(enum.StrEnum):
    ACTIVE = "active"
    CLOSED = "closed"


class InventoryItemCategory(enum.StrEnum):
    FEED = "feed"
    MEDICINE = "medicine"
    CHEMICAL = "chemical"
    SUPPLY = "supply"


class StockUnit(enum.StrEnum):
    """Controlled unit set for Sprint 4.

    Arbitrary unit strings are refused at the schema layer. Unit
    conversions (see :mod:`app.inventory.units`) apply only inside a
    coherent dimension (mass ↔ mass, volume ↔ volume). Count-like
    units (``count``, ``bag``, ``pack``) never convert.
    """

    KG = "kg"
    G = "g"
    L = "L"
    ML = "mL"
    COUNT = "count"
    BAG = "bag"
    PACK = "pack"


class InventoryTransactionType(enum.StrEnum):
    """Ledger transaction types.

    Sign map used by :func:`app.services.inventory.signed_delta`:

    * Increase (+): ``RECEIPT``, ``TRANSFER_IN``, ``ADJUSTMENT_INCREASE``
    * Decrease (-): ``ISSUE``, ``CONSUMPTION``, ``TRANSFER_OUT``,
      ``ADJUSTMENT_DECREASE``
    * ``REVERSAL`` inverts the sign of the row it references. This
      is enforced in the service layer, not at the DB level, so we
      can carry an idempotent reversal (no double-flip).
    """

    RECEIPT = "receipt"
    ISSUE = "issue"
    CONSUMPTION = "consumption"
    TRANSFER_OUT = "transfer_out"
    TRANSFER_IN = "transfer_in"
    ADJUSTMENT_INCREASE = "adjustment_increase"
    ADJUSTMENT_DECREASE = "adjustment_decrease"
    REVERSAL = "reversal"


# --------------------------------------------------------------------- #
# Warehouse
# --------------------------------------------------------------------- #
class Warehouse(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A physical storage facility owned by an organization.

    ``farm_id`` and ``site_id`` are optional:

    * ``farm_id IS NULL`` → org-shared warehouse. Any active member of
      the owning org can access it, subject to permissions.
    * ``farm_id`` set → farm-pinned warehouse. Only members with an
      active assignment to that farm can access it.
    * ``site_id`` further narrows the physical location. Access
      rules still key off ``farm_id`` so a site-pinned warehouse
      inherits the farm-scoping semantics automatically.

    ``deleted_at`` is a soft-delete marker (never hard delete —
    ledger rows still reference this warehouse).
    """

    __tablename__ = "warehouses"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    farm_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("farms.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    site_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("production_sites.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000))
    address: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[WarehouseStatus] = mapped_column(
        SQLEnum(
            WarehouseStatus,
            name="warehouse_status",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=WarehouseStatus.ACTIVE,
        server_default=WarehouseStatus.ACTIVE.value,
    )
    metadata_json: Mapped[dict | None] = mapped_column(
        "metadata", JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    organization: Mapped[Organization] = relationship("Organization")
    farm: Mapped[Farm | None] = relationship("Farm")
    site: Mapped[ProductionSite | None] = relationship("ProductionSite")
    storage_locations: Mapped[list[StorageLocation]] = relationship(
        back_populates="warehouse", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_warehouse_org_code"),
        Index("ix_warehouses_org_farm", "organization_id", "farm_id"),
    )


class StorageLocation(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Sub-location inside a warehouse (rack, shelf, cold-room)."""

    __tablename__ = "storage_locations"

    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("warehouses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    warehouse: Mapped[Warehouse] = relationship(back_populates="storage_locations")

    __table_args__ = (UniqueConstraint("warehouse_id", "code", name="uq_storage_location_wh_code"),)


# --------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------- #
class InventoryItem(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A distinct SKU / catalog entry for consumable inventory.

    ``canonical_unit`` is immutable once posted — changing it after
    stock exists would silently reinterpret every prior transaction.
    Enforced at the service layer.
    """

    __tablename__ = "inventory_items"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000))
    category: Mapped[InventoryItemCategory] = mapped_column(
        SQLEnum(
            InventoryItemCategory,
            name="inventory_item_category",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    canonical_unit: Mapped[StockUnit] = mapped_column(
        SQLEnum(
            StockUnit,
            name="stock_unit",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    sku: Mapped[str | None] = mapped_column(String(128))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    metadata_json: Mapped[dict | None] = mapped_column(
        "metadata", JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    organization: Mapped[Organization] = relationship("Organization")

    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_inventory_item_org_code"),
    )


class InventoryLot(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A physical lot / batch of an item held at a specific warehouse.

    Balances are computed from :class:`InventoryTransaction` — no
    editable ``current_quantity`` column exists. Reconciliation runs
    at the projections layer.
    """

    __tablename__ = "inventory_lots"

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("warehouses.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    storage_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("storage_locations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    lot_code: Mapped[str] = mapped_column(String(128), nullable=False)
    expiry_date: Mapped[datetime | None] = mapped_column(Date, index=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Optional receipt-time cost for later finance features. Not used
    # for any accounting in Sprint 4.
    unit_cost_amount: Mapped[float | None] = mapped_column(Numeric(18, 6))
    unit_cost_currency: Mapped[str | None] = mapped_column(String(3))
    metadata_json: Mapped[dict | None] = mapped_column(
        "metadata", JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    item: Mapped[InventoryItem] = relationship("InventoryItem")
    warehouse: Mapped[Warehouse] = relationship("Warehouse")
    storage_location: Mapped[StorageLocation | None] = relationship("StorageLocation")

    __table_args__ = (
        UniqueConstraint("warehouse_id", "item_id", "lot_code", name="uq_lot_wh_item_code"),
        Index("ix_inventory_lots_item_warehouse", "item_id", "warehouse_id"),
    )


# --------------------------------------------------------------------- #
# Ledger
# --------------------------------------------------------------------- #
class InventoryTransaction(Base, UUIDPrimaryKeyMixin):
    """Append-only inventory ledger row.

    * ``quantity`` is always positive; sign is derived from
      ``transaction_type`` (see
      :class:`InventoryTransactionType` docstring).
    * ``unit`` is captured on the row so a reversal can validate the
      unit still matches the referenced original even if the item
      catalog changed cosmetic fields.
    * ``idempotency_key`` (+ ``payload_hash``) enforce "same key +
      same payload → replay; same key + different payload → 409".
      Partial unique index on ``(lot_id, idempotency_key)`` scopes
      the key to a lot so different lots can reuse UUIDs cheaply.
    * ``reference_type`` / ``reference_id`` capture the origin of a
      row — ``production_event`` for FEEDING consumption; ``transfer``
      for the paired ``TRANSFER_OUT`` / ``TRANSFER_IN`` rows;
      ``inventory_transaction`` for a ``REVERSAL``.

    Immutability: this table has no ``updated_at`` — nothing here
    ever gets edited. Rollback / correction uses new rows only.
    """

    __tablename__ = "inventory_transactions"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    farm_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("farms.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("warehouses.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_lots.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    transaction_type: Mapped[InventoryTransactionType] = mapped_column(
        SQLEnum(
            InventoryTransactionType,
            name="inventory_transaction_type",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        index=True,
    )
    quantity: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False)
    unit: Mapped[StockUnit] = mapped_column(
        SQLEnum(
            StockUnit,
            name="stock_unit",
            native_enum=True,
            create_type=False,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    performed_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    performed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    reason: Mapped[str | None] = mapped_column(String(500))
    reference_type: Mapped[str | None] = mapped_column(String(64), index=True)
    reference_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    reverses_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("inventory_transactions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    payload_hash: Mapped[str | None] = mapped_column(String(64))
    metadata_json: Mapped[dict | None] = mapped_column(
        "metadata", JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Idempotency uniqueness — scoped per lot so tenants can reuse
        # UUIDs without cross-contamination. Partial index (Postgres);
        # SQLite falls back to a full unique constraint via SQLAlchemy.
        Index(
            "uq_inventory_tx_lot_idem",
            "lot_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
            sqlite_where=text("idempotency_key IS NOT NULL"),
        ),
        Index("ix_inventory_tx_ledger", "lot_id", "performed_at"),
        Index("ix_inventory_tx_reference", "reference_type", "reference_id"),
    )
