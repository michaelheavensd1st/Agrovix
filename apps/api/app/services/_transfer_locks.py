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
advisory lock keyed deterministically on the LOGICAL transfer
identity ``(organization_id, reference_type, reference_id)``.

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

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def advisory_lock_key_for_transfer(
    organization_id: uuid.UUID,
    reference_type: str,
    reference_id: uuid.UUID,
) -> int:
    """Return the deterministic signed BIGINT lock key for a transfer.

    Composition:
      * canonical input =
        ``"inventory-transfer:{org_id}:{reference_type}:{reference_id}"``
      * SHA-256 digest (32 bytes);
      * take the first 8 bytes (big-endian) as an UNSIGNED 64-bit int;
      * reduce into PostgreSQL's signed BIGINT range
        ``[-2^63, 2^63 - 1]`` by subtracting ``2^63`` when the top
        bit is set. This preserves determinism while remaining a
        valid ``bigint`` value for ``pg_advisory_xact_lock``.

    Collision probability is dominated by the 64-bit truncation:
    ~2^32 concurrent DISTINCT transfer identities before a birthday
    collision is likely. Real workloads are many orders of magnitude
    below that; a collision would merely serialise two unrelated
    transfers, not corrupt state.
    """
    canonical = (
        f"inventory-transfer:{organization_id}:{reference_type}:{reference_id}"
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    as_unsigned = int.from_bytes(digest[:8], byteorder="big", signed=False)
    # Map to signed BIGINT range.
    if as_unsigned >= (1 << 63):
        return as_unsigned - (1 << 64)
    return as_unsigned


async def acquire_transfer_advisory_lock(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    reference_type: str,
    reference_id: uuid.UUID,
) -> int:
    """Acquire the transaction-scoped advisory lock for a transfer.

    Emits ``SELECT pg_advisory_xact_lock(:key)`` on PostgreSQL and
    blocks until the lock is granted. Returns the numeric lock key
    used, which callers may log for observability.

    On non-PostgreSQL dialects (SQLite unit-test path) this is a
    no-op — SQLite serialises writers via the StaticPool, so the
    invariant the advisory lock enforces (only one writer inside
    the topology for a given identity) holds by construction.

    The lock is released automatically when the outer transaction
    commits or rolls back. Callers MUST hold this lock for the
    entire duration of the topology-mutating work.
    """
    key = advisory_lock_key_for_transfer(
        organization_id, reference_type, reference_id
    )
    bind = session.bind
    dialect = bind.dialect.name if bind is not None else ""
    if dialect != "postgresql":
        return key
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": key},
    )
    return key


__all__ = [
    "acquire_transfer_advisory_lock",
    "advisory_lock_key_for_transfer",
]
