"""Codex Review Gate 01 — production_event idempotency.

Revision ID: 0005_prod_event_idempotent
Revises: 0004_production_engine
Create Date: 2026-02-07 00:00:00.000000

Adds ``idempotency_key`` + ``payload_hash`` columns to
``production_events`` and a partial unique index on
``(batch_id, idempotency_key)`` so that clients can safely retry
``POST /batches/{id}/events`` behind the ``Idempotency-Key`` header.

See ``docs/audits/codex-review-gate-01.md`` (finding CRG01-2) for the
full policy.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_prod_event_idempotent"
down_revision = "0004_production_engine"
branch_labels = None
depends_on = None

INDEX_NAME = "uq_events_batch_idempotency_key"
TABLE_NAME = "production_events"


def upgrade() -> None:
    op.add_column(
        TABLE_NAME,
        sa.Column("idempotency_key", sa.String(128), nullable=True),
    )
    op.add_column(
        TABLE_NAME,
        sa.Column("payload_hash", sa.String(64), nullable=True),
    )
    op.create_index(
        INDEX_NAME,
        TABLE_NAME,
        ["batch_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
    op.drop_column(TABLE_NAME, "payload_hash")
    op.drop_column(TABLE_NAME, "idempotency_key")
