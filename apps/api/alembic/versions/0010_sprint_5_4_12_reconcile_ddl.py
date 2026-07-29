"""Sprint 5.4.12 — reconcile transfer-topology DDL against the canonical source.

Ensures any production database whose transfer-topology triggers /
functions drifted from :mod:`app.db.inventory_transfer_ddl` is
re-aligned. The migration is a pure DDL re-install and is
IDEMPOTENT — it drops any stale trigger of the same name, then
recreates function + trigger from the canonical statements.

Design (per Sprint 5.4.12 §3 · Migration Hardening):

* Run the whole reconcile under ``ACCESS EXCLUSIVE`` on
  ``inventory_transactions`` so no concurrent writer can insert a
  row that would violate the freshly-installed constraint between
  drop and re-create.
* Consumes exactly the DDL list returned by
  :func:`install_all_sql`. Zero drift possible between this
  migration and ``Base.metadata.create_all`` — they share the SAME
  Python constants.
* SQLite: no-op (no triggers in the SQLite build).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from app.db.inventory_transfer_ddl import install_all_sql

revision: str = "0010_sprint_5_4_12_reconcile_ddl"
down_revision: str | None = "0009_transfer_group_id"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    bind.exec_driver_sql(
        "LOCK TABLE inventory_transactions IN ACCESS EXCLUSIVE MODE"
    )
    for stmt in install_all_sql():
        bind.exec_driver_sql(stmt)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    # Downgrading Sprint 5.4.12 leaves the Sprint 5.4.10 DDL in
    # place (identical content), so no destructive DDL is emitted.
    # If the canonical DDL ever changes, this downgrade should
    # re-install the *previous* revision's DDL. For now the
    # canonical DDL is unchanged from 5.4.10 → 5.4.12, so this
    # migration exists purely to reconcile drift on any DB whose
    # trigger state does not match ``install_all_sql``. A
    # downgrade re-applies the same install.
    bind.exec_driver_sql(
        "LOCK TABLE inventory_transactions IN ACCESS EXCLUSIVE MODE"
    )
    for stmt in install_all_sql():
        bind.exec_driver_sql(stmt)
