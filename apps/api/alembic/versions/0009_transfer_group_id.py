"""Sprint 5.4.8/5.4.9/5.4.10 — Immutable transfer identity + full
topology enforcement (canonical DDL, pre-flight, table lock,
deferred pair-completeness constraint).

Upgrade sequence
----------------
1. Acquire ``ACCESS EXCLUSIVE`` lock on ``inventory_transactions`` so
   pre-flight validation and back-fill see a stable, malformed-write-
   free view (Sprint 5.4.10 §5).
2. Run pre-flight malformed-topology detection over transfer-role
   rows AND non-transfer rows carrying transfer references. On any
   finding, abort with counts (§4/§5).
3. Add the ``transfer_group_id`` column + index.
4. Back-fill ``transfer_group_id`` STRICTLY on rows whose
   ``transaction_type`` is a transfer role (§4). Non-transfer rows
   are left untouched.
5. Create the partial unique index that enforces "at most one OUT
   and one IN per group" (§3).
6. Install the canonical enforcement DDL from
   ``app.db.inventory_transfer_ddl`` — a single source of truth
   shared with ``Base.metadata.create_all`` (§2).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text as _sa_text

from app.db.inventory_transfer_ddl import install_all_sql

revision: str = "0009_transfer_group_id"
down_revision: str | None = "0008_wh_maintenance"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        # Sprint 5.4.10 §5 — pre-flight and back-fill run under an
        # ACCESS EXCLUSIVE lock so no concurrent writer can insert
        # malformed rows between pre-flight and constraint creation.
        bind.execute(
            _sa_text(
                "LOCK TABLE inventory_transactions "
                "IN ACCESS EXCLUSIVE MODE"
            )
        )

        # Sprint 5.4.10 §4 pre-flight — count every malformed shape.
        pre = bind.execute(
            _sa_text(
                "WITH transfer_rows AS ("
                "  SELECT id, transaction_type, reference_id, reference_type, "
                "         organization_id, item_id "
                "  FROM inventory_transactions "
                "  WHERE transaction_type IN ('transfer_out', 'transfer_in')"
                ") "
                "SELECT "
                "  (SELECT COUNT(*) FROM transfer_rows "
                "    WHERE reference_id IS NULL) AS transfer_null_ref, "
                "  (SELECT COUNT(*) FROM transfer_rows "
                "    WHERE reference_type IS DISTINCT FROM 'transfer') "
                "    AS transfer_wrong_ref_type, "
                "  (SELECT COUNT(*) FROM inventory_transactions "
                "    WHERE reference_type = 'transfer' "
                "      AND transaction_type NOT IN ('transfer_out', 'transfer_in')) "
                "    AS non_transfer_using_ref, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id, transaction_type, COUNT(*) c "
                "      FROM transfer_rows WHERE reference_id IS NOT NULL "
                "      GROUP BY reference_id, transaction_type "
                "     HAVING COUNT(*) > 1) x) AS duplicate_roles, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id FROM transfer_rows "
                "     WHERE reference_id IS NOT NULL "
                "     GROUP BY reference_id HAVING COUNT(*) <> 2) x) "
                "    AS incomplete_pairs, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id FROM transfer_rows "
                "     WHERE reference_id IS NOT NULL "
                "     GROUP BY reference_id "
                "    HAVING COUNT(DISTINCT organization_id) <> 1) x) "
                "    AS mixed_organizations, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id FROM transfer_rows "
                "     WHERE reference_id IS NOT NULL "
                "     GROUP BY reference_id "
                "    HAVING COUNT(DISTINCT item_id) <> 1) x) "
                "    AS mixed_items"
            )
        ).one()
        (
            null_ref,
            wrong_ref_type,
            non_transfer_using_ref,
            dup_roles,
            incomplete,
            mixed_orgs,
            mixed_items,
        ) = pre
        if any((
            null_ref, wrong_ref_type, non_transfer_using_ref,
            dup_roles, incomplete, mixed_orgs, mixed_items,
        )):
            raise RuntimeError(
                "Sprint 5.4.10 migration 0009 aborted: malformed "
                "transfer topology present — "
                f"transfer_rows_with_null_reference={null_ref}, "
                f"transfer_rows_with_wrong_reference_type={wrong_ref_type}, "
                f"non_transfer_rows_using_transfer_reference="
                f"{non_transfer_using_ref}, "
                f"duplicate_roles={dup_roles}, "
                f"incomplete_pairs={incomplete}, "
                f"mixed_organizations={mixed_orgs}, "
                f"mixed_items={mixed_items}. "
                "Repair the offending rows before re-running the "
                "migration. This is intentional: partial migrations "
                "would produce an invalid post-migration topology."
            )

        # 1. Column.
        op.execute(
            "ALTER TABLE inventory_transactions "
            "ADD COLUMN IF NOT EXISTS transfer_group_id UUID"
        )
    else:
        op.execute(
            "ALTER TABLE inventory_transactions ADD COLUMN transfer_group_id UUID"
        )

    op.create_index(
        "ix_inventory_transactions_transfer_group_id",
        "inventory_transactions",
        ["transfer_group_id"],
        unique=False,
    )

    # 2. Back-fill. Sprint 5.4.10 §4 — ONLY transfer-role rows may
    #    receive a transfer_group_id. Non-transfer rows that happen
    #    to share reference_type='transfer' would have been caught
    #    by the pre-flight and forced the migration to abort.
    op.execute(
        "UPDATE inventory_transactions "
        "SET transfer_group_id = reference_id "
        "WHERE transaction_type IN ('transfer_out', 'transfer_in') "
        "  AND reference_type = 'transfer' "
        "  AND reference_id IS NOT NULL "
        "  AND transfer_group_id IS NULL"
    )

    if dialect == "postgresql":
        # 3. Topology-enforcing partial unique index.
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_tx_transfer_role "
            "ON inventory_transactions (transfer_group_id, transaction_type) "
            "WHERE transfer_group_id IS NOT NULL "
            "  AND transaction_type IN ('transfer_out', 'transfer_in')"
        )
        # 4. Canonical DDL — installs BOTH the identity-contract
        #    trigger (BEFORE INSERT OR UPDATE) and the deferred
        #    pair-completeness constraint trigger (AFTER, DEFERRABLE
        #    INITIALLY DEFERRED). Shared with
        #    ``Base.metadata.create_all`` via
        #    ``app.db.inventory_transfer_ddl`` — one canonical
        #    definition, no divergence.
        for stmt in install_all_sql():
            op.execute(stmt)
    else:
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_tx_transfer_role "
            "ON inventory_transactions (transfer_group_id, transaction_type) "
            "WHERE transfer_group_id IS NOT NULL "
            "  AND transaction_type IN ('transfer_out', 'transfer_in')"
        )


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "postgresql":
        op.execute(
            "DROP TRIGGER IF EXISTS trg_inventory_tx_pair_complete "
            "ON inventory_transactions"
        )
        op.execute("DROP FUNCTION IF EXISTS inventory_transactions_pair_complete()")
        op.execute(
            "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable "
            "ON inventory_transactions"
        )
        op.execute("DROP FUNCTION IF EXISTS inventory_transactions_group_immutable()")
    op.execute("DROP INDEX IF EXISTS uq_inventory_tx_transfer_role")
    op.drop_index(
        "ix_inventory_transactions_transfer_group_id",
        table_name="inventory_transactions",
    )
    op.drop_column("inventory_transactions", "transfer_group_id")
