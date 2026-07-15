"""Sprint 4 P0-1 — extend ``warehouse_status`` enum with ``maintenance``.

The Codex Review Gate 03 verification pass called out that Sprint 4
shipped with only ``ACTIVE`` and ``CLOSED`` even though the PRD and
service layer promised a full ACTIVE/MAINTENANCE/CLOSED lifecycle
consistent with Sprint 3's site/unit policy. This migration adds the
missing ``maintenance`` label to the Postgres native enum and keeps
existing rows on ``active``.

Downgrade removes the label if no rows currently use it, otherwise it
raises rather than silently corrupting operational state.
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008_wh_maintenance"
down_revision: str | None = "0007_inventory_sprint_4"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:  # noqa: D401
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # ``ADD VALUE IF NOT EXISTS`` is idempotent and cannot run
        # inside a wrapped transaction on older Postgres; alembic uses
        # its own transactional wrapper so we execute AUTOCOMMIT-style.
        op.execute("ALTER TYPE warehouse_status ADD VALUE IF NOT EXISTS 'maintenance'")
    else:
        # SQLite stores enums as VARCHAR-with-check via SQLAlchemy;
        # the check constraint is emitted at CREATE TABLE time only,
        # so no ALTER is required — the app enum now accepts the new
        # value transparently.
        return


def downgrade() -> None:  # noqa: D401
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    # Refuse the downgrade if any warehouse still sits in maintenance.
    result = bind.execute(
        sa.text("SELECT count(*) FROM warehouses WHERE status = 'maintenance'")
    ).scalar_one()
    if result:
        raise RuntimeError(
            "Refusing to drop 'maintenance' from warehouse_status: "
            f"{result} warehouses are still in MAINTENANCE. Transition "
            "them to ACTIVE or CLOSED first."
        )
    # Postgres cannot drop a single enum label without recreating the
    # type. Rebuild it without ``maintenance``.
    op.execute("ALTER TABLE warehouses ALTER COLUMN status DROP DEFAULT")
    op.execute("ALTER TYPE warehouse_status RENAME TO warehouse_status_old")
    op.execute("CREATE TYPE warehouse_status AS ENUM ('active', 'closed')")
    op.execute(
        "ALTER TABLE warehouses "
        "ALTER COLUMN status TYPE warehouse_status USING status::text::warehouse_status"
    )
    op.execute("ALTER TABLE warehouses ALTER COLUMN status SET DEFAULT 'active'")
    op.execute("DROP TYPE warehouse_status_old")
