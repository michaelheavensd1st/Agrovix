"""Sprint 5.4.8 — Immutable transfer_group_id + topology constraint.

Adds:
  * ``inventory_transactions.transfer_group_id`` column
    (nullable, indexed);
  * partial unique index ``uq_inventory_tx_transfer_role`` enforcing
    at most one ``TRANSFER_OUT`` and one ``TRANSFER_IN`` per group;
  * PostgreSQL trigger blocking mutation of a non-null
    ``transfer_group_id`` (immutable-after-set);
  * backfill: for every existing pair sharing
    ``reference_type = 'transfer'``, copy ``reference_id`` into the
    new column so legacy transfers can still be reversed under the
    new advisory-lock protocol.

Downgrade removes the trigger, the index, and the column.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text as _sa_text

revision: str = "0009_transfer_group_id"
down_revision: str | None = "0008_wh_maintenance"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Sprint 5.4.9 — pre-flight malformed-topology detection. If
    # pre-existing rows would violate the constraints we are about
    # to create, abort with an explicit diagnostic. Never leave a
    # partially migrated topology behind.
    if dialect == "postgresql":
        malformed = bind.execute(
            _sa_text(
                "WITH transfer_rows AS ("
                "  SELECT id, transaction_type, reference_id, reference_type "
                "  FROM inventory_transactions "
                "  WHERE transaction_type IN ('transfer_out', 'transfer_in')"
                ") "
                "SELECT "
                "  (SELECT COUNT(*) FROM transfer_rows "
                "    WHERE reference_id IS NULL "
                "       OR reference_type IS DISTINCT FROM 'transfer') AS orphans, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id, transaction_type, COUNT(*) c "
                "      FROM transfer_rows WHERE reference_id IS NOT NULL "
                "      GROUP BY reference_id, transaction_type "
                "     HAVING COUNT(*) > 1) x) AS duplicate_roles, "
                "  (SELECT COUNT(*) FROM ("
                "    SELECT reference_id FROM transfer_rows "
                "     WHERE reference_id IS NOT NULL "
                "     GROUP BY reference_id HAVING COUNT(*) <> 2) x) AS incomplete_pairs"
            )
        ).one()
        orphans, dup_roles, incomplete = malformed
        if orphans or dup_roles or incomplete:
            raise RuntimeError(
                "Sprint 5.4.9 migration 0009 aborted: malformed transfer "
                f"topology present — orphan_transfer_rows={orphans}, "
                f"duplicate_roles={dup_roles}, incomplete_pairs={incomplete}. "
                "Repair the offending rows before re-running the migration."
            )

    # 1. Column.
    op.execute(
        "ALTER TABLE inventory_transactions "
        "ADD COLUMN IF NOT EXISTS transfer_group_id UUID"
        if dialect == "postgresql"
        else "ALTER TABLE inventory_transactions ADD COLUMN transfer_group_id UUID"
    )
    op.create_index(
        "ix_inventory_transactions_transfer_group_id",
        "inventory_transactions",
        ["transfer_group_id"],
        unique=False,
    )

    # 2. Backfill from reference_id for existing transfer pairs.
    op.execute(
        "UPDATE inventory_transactions "
        "SET transfer_group_id = reference_id "
        "WHERE reference_type = 'transfer' "
        "  AND reference_id IS NOT NULL "
        "  AND transfer_group_id IS NULL"
    )

    # 3. Topology-enforcing partial unique index.
    if dialect == "postgresql":
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_tx_transfer_role "
            "ON inventory_transactions (transfer_group_id, transaction_type) "
            "WHERE transfer_group_id IS NOT NULL "
            "  AND transaction_type IN ('transfer_out', 'transfer_in')"
        )
        # 4. Sprint 5.4.9 comprehensive trigger — enforces:
        #    - transfer rows are BORN with a non-null group_id;
        #    - non-transfer rows must NOT carry a group_id;
        #    - reference_id must equal transfer_group_id on transfer
        #      rows (coupling; prevents divergence);
        #    - reference_type must be 'transfer' on transfer rows;
        #    - transfer_group_id is immutable after INSERT.
        op.execute(
            "CREATE OR REPLACE FUNCTION inventory_transactions_group_immutable() "
            "RETURNS TRIGGER AS $$ "
            "BEGIN "
            "  IF TG_OP = 'INSERT' THEN "
            "    IF NEW.transaction_type IN ('transfer_out', 'transfer_in') THEN "
            "      IF NEW.transfer_group_id IS NULL THEN "
            "        RAISE EXCEPTION 'transfer_group_id is required for transfer rows' "
            "          USING ERRCODE = 'not_null_violation'; "
            "      END IF; "
            "      IF NEW.reference_type IS DISTINCT FROM 'transfer' THEN "
            "        RAISE EXCEPTION 'transfer rows must have reference_type=transfer' "
            "          USING ERRCODE = 'integrity_constraint_violation'; "
            "      END IF; "
            "      IF NEW.reference_id IS NULL OR NEW.reference_id != NEW.transfer_group_id THEN "
            "        RAISE EXCEPTION 'transfer_group_id must equal reference_id' "
            "          USING ERRCODE = 'integrity_constraint_violation'; "
            "      END IF; "
            "    ELSIF NEW.transfer_group_id IS NOT NULL THEN "
            "      RAISE EXCEPTION 'transfer_group_id may only be set on transfer rows' "
            "        USING ERRCODE = 'integrity_constraint_violation'; "
            "    END IF; "
            "    RETURN NEW; "
            "  END IF; "
            "  IF OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id THEN "
            "    RAISE EXCEPTION 'transfer_group_id is immutable once set' "
            "      USING ERRCODE = 'integrity_constraint_violation'; "
            "  END IF; "
            "  IF NEW.transaction_type IN ('transfer_out', 'transfer_in') "
            "     AND NEW.reference_id IS DISTINCT FROM NEW.transfer_group_id THEN "
            "    RAISE EXCEPTION 'transfer reference_id and transfer_group_id must match' "
            "      USING ERRCODE = 'integrity_constraint_violation'; "
            "  END IF; "
            "  RETURN NEW; "
            "END; "
            "$$ LANGUAGE plpgsql"
        )
        op.execute(
            "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable "
            "ON inventory_transactions"
        )
        op.execute(
            "CREATE TRIGGER trg_inventory_tx_group_immutable "
            "BEFORE INSERT OR UPDATE ON inventory_transactions "
            "FOR EACH ROW EXECUTE FUNCTION inventory_transactions_group_immutable()"
        )
    else:
        # SQLite — partial unique index works too.
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
        op.execute("DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable ON inventory_transactions")
        op.execute("DROP FUNCTION IF EXISTS inventory_transactions_group_immutable()")
    op.execute("DROP INDEX IF EXISTS uq_inventory_tx_transfer_role")
    op.drop_index(
        "ix_inventory_transactions_transfer_group_id",
        table_name="inventory_transactions",
    )
    op.drop_column("inventory_transactions", "transfer_group_id")
