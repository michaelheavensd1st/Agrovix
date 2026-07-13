"""Add ProductionEvent idempotency keys.

Revision ID: 0005_production_event_idempotency
Revises: 0004_production_engine
Create Date: 2026-07-13 00:00:00.000000
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_production_event_idempotency"
down_revision = "0004_production_engine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "production_events",
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
    )
    op.create_unique_constraint(
        "uq_event_batch_idempotency_key",
        "production_events",
        ["batch_id", "idempotency_key"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_event_batch_idempotency_key",
        "production_events",
        type_="unique",
    )
    op.drop_column("production_events", "idempotency_key")
