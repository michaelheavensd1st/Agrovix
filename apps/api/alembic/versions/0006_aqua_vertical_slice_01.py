"""Sprint 3 — Aquaculture Vertical Slice 01.

Adds user-facing naming to :class:`ProductionUnitType` so verticals
can render domain-native labels ("Pond", "Cage", …) without ever
exposing the abstract "Production Unit" phrase in the UI. Also
introduces the ``vertical`` tag so future aggregate views can filter
by module.

Backfills existing rows so the deployment is safe on any pre-Sprint-3
database.

Revision ID: 0006_aqua_vertical_slice_01
Revises: 0005_prod_event_idempotent
Create Date: 2026-02-08 08:00:00.000000
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

# ------------------------------------------------------------------ #
revision: str = "0006_aqua_vertical_slice_01"
down_revision: str | None = "0005_prod_event_idempotent"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

TABLE = "production_unit_types"


def upgrade() -> None:
    op.add_column(
        TABLE,
        sa.Column("display_name", sa.String(255), nullable=False, server_default=""),
    )
    op.add_column(TABLE, sa.Column("plural_name", sa.String(255), nullable=True))
    op.add_column(TABLE, sa.Column("vertical", sa.String(64), nullable=True))
    op.create_index(f"ix_{TABLE}_vertical", TABLE, ["vertical"])

    # Backfill display_name from name for any pre-existing rows.
    op.execute(sa.text(f'UPDATE {TABLE} SET display_name = "name" WHERE display_name = \'\''))

    # Drop the server_default so future INSERTs must provide a value.
    op.alter_column(TABLE, "display_name", server_default=None)


def downgrade() -> None:
    op.drop_index(f"ix_{TABLE}_vertical", table_name=TABLE)
    op.drop_column(TABLE, "vertical")
    op.drop_column(TABLE, "plural_name")
    op.drop_column(TABLE, "display_name")
