"""Sprint 5.4.10 — Canonical DDL for transfer-topology enforcement.

Single source of truth for the PostgreSQL objects that enforce the
inventory-transfer topology contract. Imported by:

* ``app.models.inventory`` — installed automatically on
  ``Base.metadata.create_all`` via a SQLAlchemy DDL event
  (hermetic test path).
* ``alembic.versions.0009_transfer_group_id`` — installed at
  migration upgrade time (production / CI).

Having ONE definition prevents divergence between the two paths.

Objects installed
-----------------
Function ``inventory_transactions_group_immutable()`` +
trigger ``trg_inventory_tx_group_immutable`` (``BEFORE INSERT OR
UPDATE ROW``) enforces the full transfer-identity contract:

* **INSERT** — transfer rows must have non-null
  ``transfer_group_id``, ``reference_type = 'transfer'``, and
  ``reference_id = transfer_group_id``. Non-transfer rows must
  have ``transfer_group_id = NULL``.
* **UPDATE** — ``transfer_group_id`` cannot change; on transfer
  rows ``reference_id`` cannot diverge from ``transfer_group_id``;
  ``reference_type`` cannot change away from ``'transfer'``;
  ``transaction_type`` cannot change from a transfer role to a
  non-transfer role nor between the two transfer roles;
  non-transfer rows cannot be turned into transfer rows by
  UPDATE (transfer identity is INSERT-only).

Function ``inventory_transactions_pair_complete()`` +
constraint trigger ``trg_inventory_tx_pair_complete``
(``AFTER INSERT OR UPDATE OR DELETE``, ``DEFERRABLE INITIALLY
DEFERRED``) enforces PAIR COMPLETENESS at COMMIT time. Every
``transfer_group_id`` that has any activity in the current
transaction must, at commit time, resolve to EXACTLY one
``TRANSFER_OUT`` and one ``TRANSFER_IN`` row sharing the same
``organization_id`` and ``item_id``. Prevents:

* OUT only
* IN only
* two OUT (already caught by the partial unique index)
* two IN (idem)
* mismatched organization / item between pair members
"""

from __future__ import annotations

# ---------------------------------------------------------------- #
# BEFORE INSERT OR UPDATE trigger — identity contract.              #
# ---------------------------------------------------------------- #
TRANSFER_IMMUTABLE_FN_SQL = (
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
    "  IF OLD.transaction_type IN ('transfer_out', 'transfer_in') "
    "     AND NEW.transaction_type NOT IN ('transfer_out', 'transfer_in') THEN "
    "    RAISE EXCEPTION 'transfer rows cannot be reclassified to a non-transfer type' "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  IF OLD.transaction_type NOT IN ('transfer_out', 'transfer_in') "
    "     AND NEW.transaction_type IN ('transfer_out', 'transfer_in') THEN "
    "    RAISE EXCEPTION 'non-transfer rows cannot be reclassified as transfer rows by UPDATE' "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  IF OLD.transaction_type IN ('transfer_out', 'transfer_in') "
    "     AND NEW.transaction_type IN ('transfer_out', 'transfer_in') "
    "     AND OLD.transaction_type IS DISTINCT FROM NEW.transaction_type THEN "
    "    RAISE EXCEPTION 'transfer role (OUT/IN) is immutable' "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  IF NEW.transaction_type IN ('transfer_out', 'transfer_in') THEN "
    "    IF NEW.reference_type IS DISTINCT FROM 'transfer' THEN "
    "      RAISE EXCEPTION 'transfer rows must retain reference_type=transfer' "
    "        USING ERRCODE = 'integrity_constraint_violation'; "
    "    END IF; "
    "    IF NEW.reference_id IS DISTINCT FROM NEW.transfer_group_id THEN "
    "      RAISE EXCEPTION 'transfer reference_id and transfer_group_id must match' "
    "        USING ERRCODE = 'integrity_constraint_violation'; "
    "    END IF; "
    "    IF OLD.reference_id IS DISTINCT FROM NEW.reference_id THEN "
    "      RAISE EXCEPTION 'transfer reference_id is immutable' "
    "        USING ERRCODE = 'integrity_constraint_violation'; "
    "    END IF; "
    "  END IF; "
    "  RETURN NEW; "
    "END; "
    "$$ LANGUAGE plpgsql"
)

TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable "
    "ON inventory_transactions"
)

TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL = (
    "CREATE TRIGGER trg_inventory_tx_group_immutable "
    "BEFORE INSERT OR UPDATE ON inventory_transactions "
    "FOR EACH ROW EXECUTE FUNCTION inventory_transactions_group_immutable()"
)

# ---------------------------------------------------------------- #
# AFTER INSERT/UPDATE/DELETE deferred constraint trigger —          #
# pair completeness at COMMIT time.                                 #
# ---------------------------------------------------------------- #
TRANSFER_PAIR_COMPLETE_FN_SQL = (
    "CREATE OR REPLACE FUNCTION inventory_transactions_pair_complete() "
    "RETURNS TRIGGER AS $$ "
    "DECLARE "
    "  target UUID; "
    "  out_count INT; "
    "  in_count INT; "
    "  distinct_orgs INT; "
    "  distinct_items INT; "
    "BEGIN "
    "  IF TG_OP = 'DELETE' THEN "
    "    target := OLD.transfer_group_id; "
    "  ELSE "
    "    target := NEW.transfer_group_id; "
    "  END IF; "
    "  IF target IS NULL THEN "
    "    RETURN NULL; "
    "  END IF; "
    "  SELECT "
    "    COUNT(*) FILTER (WHERE transaction_type = 'transfer_out'), "
    "    COUNT(*) FILTER (WHERE transaction_type = 'transfer_in'), "
    "    COUNT(DISTINCT organization_id), "
    "    COUNT(DISTINCT item_id) "
    "    INTO out_count, in_count, distinct_orgs, distinct_items "
    "    FROM inventory_transactions "
    "   WHERE transfer_group_id = target; "
    "  IF out_count = 0 AND in_count = 0 THEN "
    "    RETURN NULL; "
    "  END IF; "
    "  IF out_count <> 1 OR in_count <> 1 THEN "
    "    RAISE EXCEPTION 'transfer group %% must have exactly one OUT and one IN at commit (found out=%%, in=%%)', target, out_count, in_count "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  IF distinct_orgs <> 1 THEN "
    "    RAISE EXCEPTION 'transfer group %% spans multiple organizations at commit', target "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  IF distinct_items <> 1 THEN "
    "    RAISE EXCEPTION 'transfer group %% spans multiple items at commit', target "
    "      USING ERRCODE = 'integrity_constraint_violation'; "
    "  END IF; "
    "  RETURN NULL; "
    "END; "
    "$$ LANGUAGE plpgsql"
)

TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS trg_inventory_tx_pair_complete "
    "ON inventory_transactions"
)

TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL = (
    "CREATE CONSTRAINT TRIGGER trg_inventory_tx_pair_complete "
    "AFTER INSERT OR UPDATE OR DELETE ON inventory_transactions "
    "DEFERRABLE INITIALLY DEFERRED "
    "FOR EACH ROW EXECUTE FUNCTION inventory_transactions_pair_complete()"
)


def install_all_sql() -> list[str]:
    """Return the ordered list of DDL statements to install every
    transfer-topology PostgreSQL object. Callers execute them in
    order against a PostgreSQL connection.
    """
    return [
        TRANSFER_IMMUTABLE_FN_SQL,
        TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL,
        TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL,
        TRANSFER_PAIR_COMPLETE_FN_SQL,
        TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL,
        TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL,
    ]


__all__ = [
    "TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL",
    "TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL",
    "TRANSFER_IMMUTABLE_FN_SQL",
    "TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL",
    "TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL",
    "TRANSFER_PAIR_COMPLETE_FN_SQL",
    "install_all_sql",
]
