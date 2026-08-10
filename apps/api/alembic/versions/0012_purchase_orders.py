"""Release 6.0.3 — Purchase Orders.

Creates the ``purchase_order_status`` enum and four tables:

* ``purchase_order_sequences`` — org/year monotonic PO-number source.
* ``purchase_orders`` — aggregate-root header.
* ``purchase_order_lines`` — draft lines with frozen snapshots.
* ``purchase_order_transitions`` — append-only lifecycle history.

Also seeds the seven Purchase Order permissions and grants them to the
roles defined in §6 of ``docs/release_6.0/purchase-orders.md``.

The enum carries the full eight-value cross-release contract; Release
6.0.3 may only enter DRAFT / SUBMITTED / APPROVED / REJECTED /
CANCELLED. The received accumulators + their check constraints exist
now so 6.0.4 can post receipts without a competing PO migration.

Revision ID: 0012_purchase_orders
Revises: 0011_business_partners
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0012_purchase_orders"
down_revision: str | None = "0011_business_partners"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


_STATUS_VALUES = (
    "DRAFT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "PARTIALLY_RECEIVED",
    "RECEIVED",
    "CANCELLED",
    "CANCELLED_WITH_RECEIPTS",
)


_PO_PERMISSIONS: tuple[tuple[str, str], ...] = (
    ("purchase_order.read", "Read Purchase Orders"),
    ("purchase_order.create", "Create Purchase Orders"),
    ("purchase_order.update", "Update draft Purchase Orders"),
    ("purchase_order.submit", "Submit Purchase Orders for approval"),
    ("purchase_order.approve", "Approve submitted Purchase Orders"),
    ("purchase_order.reject", "Reject submitted Purchase Orders"),
    ("purchase_order.cancel", "Cancel Purchase Orders"),
)

_ALL = tuple(code for code, _ in _PO_PERMISSIONS)

# role_name → tuple of PO permission codes (§6 matrix).
_ROLE_GRANTS: dict[str, tuple[str, ...]] = {
    "organization_owner": _ALL,
    "farm_director": _ALL,
    "farm_manager": (
        "purchase_order.read",
        "purchase_order.create",
        "purchase_order.update",
        "purchase_order.submit",
    ),
    "supervisor": ("purchase_order.read",),
    "storekeeper": ("purchase_order.read",),
    "accountant": ("purchase_order.read",),
    "viewer": ("purchase_order.read",),
}


def _pg_enum() -> postgresql.ENUM:
    return postgresql.ENUM(*_STATUS_VALUES, name="purchase_order_status", create_type=False)


def _seed_permissions(bind: sa.engine.Connection) -> None:
    is_pg = bind.dialect.name == "postgresql"
    for code, description in _PO_PERMISSIONS:
        bind.execute(
            sa.text(
                """
                INSERT INTO permissions (id, code, description, created_at, updated_at)
                VALUES (gen_random_uuid(), :code, :description, now(), now())
                ON CONFLICT (code) DO NOTHING
                """
            )
            if is_pg
            else sa.text(
                """
                INSERT OR IGNORE INTO permissions (id, code, description, created_at, updated_at)
                VALUES (lower(hex(randomblob(16))), :code, :description,
                        strftime('%Y-%m-%d %H:%M:%f000+00:00','now'),
                        strftime('%Y-%m-%d %H:%M:%f000+00:00','now'))
                """
            ),
            {"code": code, "description": description},
        )
    for role_name, codes in _ROLE_GRANTS.items():
        for code in codes:
            bind.execute(
                sa.text(
                    """
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                      FROM roles r
                      JOIN permissions p ON p.code = :code
                     WHERE r.name = :role_name
                       AND NOT EXISTS (
                         SELECT 1 FROM role_permissions rp
                          WHERE rp.role_id = r.id AND rp.permission_id = p.id
                       )
                    """
                ),
                {"role_name": role_name, "code": code},
            )


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    if is_pg:
        sa.Enum(*_STATUS_VALUES, name="purchase_order_status").create(bind, checkfirst=True)
        status_col = _pg_enum()
    else:
        status_col = sa.Enum(*_STATUS_VALUES, name="purchase_order_status")

    # --- purchase_order_sequences -------------------------------- #
    op.create_table(
        "purchase_order_sequences",
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("year", sa.Integer, primary_key=True),
        sa.Column("last_value", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("year BETWEEN 2000 AND 9999", name="ck_po_sequence_year_range"),
        sa.CheckConstraint("last_value >= 0", name="ck_po_sequence_last_value_non_negative"),
    )

    # --- purchase_orders ----------------------------------------- #
    op.create_table(
        "purchase_orders",
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
            "business_partner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("business_partners.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("po_number", sa.String(32), nullable=False),
        sa.Column("supplier_reference", sa.String(120), nullable=True),
        sa.Column("status", status_col, nullable=False, server_default="DRAFT"),
        sa.Column("currency_code", sa.String(3), nullable=False),
        sa.Column("order_date", sa.Date, nullable=False),
        sa.Column("expected_delivery_date", sa.Date, nullable=True),
        sa.Column("delivery_address", postgresql.JSONB, nullable=True),
        sa.Column("notes", sa.String(4000), nullable=True),
        sa.Column("supplier_code", sa.String(64), nullable=False),
        sa.Column("supplier_legal_name", sa.String(255), nullable=False),
        sa.Column("supplier_trading_name", sa.String(255), nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column(
            "created_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "submitted_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "approved_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "rejected_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "cancelled_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("organization_id", "po_number", name="uq_purchase_order_org_number"),
        sa.CheckConstraint("version >= 1", name="ck_purchase_order_version_positive"),
        sa.CheckConstraint(
            "length(trim(po_number)) > 0", name="ck_purchase_order_number_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(currency_code)) = 3", name="ck_purchase_order_currency_len3"
        ),
        sa.CheckConstraint(
            "length(trim(supplier_code)) > 0", name="ck_purchase_order_supplier_code_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(supplier_legal_name)) > 0",
            name="ck_purchase_order_supplier_legal_name_non_empty",
        ),
        sa.CheckConstraint(
            "expected_delivery_date IS NULL OR expected_delivery_date >= order_date",
            name="ck_purchase_order_delivery_after_order",
        ),
    )
    op.create_index(
        "ix_purchase_orders_business_partner_id", "purchase_orders", ["business_partner_id"]
    )
    op.create_index("ix_purchase_orders_order_date", "purchase_orders", ["order_date"])
    op.create_index(
        "ix_purchase_orders_expected_delivery_date", "purchase_orders", ["expected_delivery_date"]
    )
    op.execute(
        "CREATE INDEX ix_purchase_orders_org_status_created_id "
        "ON purchase_orders (organization_id, status, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX ix_purchase_orders_farm_status_created_id "
        "ON purchase_orders (farm_id, status, created_at DESC, id DESC)"
    )

    # --- purchase_order_lines ------------------------------------ #
    op.create_table(
        "purchase_order_lines",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "purchase_order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("line_number", sa.Integer, nullable=False),
        sa.Column(
            "inventory_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("item_code", sa.String(64), nullable=False),
        sa.Column("item_name", sa.String(255), nullable=False),
        sa.Column("item_sku", sa.String(128), nullable=True),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("line_note", sa.String(1000), nullable=True),
        sa.Column("ordered_quantity", sa.Numeric(18, 6), nullable=False),
        sa.Column("ordered_unit", sa.String(32), nullable=False),
        sa.Column("canonical_unit", sa.String(32), nullable=False),
        sa.Column("ordered_quantity_canonical", sa.Numeric(18, 6), nullable=False),
        sa.Column("received_quantity", sa.Numeric(18, 6), nullable=False, server_default="0"),
        sa.Column(
            "received_quantity_canonical", sa.Numeric(18, 6), nullable=False, server_default="0"
        ),
        sa.Column("unit_price", sa.Numeric(20, 6), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "purchase_order_id", "line_number", name="uq_purchase_order_line_number"
        ),
        sa.CheckConstraint("line_number > 0", name="ck_purchase_order_line_number_positive"),
        sa.CheckConstraint("ordered_quantity > 0", name="ck_purchase_order_line_qty_positive"),
        sa.CheckConstraint(
            "ordered_quantity_canonical > 0",
            name="ck_purchase_order_line_qty_canonical_positive",
        ),
        sa.CheckConstraint(
            "received_quantity >= 0 AND received_quantity <= ordered_quantity",
            name="ck_purchase_order_line_received_within_ordered",
        ),
        sa.CheckConstraint(
            "received_quantity_canonical >= 0 "
            "AND received_quantity_canonical <= ordered_quantity_canonical",
            name="ck_purchase_order_line_received_canonical_within_ordered",
        ),
        sa.CheckConstraint("unit_price >= 0", name="ck_purchase_order_line_price_non_negative"),
        sa.CheckConstraint(
            "unit_price > 0 OR (line_note IS NOT NULL AND length(trim(line_note)) > 0)",
            name="ck_purchase_order_line_zero_price_requires_note",
        ),
        sa.CheckConstraint(
            "length(trim(item_code)) > 0", name="ck_purchase_order_line_item_code_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(item_name)) > 0", name="ck_purchase_order_line_item_name_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(description)) > 0", name="ck_purchase_order_line_description_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(ordered_unit)) > 0",
            name="ck_purchase_order_line_ordered_unit_non_empty",
        ),
        sa.CheckConstraint(
            "length(trim(canonical_unit)) > 0",
            name="ck_purchase_order_line_canonical_unit_non_empty",
        ),
    )
    op.create_index(
        "ix_purchase_order_lines_po_number",
        "purchase_order_lines",
        ["purchase_order_id", "line_number"],
    )
    op.create_index(
        "ix_purchase_order_lines_inventory_item_id",
        "purchase_order_lines",
        ["inventory_item_id"],
    )

    # --- purchase_order_transitions ------------------------------ #
    op.create_table(
        "purchase_order_transitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "purchase_order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("from_status", _pg_enum() if is_pg else status_col, nullable=True),
        sa.Column("to_status", _pg_enum() if is_pg else status_col, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(500), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "ix_purchase_order_transitions_po_occurred_id",
        "purchase_order_transitions",
        ["purchase_order_id", "occurred_at", "id"],
    )

    _seed_permissions(bind)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    for code in _ALL:
        bind.execute(
            sa.text(
                """
                DELETE FROM role_permissions
                 WHERE permission_id IN (SELECT id FROM permissions WHERE code = :code)
                """
            ),
            {"code": code},
        )
    for code in _ALL:
        bind.execute(
            sa.text("DELETE FROM permissions WHERE code = :code"), {"code": code}
        )

    op.drop_index(
        "ix_purchase_order_transitions_po_occurred_id",
        table_name="purchase_order_transitions",
    )
    op.drop_table("purchase_order_transitions")

    op.drop_index(
        "ix_purchase_order_lines_inventory_item_id", table_name="purchase_order_lines"
    )
    op.drop_index("ix_purchase_order_lines_po_number", table_name="purchase_order_lines")
    op.drop_table("purchase_order_lines")

    op.drop_index("ix_purchase_orders_farm_status_created_id", table_name="purchase_orders")
    op.drop_index("ix_purchase_orders_org_status_created_id", table_name="purchase_orders")
    op.drop_index("ix_purchase_orders_expected_delivery_date", table_name="purchase_orders")
    op.drop_index("ix_purchase_orders_order_date", table_name="purchase_orders")
    op.drop_index("ix_purchase_orders_business_partner_id", table_name="purchase_orders")
    op.drop_table("purchase_orders")

    op.drop_table("purchase_order_sequences")

    if is_pg:
        sa.Enum(name="purchase_order_status").drop(bind, checkfirst=True)


__all__ = ["down_revision", "downgrade", "revision", "upgrade"]
