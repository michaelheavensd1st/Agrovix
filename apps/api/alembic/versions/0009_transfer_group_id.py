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

revision: str = "0009_transfer_group_id"
down_revision: str | None = "0008_wh_maintenance"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

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
        # 4. Immutability trigger — after a transfer_group_id is
        #    set, it cannot be UPDATEd. Insertions with any value
        #    (including NULL) are allowed.
        op.execute(
            """
            CREATE OR REPLACE FUNCTION inventory_transactions_group_immutable()
            RETURNS TRIGGER AS $$
            BEGIN
                IF OLD.transfer_group_id IS NOT NULL
                   AND NEW.transfer_group_id IS DISTINCT FROM OLD.transfer_group_id
                THEN
                    RAISE EXCEPTION 'transfer_group_id is immutable once set'
                        USING ERRCODE = 'integrity_constraint_violation';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            """
        )
        op.execute(
            "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable "
            "ON inventory_transactions"
        )
        op.execute(
            "CREATE TRIGGER trg_inventory_tx_group_immutable "
            "BEFORE UPDATE ON inventory_transactions "
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
