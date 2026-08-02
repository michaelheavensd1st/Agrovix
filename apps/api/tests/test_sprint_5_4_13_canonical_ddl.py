"""Sprint 5.4.13 — Canonical DDL regression tests.

Locks in the Sprint 5.4.10 canonical transfer-topology DDL so any
accidental drift (added / removed / reworded object, altered
install order, altered trigger semantics) is caught at test time
BEFORE it can regress the production database.

Every assertion below has a one-to-one correspondence with a
Sprint 5.4.10 review requirement — see the ``__doc__`` string on
:mod:`app.db.inventory_transfer_ddl` for the human-readable
contract.
"""

from __future__ import annotations

import pytest

from app.db.inventory_transfer_ddl import (
    TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL,
    TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL,
    TRANSFER_IMMUTABLE_FN_SQL,
    TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL,
    TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL,
    TRANSFER_PAIR_COMPLETE_FN_SQL,
    install_all_sql,
)

# ------------------------------------------------------------------ #
# install_all_sql() — ordered six-statement contract.                #
# ------------------------------------------------------------------ #


def test_install_all_sql_returns_exactly_six_statements() -> None:
    """Sprint 5.4.13 — ``install_all_sql`` MUST return the SAME six
    statements in the SAME order that Sprint 5.4.10 originally
    installed. Any drift (added, removed, or reordered element)
    fails this test.
    """
    stmts = install_all_sql()
    assert len(stmts) == 6, f"install_all_sql must emit exactly 6 statements, got {len(stmts)}"
    assert stmts == [
        TRANSFER_IMMUTABLE_FN_SQL,
        TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL,
        TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL,
        TRANSFER_PAIR_COMPLETE_FN_SQL,
        TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL,
        TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL,
    ]


def test_install_all_sql_statement_ordering() -> None:
    """Drop-before-create discipline: within each object, drop MUST
    precede create; and within the six-tuple the immutability
    trigger MUST install before the pair-completeness trigger so
    an INSERT of a bad row is rejected by the identity contract
    before the pair-completeness constraint runs.
    """
    stmts = install_all_sql()
    idx_imm_fn = stmts.index(TRANSFER_IMMUTABLE_FN_SQL)
    idx_imm_drop = stmts.index(TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL)
    idx_imm_create = stmts.index(TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL)
    idx_pair_fn = stmts.index(TRANSFER_PAIR_COMPLETE_FN_SQL)
    idx_pair_drop = stmts.index(TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL)
    idx_pair_create = stmts.index(TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL)
    assert idx_imm_fn < idx_imm_drop < idx_imm_create
    assert idx_pair_fn < idx_pair_drop < idx_pair_create
    assert idx_imm_create < idx_pair_fn


# ------------------------------------------------------------------ #
# Immutability trigger — full INSERT + UPDATE contracts.             #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "phrase",
    [
        # Object identity — MUST be the exact function name Sprint
        # 5.4.10 pinned; any rename cascades through 0009, 0010,
        # and the after_create event.
        "CREATE OR REPLACE FUNCTION inventory_transactions_group_immutable()",
        # INSERT contract.
        "IF TG_OP = 'INSERT'",
        "NEW.transaction_type IN ('transfer_out', 'transfer_in')",
        "transfer_group_id is required for transfer rows",
        "transfer rows must have reference_type=transfer",
        "transfer_group_id must equal reference_id",
        "transfer_group_id may only be set on transfer rows",
        # UPDATE contract. (The function returns early on INSERT
        # via ``RETURN NEW``, so the remainder — everything after
        # the ``IF TG_OP = 'INSERT'`` block — is the UPDATE path.)
        "transfer_group_id is immutable once set",
        "transfer rows cannot be reclassified to a non-transfer type",
        "non-transfer rows cannot be reclassified as transfer rows by UPDATE",
        "transfer role (OUT/IN) is immutable",
        "transfer rows must retain reference_type=transfer",
        "transfer reference_id and transfer_group_id must match",
        "transfer reference_id is immutable",
        # PL/pgSQL scaffolding — the trigger must actually run.
        "RETURN NEW",
        "LANGUAGE plpgsql",
    ],
)
def test_immutable_trigger_function_contains(phrase: str) -> None:
    """Every phrase above encodes one Sprint 5.4.10 rule. If any
    phrase is missing, the corresponding rule is either gone or
    reworded — both count as regressions.
    """
    assert phrase in TRANSFER_IMMUTABLE_FN_SQL, (
        f"regression: canonical immutability trigger no longer contains "
        f"the Sprint 5.4.10 rule {phrase!r}"
    )


