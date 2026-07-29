"""Sprint 5.4.12 — Authorization-serialisation advisory-lock protocol.

Every code path that *reads* authoritative authorization state
(``organization_memberships``, ``farm_memberships``,
``role_assignments``, ``roles``, ``role_permissions``) OR *mutates*
that state MUST first acquire the transaction-scoped PostgreSQL
advisory lock produced by :func:`acquire_org_authorization_lock`
for every participating ``organization_id``. The lock provides a
strictly serialised authorization epoch keyed per-organization:

* Transaction A holds the lock → transaction B blocks on
  ``pg_advisory_xact_lock`` until A commits or rolls back.
* Two organizations are independent — a lock on org X does not
  block org Y.
* Release is automatic (commit / rollback) — no leak on error.
* SQLite: the helpers are no-ops (StaticPool already serialises
  writers). Concurrency proofs run under ``@_postgres_only``.

Key derivation is a signed BIGINT from a SHA-256 digest of a
protocol-scoped string. The prefix ``authorization-org:`` cannot
collide with the transfer-group key namespace
(``inventory-transfer-group:`` / ``inventory-transfer:``) even if
the same UUID were reused across both domains.

Design intent
=============
* One canonical helper — no key derivation duplicated across
  services.
* Callers pass the ``organization_id`` in ascending UUID order
  when acquiring multiple locks (see
  :func:`acquire_org_authorization_locks`). Deterministic order
  eliminates AB / BA deadlocks between callers.
* The lock is orthogonal to row FOR UPDATE locks — it exists to
  serialise the *reads* used to derive authorization scopes and
  the *writes* that change those scopes. It does NOT replace the
  Sprint 5.4.6/5.4.7 warehouse / farm / organization row locks.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def advisory_lock_key_for_org_authorization(organization_id: uuid.UUID) -> int:
    """Deterministic signed BIGINT key for one organization's
    authorization epoch. Not intercompatible with transfer-group
    advisory keys — different string prefix, disjoint namespaces.
    """
    canonical = f"authorization-org:{organization_id}"
    digest = hashlib.sha256(canonical.encode("utf-8")).digest()
    as_unsigned = int.from_bytes(digest[:8], byteorder="big", signed=False)
    if as_unsigned >= (1 << 63):
        return as_unsigned - (1 << 64)
    return as_unsigned


async def acquire_org_authorization_lock(
    session: AsyncSession,
    organization_id: uuid.UUID,
) -> int:
    """Acquire the transaction-scoped authorization advisory lock
    for a single organization. Returns the derived key so callers
    can log / assert if needed.

    On non-PostgreSQL dialects this is a no-op — SQLite already
    serialises writers via its single-connection StaticPool.
    """
    key = advisory_lock_key_for_org_authorization(organization_id)
    bind = session.bind
    dialect = bind.dialect.name if bind is not None else ""
    if dialect != "postgresql":
        return key
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": key},
    )
    return key


async def acquire_org_authorization_locks(
    session: AsyncSession,
    organization_ids: Iterable[uuid.UUID],
) -> list[int]:
    """Acquire the authorization advisory lock for every distinct
    organization id in ``organization_ids``. Locks are acquired in
    ascending ``UUID`` order so two callers coordinating on
    overlapping org sets can never form an AB / BA deadlock cycle.

    Returns the list of derived keys in acquisition order.
    """
    distinct_ids = sorted({oid for oid in organization_ids}, key=str)  # noqa: C416
    keys: list[int] = []
    for oid in distinct_ids:
        keys.append(await acquire_org_authorization_lock(session, oid))
    return keys


__all__ = [
    "acquire_org_authorization_lock",
    "acquire_org_authorization_locks",
    "advisory_lock_key_for_org_authorization",
]
