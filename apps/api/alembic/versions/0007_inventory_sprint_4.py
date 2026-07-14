"""Sprint 4 — Operational Resources 01 (Inventory).

Adds:

* ``warehouses``, ``storage_locations``
* ``inventory_items`` (catalog), ``inventory_lots`` (physical lots)
* ``inventory_transactions`` (append-only ledger)
* Postgres enums: ``warehouse_status``, ``inventory_item_category``,
  ``stock_unit``, ``inventory_transaction_type``
* Partial unique index enforcing per-lot idempotency for ledger writes

Revision ID: 0007_inventory_sprint_4
Revises: 0006_aqua_vertical_slice_01
Create Date: 2026-02-08 22:00:00.000000
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# ------------------------------------------------------------------ #
revision: str = "0007_inventory_sprint_4"
down_revision: str | None = "0006_aqua_vertical_slice_01"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


_WAREHOUSE_STATUS_VALUES = ("active", "closed")
_ITEM_CATEGORY_VALUES = ("feed", "medicine", "chemical", "supply")
_STOCK_UNIT_VALUES = ("kg", "g", "L", "mL", "count", "bag", "pack")
_TX_TYPE_VALUES = (
    "receipt",
    "issue",
    "consumption",
    "transfer_out",
    "transfer_in",
    "adjustment_increase",
    "adjustment_decrease",
    "reversal",
)


def _pg_enum(name: str, values: tuple[str, ...]) -> postgresql.ENUM:
    return postgresql.ENUM(*values, name=name, create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # --- Postgres enums (create once, reused across columns) ------ #
    if is_pg:
        sa.Enum(*_WAREHOUSE_STATUS_VALUES, name="warehouse_status").create(bind, checkfirst=True)
        sa.Enum(*_ITEM_CATEGORY_VALUES, name="inventory_item_category").create(
            bind, checkfirst=True
        )
        sa.Enum(*_STOCK_UNIT_VALUES, name="stock_unit").create(bind, checkfirst=True)
        sa.Enum(*_TX_TYPE_VALUES, name="inventory_transaction_type").create(bind, checkfirst=True)

        wh_status_col = _pg_enum("warehouse_status", _WAREHOUSE_STATUS_VALUES)
        item_cat_col = _pg_enum("inventory_item_category", _ITEM_CATEGORY_VALUES)
        stock_unit_col = _pg_enum("stock_unit", _STOCK_UNIT_VALUES)
        tx_type_col = _pg_enum("inventory_transaction_type", _TX_TYPE_VALUES)
    else:
        # SQLite: SQLAlchemy renders CHECK constraints from Enum().
        wh_status_col = sa.Enum(*_WAREHOUSE_STATUS_VALUES, name="warehouse_status")
        item_cat_col = sa.Enum(*_ITEM_CATEGORY_VALUES, name="inventory_item_category")
        stock_unit_col = sa.Enum(*_STOCK_UNIT_VALUES, name="stock_unit")
        tx_type_col = sa.Enum(*_TX_TYPE_VALUES, name="inventory_transaction_type")

    # --- warehouses ---------------------------------------------- #
    op.create_table(
        "warehouses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "farm_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("farms.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "site_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("production_sites.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("address", sa.String(1000), nullable=True),
        sa.Column("status", wh_status_col, nullable=False, server_default="active"),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.UniqueConstraint("organization_id", "code", name="uq_warehouse_org_code"),
    )
    op.create_index("ix_warehouses_organization_id", "warehouses", ["organization_id"])
    op.create_index("ix_warehouses_farm_id", "warehouses", ["farm_id"])
    op.create_index("ix_warehouses_site_id", "warehouses", ["site_id"])
    op.create_index("ix_warehouses_deleted_at", "warehouses", ["deleted_at"])
    op.create_index("ix_warehouses_org_farm", "warehouses", ["organization_id", "farm_id"])

    # --- storage_locations --------------------------------------- #
    op.create_table(
        "storage_locations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "warehouse_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("warehouses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.UniqueConstraint("warehouse_id", "code", name="uq_storage_location_wh_code"),
    )
    op.create_index("ix_storage_locations_warehouse_id", "storage_locations", ["warehouse_id"])
    op.create_index("ix_storage_locations_deleted_at", "storage_locations", ["deleted_at"])

    # --- inventory_items ----------------------------------------- #
    op.create_table(
        "inventory_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("category", item_cat_col, nullable=False),
        sa.Column("canonical_unit", stock_unit_col, nullable=False),
        sa.Column("sku", sa.String(128), nullable=True),
        sa.Column(
            "is_active", sa.Boolean, nullable=False, server_default=sa.text("true")
        ),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.UniqueConstraint("organization_id", "code", name="uq_inventory_item_org_code"),
    )
    op.create_index("ix_inventory_items_organization_id", "inventory_items", ["organization_id"])
    op.create_index("ix_inventory_items_deleted_at", "inventory_items", ["deleted_at"])

    # --- inventory_lots ------------------------------------------ #
    op.create_table(
        "inventory_lots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "warehouse_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("warehouses.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "storage_location_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("storage_locations.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("lot_code", sa.String(128), nullable=False),
        sa.Column("expiry_date", sa.Date, nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unit_cost_amount", sa.Numeric(18, 6), nullable=True),
        sa.Column("unit_cost_currency", sa.String(3), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
        sa.UniqueConstraint("warehouse_id", "item_id", "lot_code", name="uq_lot_wh_item_code"),
    )
    op.create_index("ix_inventory_lots_item_id", "inventory_lots", ["item_id"])
    op.create_index("ix_inventory_lots_warehouse_id", "inventory_lots", ["warehouse_id"])
    op.create_index("ix_inventory_lots_expiry_date", "inventory_lots", ["expiry_date"])
    op.create_index("ix_inventory_lots_deleted_at", "inventory_lots", ["deleted_at"])
    op.create_index(
        "ix_inventory_lots_item_warehouse",
        "inventory_lots",
        ["item_id", "warehouse_id"],
    )

    # --- inventory_transactions ---------------------------------- #
    op.create_table(
        "inventory_transactions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "farm_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("farms.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "warehouse_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("warehouses.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "lot_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_lots.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("transaction_type", tx_type_col, nullable=False),
        sa.Column("quantity", sa.Numeric(18, 6), nullable=False),
        sa.Column("unit", stock_unit_col, nullable=False),
        sa.Column(
            "performed_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "performed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("reason", sa.String(500), nullable=True),
        sa.Column("reference_type", sa.String(64), nullable=True),
        sa.Column("reference_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "reverses_transaction_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_transactions.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("idempotency_key", sa.String(128), nullable=True),
        sa.Column("payload_hash", sa.String(64), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
    )
    op.create_index(
        "ix_inventory_transactions_organization_id", "inventory_transactions", ["organization_id"]
    )
    op.create_index("ix_inventory_transactions_farm_id", "inventory_transactions", ["farm_id"])
    op.create_index(
        "ix_inventory_transactions_warehouse_id", "inventory_transactions", ["warehouse_id"]
    )
    op.create_index("ix_inventory_transactions_item_id", "inventory_transactions", ["item_id"])
    op.create_index("ix_inventory_transactions_lot_id", "inventory_transactions", ["lot_id"])
    op.create_index(
        "ix_inventory_transactions_transaction_type",
        "inventory_transactions",
        ["transaction_type"],
    )
    op.create_index(
        "ix_inventory_transactions_performed_at",
        "inventory_transactions",
        ["performed_at"],
    )
    op.create_index(
        "ix_inventory_transactions_reference_type",
        "inventory_transactions",
        ["reference_type"],
    )
    op.create_index(
        "ix_inventory_transactions_reference_id",
        "inventory_transactions",
        ["reference_id"],
    )
    op.create_index(
        "ix_inventory_tx_reference",
        "inventory_transactions",
        ["reference_type", "reference_id"],
    )
    op.create_index(
        "ix_inventory_tx_ledger",
        "inventory_transactions",
        ["lot_id", "performed_at"],
    )
    # Idempotency uniqueness — partial index on Postgres; SQLite emits
    # a partial index too (supported since 3.8).
    op.create_index(
        "uq_inventory_tx_lot_idem",
        "inventory_transactions",
        ["lot_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
        sqlite_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_inventory_tx_lot_idem", table_name="inventory_transactions")
    op.drop_index("ix_inventory_tx_ledger", table_name="inventory_transactions")
    op.drop_index("ix_inventory_tx_reference", table_name="inventory_transactions")
    op.drop_index(
        "ix_inventory_transactions_reference_id", table_name="inventory_transactions"
    )
    op.drop_index(
        "ix_inventory_transactions_reference_type", table_name="inventory_transactions"
    )
    op.drop_index(
        "ix_inventory_transactions_performed_at", table_name="inventory_transactions"
    )
    op.drop_index(
        "ix_inventory_transactions_transaction_type", table_name="inventory_transactions"
    )
    op.drop_index("ix_inventory_transactions_lot_id", table_name="inventory_transactions")
    op.drop_index("ix_inventory_transactions_item_id", table_name="inventory_transactions")
    op.drop_index(
        "ix_inventory_transactions_warehouse_id", table_name="inventory_transactions"
    )
    op.drop_index("ix_inventory_transactions_farm_id", table_name="inventory_transactions")
    op.drop_index(
        "ix_inventory_transactions_organization_id", table_name="inventory_transactions"
    )
    op.drop_table("inventory_transactions")

    op.drop_index("ix_inventory_lots_item_warehouse", table_name="inventory_lots")
    op.drop_index("ix_inventory_lots_deleted_at", table_name="inventory_lots")
    op.drop_index("ix_inventory_lots_expiry_date", table_name="inventory_lots")
    op.drop_index("ix_inventory_lots_warehouse_id", table_name="inventory_lots")
    op.drop_index("ix_inventory_lots_item_id", table_name="inventory_lots")
    op.drop_table("inventory_lots")

    op.drop_index("ix_inventory_items_deleted_at", table_name="inventory_items")
    op.drop_index("ix_inventory_items_organization_id", table_name="inventory_items")
    op.drop_table("inventory_items")

    op.drop_index("ix_storage_locations_deleted_at", table_name="storage_locations")
    op.drop_index("ix_storage_locations_warehouse_id", table_name="storage_locations")
    op.drop_table("storage_locations")

    op.drop_index("ix_warehouses_org_farm", table_name="warehouses")
    op.drop_index("ix_warehouses_deleted_at", table_name="warehouses")
    op.drop_index("ix_warehouses_site_id", table_name="warehouses")
    op.drop_index("ix_warehouses_farm_id", table_name="warehouses")
    op.drop_index("ix_warehouses_organization_id", table_name="warehouses")
    op.drop_table("warehouses")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        sa.Enum(name="inventory_transaction_type").drop(bind, checkfirst=True)
        sa.Enum(name="stock_unit").drop(bind, checkfirst=True)
        sa.Enum(name="inventory_item_category").drop(bind, checkfirst=True)
        sa.Enum(name="warehouse_status").drop(bind, checkfirst=True)
