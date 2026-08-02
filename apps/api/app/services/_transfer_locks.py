"""Sprint 5.4.7 — transfer-topology advisory-lock helpers.

The Sprint 5.4.6 sequence acquires row-level ``FOR UPDATE`` locks on
the two participating transaction rows, but that is insufficient to
serialise CHANGES TO TOPOLOGY: under PostgreSQL READ COMMITTED, a
concurrent ``INSERT`` (or a matching ``UPDATE`` of ``reference_type``
/ ``reference_id``) can introduce a THIRD row into the same logical
transfer identity between our unlocked discovery step and the write
phase.

To close that phantom-row hole every writer of TRANSFER_OUT /
TRANSFER_IN rows — the two-row ``transfer()`` insert AND the
reversal-context builder — acquires a PostgreSQL transaction-scoped
advisory lock keyed deterministically on the IMMUTABLE transfer
group identity ``transfer_group_id`` (Sprint 5.4.8). Sprint 5.4.7's
original design keyed the lock on the mutable
``(organization_id, reference_type, reference_id)`` triple; Sprint
5.4.8 replaced that with the immutable ``transfer_group_id`` column
so a hostile UPDATE of any tenant field cannot alter the key.

Design constraints from the sprint brief:

* transaction-scoped (``pg_advisory_xact_lock``);
* released automatically at commit / rollback;
* deterministic for the same identity;
* NOT dependent on Python's randomised ``hash()``;
* negligible collision risk (SHA-256 digest, 63-bit truncated for
  PostgreSQL's signed BIGINT lock keyspace).

SQLite unit-tests: the helpers are no-ops. Concurrency proofs for
this behaviour therefore live under ``@_postgres_only``.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Sequence
from typing import TypeVar

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def advisory_lock_key_for_transfer_group(transfer_group_id: uuid.UUID) -> int:
    """Sprint 5.4.8 — deterministic signed BIGINT key from the
    IMMUTABLE ``transfer_group_id`` column. No tenant fields
    participate in the key derivation, so the key cannot drift
    under concurrent tenant reassignment.
    """
    canonical = f"inventory-transfer-group:{transfer_group_id}"
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    as_unsigned = int.from_bytes(digest[:8], byteorder="big", signed=False)
    if as_unsigned >= (1 << 63):
        return as_unsigned - (1 << 64)
    return as_unsigned


def advisory_lock_key_for_transfer(
    organization_id: uuid.UUID,
    reference_type: str,
    reference_id: uuid.UUID,
) -> int:
    """Legacy Sprint 5.4.7 key derivation.

    Retained for backwards compatibility with the Sprint 5.4.7 test
    that pins the exact algorithm. Callers writing new code should
    use :func:`advisory_lock_key_for_transfer_group` instead.
    """
    canonical = (
        f"inventory-transfer:{organization_id}:{reference_type}:{reference_id}"
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    as_unsigned = int.from_bytes(digest[:8], byteorder="big", signed=False)
    if as_unsigned >= (1 << 63):
        return as_unsigned - (1 << 64)
    return as_unsigned


async def acquire_transfer_advisory_lock(
    session: AsyncSession,
    *,
    transfer_group_id: uuid.UUID,
) -> int:
    """Acquire the transaction-scoped advisory lock for a transfer.

    Sprint 5.4.8 — keyed on the IMMUTABLE ``transfer_group_id`` so
    no tenant field mutation can alter the key. Emits
    ``SELECT pg_advisory_xact_lock(:key)`` on PostgreSQL. No-op on
    SQLite (StaticPool serialises writers).
    """
    key = advisory_lock_key_for_transfer_group(transfer_group_id)
    bind = session.bind
    dialect = bind.dialect.name if bind is not None else ""
    if dialect != "postgresql":
        return key
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": key},
    )
    return key


T = TypeVar("T")


def require_exactly_one(
    rows: Sequence[T],
    *,
    resource: str,
    identifier: uuid.UUID | str,
) -> T:
    """Sprint 5.4.8 — safe cardinality enforcement.

    Replaces the ``[row] = repo.list_by_ids_for_update([id])``
    destructuring pattern that raises ``ValueError`` on 0 or ≥ 2
    rows. On unexpected cardinality we surface a controlled domain
    error:

    * empty → 404 with a stable diagnostic (missing resource);
    * more than one → 409 integrity error (impossible duplicate);
    * exactly one → the row.
    """
    if not rows:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {
                "code": f"{resource}_not_found",
                "message": f"{resource.replace('_', ' ').capitalize()} was not found under lock.",
                "resource": resource,
                "id": str(identifier),
            },
        )
    if len(rows) > 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": f"{resource}_integrity_violation",
                "message": (
                    f"Expected exactly one {resource} row under lock, "
                    f"found {len(rows)}; refusing to proceed."
                ),
                "resource": resource,
                "id": str(identifier),
                "count": len(rows),
            },
        )
    return rows[0]


def require_set_equality(
    rows: Sequence,
    *,
    resource: str,
    requested_ids: set[uuid.UUID],
) -> None:
    """Sprint 5.4.8 — assert the locked set matches the requested set.

    Raises HTTP 409 with an ``integrity_violation`` diagnostic
    naming the missing and unexpected ids so the caller can trace
    the mismatch. Never returns partial data silently.
    """
    returned_ids = {row.id for row in rows}
    if returned_ids != requested_ids:
        missing = sorted(requested_ids - returned_ids, key=str)
        unexpected = sorted(returned_ids - requested_ids, key=str)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": f"{resource}_set_mismatch",
                "message": (
                    f"Locked {resource} set does not match the requested "
                    "ids; refusing to proceed."
                ),
                "resource": resource,
                "missing_ids": [str(x) for x in missing],
                "unexpected_ids": [str(x) for x in unexpected],
            },
        )


__all__ = [
    "acquire_transfer_advisory_lock",
    "advisory_lock_key_for_transfer",
    "advisory_lock_key_for_transfer_group",
    "require_exactly_one",
    "require_set_equality",
]