def test_immutable_trigger_wiring() -> None:
    """The CREATE TRIGGER statement MUST reinstall the trigger as
    ``BEFORE INSERT OR UPDATE`` on ``inventory_transactions`` for
    EACH ROW, executing our canonical function. Any deviation
    (e.g. AFTER, missing OR UPDATE) is a regression.
    """
    stmt = TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL
    assert "CREATE TRIGGER trg_inventory_tx_group_immutable" in stmt
    assert "BEFORE INSERT OR UPDATE ON inventory_transactions" in stmt
    assert "FOR EACH ROW" in stmt
    assert "EXECUTE FUNCTION inventory_transactions_group_immutable()" in stmt
    # Drop is idempotent.
    assert (
        "DROP TRIGGER IF EXISTS trg_inventory_tx_group_immutable"
        in TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL
    )


# ------------------------------------------------------------------ #
# Deferred pair-completeness constraint trigger.                     #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "phrase",
    [
        "CREATE OR REPLACE FUNCTION inventory_transactions_pair_complete()",
        # It MUST look at BOTH new-row targets and old-row (DELETE)
        # targets — otherwise a DELETE could leave an orphan pair
        # member.
        "IF TG_OP = 'DELETE'",
        "target := OLD.transfer_group_id",
        "target := NEW.transfer_group_id",
        # Exactly-one-OUT / exactly-one-IN.
        "COUNT(*) FILTER (WHERE transaction_type = 'transfer_out')",
        "COUNT(*) FILTER (WHERE transaction_type = 'transfer_in')",
        "must have exactly one OUT and one IN at commit",
        # Pair organization + item consistency.
        "COUNT(DISTINCT organization_id)",
        "COUNT(DISTINCT item_id)",
        "spans multiple organizations at commit",
        "spans multiple items at commit",
        # Restart guard — a fully drained group returns NULL.
        "IF out_count = 0 AND in_count = 0 THEN",
        "LANGUAGE plpgsql",
    ],
)
def test_pair_complete_function_contains(phrase: str) -> None:
    assert phrase in TRANSFER_PAIR_COMPLETE_FN_SQL, (
        f"regression: canonical pair-completeness function no longer "
        f"contains the Sprint 5.4.10 rule {phrase!r}"
    )


def test_pair_complete_raise_placeholders_are_executable_postgresql_sql() -> None:
    """PL/pgSQL ``RAISE`` uses one ``%`` per supplied argument.

    Doubling these placeholders is not SQLAlchemy escaping: it reaches
    PostgreSQL as literal double-percent text and makes function creation
    fail with ``too many parameters specified for RAISE``.
    """
    raise_lines = [
        fragment
        for fragment in TRANSFER_PAIR_COMPLETE_FN_SQL.split("; ")
        if "RAISE EXCEPTION" in fragment
    ]
    assert [line.count("%") for line in raise_lines] == [3, 1, 1]
    assert all("%%" not in line for line in raise_lines)


