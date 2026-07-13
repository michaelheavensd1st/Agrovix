"""Sprint 2 — Production Engine (sites, unit types, units, batches, events).

Revision ID: 0004_production_engine
Revises: 0003_verification_active_unique_index
Create Date: 2026-02-06 21:00:00.000000
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_production_engine"
down_revision = "0003_verification_active_unique_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- Reference data: production_unit_types ------------------------ #
    op.create_table(
        "production_unit_types",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("category", sa.String(64), nullable=True),
        sa.Column("is_system", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("organization_id", "code", name="uq_unit_type_org_code"),
    )
    op.create_index(
        "uq_unit_type_system_code",
        "production_unit_types", ["code"], unique=True,
        postgresql_where=sa.text("organization_id IS NULL"),
    )
    op.create_index("ix_production_unit_types_org", "production_unit_types", ["organization_id"])
    op.create_index("ix_production_unit_types_code", "production_unit_types", ["code"])
    op.create_index("ix_production_unit_types_deleted", "production_unit_types", ["deleted_at"])

    # --- production_sites -------------------------------------------- #
    site_status = sa.Enum("active", "maintenance", "closed", name="production_site_status")
    site_status.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "production_sites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("farm_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("farms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("description", sa.String(1000), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("latitude", sa.Numeric(10, 7), nullable=True),
        sa.Column("longitude", sa.Numeric(10, 7), nullable=True),
        sa.Column("timezone", sa.String(80), nullable=True),
        sa.Column("manager_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("capacity", sa.Integer, nullable=True),
        sa.Column("status", site_status, nullable=False, server_default="active"),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("farm_id", "code", name="uq_site_farm_code"),
    )
    op.create_index("ix_production_sites_farm", "production_sites", ["farm_id"])
    op.create_index("ix_production_sites_deleted", "production_sites", ["deleted_at"])

    # --- production_units -------------------------------------------- #
    unit_status = sa.Enum("active", "maintenance", "closed", name="production_unit_status")
    unit_status.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "production_units",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("site_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("unit_type_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_unit_types.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("capacity", sa.Integer, nullable=True),
        sa.Column("status", unit_status, nullable=False, server_default="active"),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("site_id", "code", name="uq_unit_site_code"),
    )
    op.create_index("ix_production_units_site", "production_units", ["site_id"])
    op.create_index("ix_production_units_type", "production_units", ["unit_type_id"])
    op.create_index("ix_production_units_deleted", "production_units", ["deleted_at"])

    # --- production_batches ------------------------------------------ #
    batch_state = sa.Enum(
        "planned", "stocked", "active", "harvested", "closed",
        "suspended", "cancelled", "failed",
        name="production_batch_state",
    )
    batch_state.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "production_batches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("unit_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_units.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("state", batch_state, nullable=False, server_default="planned"),
        sa.Column("species", sa.String(255), nullable=True),
        sa.Column("planned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stocked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("harvested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expected_quantity", sa.Integer, nullable=True),
        sa.Column("actual_quantity", sa.Integer, nullable=True),
        sa.Column("notes", sa.String(2000), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("unit_id", "code", name="uq_batch_unit_code"),
    )
    op.create_index("ix_batches_state", "production_batches", ["state"])
    op.create_index("ix_production_batches_unit", "production_batches", ["unit_id"])
    op.create_index("ix_production_batches_deleted", "production_batches", ["deleted_at"])

    # --- production_events (append-only, partition-ready) ------------ #
    op.create_table(
        "production_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("farm_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("farms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("site_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("unit_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_units.id", ondelete="CASCADE"), nullable=False),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("event_type_version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("performed_by_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        # ``performed_at`` is the future partition key — leave the column
        # itself untouched here so partitioning can be applied later with
        # ``ALTER TABLE ... PARTITION BY RANGE (performed_at)`` in a
        # future migration.
        sa.Column("performed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data", postgresql.JSONB, nullable=False),
        sa.Column("attachments", postgresql.JSONB, nullable=True),
        sa.Column("is_final", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("notes", sa.String(2000), nullable=True),
        sa.Column("audit_event_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("audit_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    # Composite index tuned for cursor pagination:
    # ORDER BY performed_at DESC, id DESC
    op.create_index("ix_events_batch_performed", "production_events",
                    ["batch_id", "performed_at", "id"])
    op.create_index("ix_events_unit_performed", "production_events", ["unit_id", "performed_at"])
    op.create_index("ix_events_type_performed", "production_events", ["event_type", "performed_at"])
    op.create_index("ix_events_org_performed", "production_events", ["organization_id", "performed_at"])
    op.create_index("ix_events_farm_performed", "production_events", ["farm_id", "performed_at"])
    op.create_index("ix_production_events_site", "production_events", ["site_id"])
    op.create_index("ix_production_events_performed_at", "production_events", ["performed_at"])

    # --- production_batch_transitions -------------------------------- #
    op.create_table(
        "production_batch_transitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("from_state", batch_state, nullable=True),
        sa.Column("to_state", batch_state, nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("production_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reason", sa.String(1000), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_batch_transitions_batch_occurred",
                    "production_batch_transitions", ["batch_id", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_batch_transitions_batch_occurred", table_name="production_batch_transitions")
    op.drop_table("production_batch_transitions")

    for idx in (
        "ix_events_batch_performed", "ix_events_unit_performed",
        "ix_events_type_performed", "ix_events_org_performed",
        "ix_events_farm_performed", "ix_production_events_site",
        "ix_production_events_performed_at",
    ):
        op.drop_index(idx, table_name="production_events")
    op.drop_table("production_events")

    op.drop_index("ix_batches_state", table_name="production_batches")
    op.drop_index("ix_production_batches_unit", table_name="production_batches")
    op.drop_index("ix_production_batches_deleted", table_name="production_batches")
    op.drop_table("production_batches")
    sa.Enum(name="production_batch_state").drop(op.get_bind(), checkfirst=True)

    for idx in ("ix_production_units_site", "ix_production_units_type", "ix_production_units_deleted"):
        op.drop_index(idx, table_name="production_units")
    op.drop_table("production_units")
    sa.Enum(name="production_unit_status").drop(op.get_bind(), checkfirst=True)

    for idx in ("ix_production_sites_farm", "ix_production_sites_deleted"):
        op.drop_index(idx, table_name="production_sites")
    op.drop_table("production_sites")
    sa.Enum(name="production_site_status").drop(op.get_bind(), checkfirst=True)

    for idx in ("uq_unit_type_system_code", "ix_production_unit_types_org",
                "ix_production_unit_types_code", "ix_production_unit_types_deleted"):
        op.drop_index(idx, table_name="production_unit_types")
    op.drop_table("production_unit_types")
