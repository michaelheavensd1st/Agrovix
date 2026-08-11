"""Release 6.0.4 Purchase Receipts.

Revision ID: 0013_purchase_receipts
Revises: 0012_purchase_orders
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0013_purchase_receipts"
down_revision: str | None = "0012_purchase_orders"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

_PERMISSIONS = (
    ("purchase_receipt.create", "Post Purchase Receipts"),
    ("purchase_receipt.read", "Read Purchase Receipts"),
)
_ROLE_GRANTS: dict[str, tuple[str, ...]] = {
    "organization_owner": ("purchase_receipt.create", "purchase_receipt.read"),
    "farm_director": ("purchase_receipt.create", "purchase_receipt.read"),
    "farm_manager": ("purchase_receipt.create", "purchase_receipt.read"),
    "supervisor": ("purchase_receipt.read",),
    "storekeeper": ("purchase_receipt.create", "purchase_receipt.read"),
    "accountant": ("purchase_receipt.read",),
    "viewer": ("purchase_receipt.read",),
}

_SHA256_CHECK = (
    "length(payload_hash) = 64 AND payload_hash = lower(payload_hash) AND "
    "length(replace(replace(replace(replace(replace(replace(replace(replace("
    "replace(replace(replace(replace(replace(replace(replace(replace("
    "payload_hash,'0',''),'1',''),'2',''),'3',''),'4',''),'5',''),'6',''),'7',''),"
    "'8',''),'9',''),'a',''),'b',''),'c',''),'d',''),'e',''),'f','')) = 0"
)


def _seed_permissions(bind: sa.engine.Connection) -> None:
    is_pg = bind.dialect.name == "postgresql"
    for code, description in _PERMISSIONS:
        permission_id = bind.execute(
            sa.text("SELECT id FROM permissions WHERE code = :code"), {"code": code}
        ).scalar_one_or_none()
        permission_created = permission_id is None
        statement = (
            """
            INSERT INTO permissions (id, code, description, created_at, updated_at)
            VALUES (gen_random_uuid(), :code, :description, now(), now())
            ON CONFLICT (code) DO NOTHING
            """
            if is_pg
            else """
            INSERT OR IGNORE INTO permissions (id, code, description, created_at, updated_at)
            VALUES (lower(hex(randomblob(16))), :code, :description,
                    strftime('%Y-%m-%d %H:%M:%f000+00:00','now'),
                    strftime('%Y-%m-%d %H:%M:%f000+00:00','now'))
            """
        )
        bind.execute(sa.text(statement), {"code": code, "description": description})
        permission_id = bind.execute(
            sa.text("SELECT id FROM permissions WHERE code = :code"), {"code": code}
        ).scalar_one()
        if permission_created:
            bind.execute(
                sa.text(
                    "INSERT INTO migration_0013_permission_ownership "
                    "(kind, permission_id, role_id) VALUES ('permission', :permission_id, NULL)"
                ),
                {"permission_id": permission_id},
            )
    for role_name, codes in _ROLE_GRANTS.items():
        for code in codes:
            ids = bind.execute(
                sa.text(
                    "SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = :code "
                    "WHERE r.name = :role_name"
                ),
                {"role_name": role_name, "code": code},
            ).one_or_none()
            if ids is None:
                continue
            role_id, permission_id = ids
            existed = bind.execute(
                sa.text(
                    "SELECT 1 FROM role_permissions "
                    "WHERE role_id = :role_id AND permission_id = :permission_id"
                ),
                {"role_id": role_id, "permission_id": permission_id},
            ).scalar_one_or_none()
            if existed is not None:
                continue
            bind.execute(
                sa.text(
                    """
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = :code
                    WHERE r.name = :role_name
                      AND NOT EXISTS (
                        SELECT 1 FROM role_permissions rp
                        WHERE rp.role_id = r.id AND rp.permission_id = p.id
                      )
                    """
                ),
                {"role_name": role_name, "code": code},
            )
            bind.execute(
                sa.text(
                    "INSERT INTO migration_0013_permission_ownership "
                    "(kind, permission_id, role_id) VALUES ('grant', :permission_id, :role_id)"
                ),
                {"permission_id": permission_id, "role_id": role_id},
            )


def upgrade() -> None:
    bind = op.get_bind()
    op.create_table(
        "migration_0013_permission_ownership",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("permission_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint("kind IN ('permission', 'grant')", name="ck_0013_permission_owner_kind"),
        sa.UniqueConstraint(
            "kind", "permission_id", "role_id", name="uq_0013_permission_ownership"
        ),
    )
    op.create_table(
        "purchase_receipt_sequences",
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
        sa.CheckConstraint("year BETWEEN 2000 AND 9999", name="ck_receipt_sequence_year_range"),
        sa.CheckConstraint("last_value >= 0", name="ck_receipt_sequence_value_non_negative"),
    )
    op.create_table(
        "purchase_receipts",
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
            "purchase_order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "warehouse_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("warehouses.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("grn", sa.String(32), nullable=False),
        sa.Column("supplier_delivery_reference", sa.String(120), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("notes", sa.String(4000), nullable=True),
        sa.Column("idempotency_key", sa.String(255), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("organization_id", "grn", name="uq_purchase_receipt_org_grn"),
        sa.UniqueConstraint(
            "organization_id", "idempotency_key", name="uq_purchase_receipt_org_idempotency"
        ),
        sa.CheckConstraint("length(trim(grn)) > 0", name="ck_purchase_receipt_grn_non_empty"),
        sa.CheckConstraint(_SHA256_CHECK, name="ck_purchase_receipt_payload_hash_sha256"),
    )
    op.execute(
        "CREATE INDEX ix_purchase_receipts_po_created_id ON purchase_receipts (purchase_order_id, created_at DESC, id DESC)"
    )
    op.execute(
        "CREATE INDEX ix_purchase_receipts_warehouse_created_id ON purchase_receipts (warehouse_id, created_at DESC, id DESC)"
    )
    op.create_table(
        "purchase_receipt_lines",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "purchase_receipt_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey(
                "purchase_receipts.id",
                ondelete="RESTRICT",
                deferrable=True,
                initially="DEFERRED",
            ),
            nullable=False,
        ),
        sa.Column("line_number", sa.Integer, nullable=False),
        sa.Column(
            "purchase_order_line_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("purchase_order_lines.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "inventory_item_id",
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
        sa.Column(
            "inventory_lot_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_lots.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "inventory_transaction_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inventory_transactions.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column("lot_code", sa.String(128), nullable=False),
        sa.Column("expiry_date", sa.Date, nullable=True),
        sa.Column("quantity", sa.Numeric(18, 6), nullable=False),
        sa.Column("ordered_unit", sa.String(32), nullable=False),
        sa.Column("quantity_canonical", sa.Numeric(18, 6), nullable=False),
        sa.Column("canonical_unit", sa.String(32), nullable=False),
        sa.Column("unit_price", sa.Numeric(20, 6), nullable=False),
        sa.Column("currency_code", sa.String(3), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "purchase_receipt_id", "line_number", name="uq_purchase_receipt_line_number"
        ),
        sa.CheckConstraint("line_number > 0", name="ck_purchase_receipt_line_number_positive"),
        sa.CheckConstraint("quantity > 0", name="ck_purchase_receipt_line_quantity_positive"),
        sa.CheckConstraint(
            "quantity_canonical > 0", name="ck_purchase_receipt_line_canonical_positive"
        ),
        sa.CheckConstraint("unit_price >= 0", name="ck_purchase_receipt_line_price_non_negative"),
    )
    op.create_index(
        "ix_purchase_receipt_lines_po_line", "purchase_receipt_lines", ["purchase_order_line_id"]
    )
    if bind.dialect.name == "postgresql":
        op.execute(
            """
            CREATE FUNCTION prevent_purchase_receipt_mutation() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION '% is an immutable posted record', TG_TABLE_NAME;
            END;
            $$
            """
        )
        op.execute(
            "CREATE TRIGGER trg_purchase_receipts_immutable "
            "BEFORE UPDATE OR DELETE ON purchase_receipts "
            "FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_mutation()"
        )
        op.execute(
            "CREATE TRIGGER trg_purchase_receipt_lines_immutable "
            "BEFORE UPDATE OR DELETE ON purchase_receipt_lines "
            "FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_mutation()"
        )
        op.execute(
            """
            CREATE FUNCTION prevent_purchase_receipt_line_append() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM public.purchase_receipts
                WHERE id = NEW.purchase_receipt_id
              ) THEN
                RAISE EXCEPTION 'purchase_receipt_lines is an immutable posted record';
              END IF;
              RETURN NEW;
            END;
            $$
            """
        )
        op.execute(
            "CREATE TRIGGER trg_purchase_receipt_lines_no_append "
            "BEFORE INSERT ON purchase_receipt_lines "
            "FOR EACH ROW EXECUTE FUNCTION prevent_purchase_receipt_line_append()"
        )
    _seed_permissions(bind)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "DELETE FROM role_permissions WHERE EXISTS ("
            "SELECT 1 FROM migration_0013_permission_ownership o "
            "WHERE (o.kind = 'grant' AND o.role_id = role_permissions.role_id "
            "AND o.permission_id = role_permissions.permission_id) OR "
            "(o.kind = 'permission' AND o.permission_id = role_permissions.permission_id))"
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM permissions WHERE EXISTS ("
            "SELECT 1 FROM migration_0013_permission_ownership o "
            "WHERE o.kind = 'permission' AND o.permission_id = permissions.id)"
        )
    )
    if bind.dialect.name == "postgresql":
        op.execute(
            "DROP TRIGGER IF EXISTS trg_purchase_receipt_lines_no_append "
            "ON purchase_receipt_lines"
        )
        op.execute(
            "DROP TRIGGER IF EXISTS trg_purchase_receipt_lines_immutable "
            "ON purchase_receipt_lines"
        )
        op.execute("DROP TRIGGER IF EXISTS trg_purchase_receipts_immutable ON purchase_receipts")
        op.execute("DROP FUNCTION IF EXISTS prevent_purchase_receipt_mutation()")
        op.execute("DROP FUNCTION IF EXISTS prevent_purchase_receipt_line_append()")
    op.drop_index("ix_purchase_receipt_lines_po_line", table_name="purchase_receipt_lines")
    op.drop_table("purchase_receipt_lines")
    op.drop_index("ix_purchase_receipts_warehouse_created_id", table_name="purchase_receipts")
    op.drop_index("ix_purchase_receipts_po_created_id", table_name="purchase_receipts")
    op.drop_table("purchase_receipts")
    op.drop_table("purchase_receipt_sequences")
    op.drop_table("migration_0013_permission_ownership")


__all__ = ["down_revision", "downgrade", "revision", "upgrade"]