def test_pair_complete_trigger_is_deferrable_constraint_trigger() -> None:
    """DEFERRABLE INITIALLY DEFERRED constraint trigger is
    load-bearing: Sprint 5.4.10 depends on the pair-completeness
    check running at COMMIT time so an in-progress transaction
    that inserts OUT-then-IN is not falsely rejected mid-flight.
    Downgrading to an immediate trigger would break the atomic
    ledger contract.
    """
    stmt = TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL
    assert "CREATE CONSTRAINT TRIGGER trg_inventory_tx_pair_complete" in stmt
    assert "AFTER INSERT OR UPDATE OR DELETE ON inventory_transactions" in stmt
    assert "DEFERRABLE INITIALLY DEFERRED" in stmt
    assert "FOR EACH ROW" in stmt
    assert "EXECUTE FUNCTION inventory_transactions_pair_complete()" in stmt
    # Drop is idempotent.
    assert (
        "DROP TRIGGER IF EXISTS trg_inventory_tx_pair_complete"
        in TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL
    )


# ------------------------------------------------------------------ #
# Consumers — both metadata bootstrap AND alembic migrations MUST    #
# call install_all_sql().                                            #
# ------------------------------------------------------------------ #


def test_metadata_event_uses_canonical_ddl() -> None:
    """``Base.metadata.create_all`` MUST install the transfer
    triggers from the canonical DDL constants — Sprint 5.4.13
    forbids inline / drifted copies in ``app.models.inventory``.
    """
    import pathlib

    inventory_py = pathlib.Path(__file__).parent.parent / "app" / "models" / "inventory.py"
    src = inventory_py.read_text()
    # The exact import from the canonical module is present.
    assert "from app.db.inventory_transfer_ddl import (" in src
    for constant in (
        "TRANSFER_IMMUTABLE_FN_SQL",
        "TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL",
        "TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL",
        "TRANSFER_PAIR_COMPLETE_FN_SQL",
        "TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL",
        "TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL",
    ):
        assert constant in src, f"regression: models/inventory.py no longer imports {constant}"
    # Guard against anyone silently disabling the DDL event.
    assert 'execute_if(dialect="postgresql")' in src
    assert 'DDL(_statement.replace("%", "%%"))' in src


def test_alembic_0009_reconciles_against_canonical_ddl() -> None:
    """Migration 0009 MUST install the canonical DDL via
    ``install_all_sql()``. Any hard-coded SQL block that would
    let 0009 drift is caught by this assertion.
    """
    import pathlib

    path = (
        pathlib.Path(__file__).parent.parent / "alembic" / "versions" / "0009_transfer_group_id.py"
    )
    src = path.read_text()
    assert "from app.db.inventory_transfer_ddl import install_all_sql" in src
    assert "for stmt in install_all_sql():" in src
    assert "op.execute(stmt)" in src


def test_alembic_0010_reconciles_against_canonical_ddl() -> None:
    """Sprint 5.4.12 migration 0010 MUST also reconcile against
    the canonical DDL, not a private copy.
    """
    import pathlib

    path = (
        pathlib.Path(__file__).parent.parent
        / "alembic"
        / "versions"
        / "0010_sprint_5_4_12_reconcile_ddl.py"
    )
    src = path.read_text()
    assert "from app.db.inventory_transfer_ddl import install_all_sql" in src
    assert "for stmt in install_all_sql():" in src


def test_public_surface_stable() -> None:
    """``__all__`` on the canonical DDL module MUST expose every
    constant + ``install_all_sql``. Removing an export would
    break downstream imports.
    """
    from app.db import inventory_transfer_ddl as mod

    for name in (
        "TRANSFER_IMMUTABLE_FN_SQL",
        "TRANSFER_IMMUTABLE_DROP_TRIGGER_SQL",
        "TRANSFER_IMMUTABLE_CREATE_TRIGGER_SQL",
        "TRANSFER_PAIR_COMPLETE_FN_SQL",
        "TRANSFER_PAIR_COMPLETE_DROP_TRIGGER_SQL",
        "TRANSFER_PAIR_COMPLETE_CREATE_TRIGGER_SQL",
        "install_all_sql",
    ):
        assert name in mod.__all__, f"regression: {name} removed from __all__"
