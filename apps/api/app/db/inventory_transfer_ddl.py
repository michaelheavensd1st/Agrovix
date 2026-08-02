"""Canonical PostgreSQL DDL for inventory transfer topology invariants."""

from __future__ import annotations

TRANSFER_GROUP_IMMUTABLE_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION inventory_transactions_group_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.transaction_type IN ('transfer_out', 'transfer_in') THEN
      IF NEW.transfer_group_id IS NULL THEN
        RAISE EXCEPTION 'transfer_group_id is required for transfer rows'
          USING ERRCODE = 'not_null_violation';
      END IF;
      IF NEW.reference_type IS DISTINCT FROM 'transfer' THEN
        RAISE EXCEPTION 'transfer rows must have reference_type=transfer'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.reference_id IS NULL OR NEW.reference_id != NEW.transfer_group_id THEN
        RAISE EXCEPTION 'transfer_group_id must equal reference_id'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF NEW.transfer_group_id IS NOT NULL THEN
      RAISE EXCEPTION 'transfer_group_id may only be set on transfer rows'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id THEN
    RAISE EXCEPTION 'transfer_group_id is immutable once set'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.transaction_type IN ('transfer_out', 'transfer_in')
     AND NEW.reference_id IS DISTINCT FROM NEW.transfer_group_id THEN
    RAISE EXCEPTION 'transfer reference_id and transfer_group_id must match'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
""".strip()

DROP_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable "
    "ON inventory_transactions"
)

CREATE_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL = (
    "CREATE TRIGGER trg_inventory_tx_group_immutable "
    "BEFORE INSERT OR UPDATE ON inventory_transactions "
    "FOR EACH ROW EXECUTE FUNCTION inventory_transactions_group_immutable()"
)


def install_all_sql() -> tuple[str, str, str]:
    """Return the complete, ordered, idempotent trigger installation."""
    return (
        TRANSFER_GROUP_IMMUTABLE_FUNCTION_SQL,
        DROP_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL,
        CREATE_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL,
    )


__all__ = [
    "CREATE_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL",
    "DROP_TRANSFER_GROUP_IMMUTABLE_TRIGGER_SQL",
    "TRANSFER_GROUP_IMMUTABLE_FUNCTION_SQL",
    "install_all_sql",
]
