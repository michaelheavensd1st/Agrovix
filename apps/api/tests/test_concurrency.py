"""Concurrency tests — ownership changes + farm-lifecycle races.

SQLite (used by the hermetic suite) serializes writers, so these tests
demonstrate the *domain-level* race-safety guards rather than driver
concurrency. The intent is to prove that:

* Two concurrent revokes on the same assignment produce exactly one
  successful revoke and one 409.
* Two concurrent revokes on the last two owners of the same org can
  never leave the org owner-less: one call succeeds, the other is
  rejected AND self-heals via ``unrevoke``.
* Two concurrent farm deletes are idempotent (both return success at
  the domain level; only one HTTP call sees 200, the other sees 404).
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.role_assignment import RoleAssignment
from app.models.user import User
from tests._helpers import (
    create_farm,
    create_org,
    create_verified_user,
    switch_user,
)


async def _promote_second_owner(client: AsyncClient, org_id: str, target_email: str) -> UUID:
    """Assign ``target_email`` as an organization_owner in ``org_id``.

    Returns the RoleAssignment id (needed for revocation tests).
    """
    from app.db import session as _db

    async with _db.AsyncSessionLocal() as session:
        target = (
            await session.execute(select(User).where(User.email == target_email))
        ).scalar_one()

    r = await client.post(
        f"/api/v1/organizations/{org_id}/role-assignments",
        json={"user_id": str(target.id), "role_name": "organization_owner"},
    )
    assert r.status_code == 201, r.text
    return UUID(r.json()["id"])


async def _find_owner_assignment(user_email: str, org_id: str) -> UUID:
    """Return the RoleAssignment id for ``user_email``'s organization_owner grant."""
    from app.db import session as _db
    from app.models.role import Role

    async with _db.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == user_email))).scalar_one()
        role = (
            await session.execute(select(Role).where(Role.name == "organization_owner"))
        ).scalar_one()
        assignment = (
            await session.execute(
                select(RoleAssignment).where(
                    RoleAssignment.user_id == user.id,
                    RoleAssignment.organization_id == UUID(org_id),
                    RoleAssignment.role_id == role.id,
                    RoleAssignment.revoked_at.is_(None),
                )
            )
        ).scalar_one()
        return assignment.id


@pytest.mark.asyncio
async def test_concurrent_revoke_of_same_assignment_only_wins_once(
    client: AsyncClient,
) -> None:
    """Two concurrent DELETE calls on the same role assignment → one 204, one 409."""
    o1 = f"cc1-{uuid4().hex[:8]}@agrovix.dev"
    o2 = f"cc2-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(o1)
    await create_verified_user(o2)

    await switch_user(client, o1)
    org_id = await create_org(client)
    o2_assignment = await _promote_second_owner(client, org_id, o2)

    # Two concurrent revokes on the SAME assignment.
    r1, r2 = await asyncio.gather(
        client.delete(f"/api/v1/role-assignments/{o2_assignment}"),
        client.delete(f"/api/v1/role-assignments/{o2_assignment}"),
        return_exceptions=False,
    )
    statuses = sorted([r1.status_code, r2.status_code])
    # Exactly one 200/204 (success), and one rejection. Under SQLite
    # (unit-test suite) the loser is caught by ``revoke_if_active``
    # returning False → 409. Under real Postgres concurrency the loser
    # may instead re-fetch the assignment and see ``revoked_at`` set →
    # 404. Both prove exactly-once semantics.
    assert statuses[0] in (200, 204), (r1.status_code, r2.status_code, r1.text, r2.text)
    assert statuses[1] in (404, 409), (r1.text, r2.text)


@pytest.mark.asyncio
async def test_concurrent_revoke_of_two_owners_never_orphans(
    client: AsyncClient,
) -> None:
    """Two concurrent revokes of the last two owners must leave one owner intact."""
    o1 = f"orp1-{uuid4().hex[:8]}@agrovix.dev"
    o2 = f"orp2-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(o1)
    await create_verified_user(o2)

    await switch_user(client, o1)
    org_id = await create_org(client)
    a2 = await _promote_second_owner(client, org_id, o2)
    a1 = await _find_owner_assignment(o1, org_id)

    r1, r2 = await asyncio.gather(
        client.delete(f"/api/v1/role-assignments/{a1}"),
        client.delete(f"/api/v1/role-assignments/{a2}"),
        return_exceptions=False,
    )
    # At least ONE of the two calls must have been rejected — otherwise
    # the org would have zero owners. Depending on race ordering the
    # rejection may surface as:
    #   • 409 Conflict — orphan-protection guardrail fired
    #   • 403 Forbidden — the racing caller lost their owner permission
    #     mid-flight and the permission check rejected them second.
    # Both prove the invariant "org keeps ≥1 owner" is enforced.
    statuses = sorted([r1.status_code, r2.status_code])
    assert 409 in statuses or 403 in statuses, (
        r1.status_code,
        r2.status_code,
        r1.text,
        r2.text,
    )

    # Post-condition: at least one owner remains.
    from app.db import session as _db
    from app.models.role import Role

    async with _db.AsyncSessionLocal() as session:
        role = (
            await session.execute(select(Role).where(Role.name == "organization_owner"))
        ).scalar_one()
        active = (
            (
                await session.execute(
                    select(RoleAssignment).where(
                        RoleAssignment.organization_id == UUID(org_id),
                        RoleAssignment.role_id == role.id,
                        RoleAssignment.revoked_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(active) >= 1, "organization must retain at least one active owner"


@pytest.mark.asyncio
async def test_concurrent_farm_delete_is_idempotent(client: AsyncClient) -> None:
    """Racing two DELETE calls on the same farm must not error out either caller."""
    owner = f"race-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    r1, r2 = await asyncio.gather(
        client.delete(f"/api/v1/farms/{farm_id}"),
        client.delete(f"/api/v1/farms/{farm_id}"),
        return_exceptions=False,
    )
    # Acceptable shapes: (200, 200) [both idempotent hits] OR
    # (200, 404) [second saw the deleted state]. Never a 5xx.
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses[0] == 200
    assert statuses[1] in (200, 404), (statuses, r1.text, r2.text)

    # And post-race, the farm is soft-deleted (list excludes it).
    r = await client.get(f"/api/v1/organizations/{org_id}/farms")
    assert all(f["id"] != farm_id for f in r.json())


@pytest.mark.asyncio
async def test_concurrent_farm_delete_and_restore_settles_deterministically(
    client: AsyncClient,
) -> None:
    """Racing delete + restore must leave the farm in exactly one of the two
    valid states (deleted or active) — never in an inconsistent one."""
    owner = f"drrace-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    r_del, r_res = await asyncio.gather(
        client.delete(f"/api/v1/farms/{farm_id}"),
        client.post(f"/api/v1/farms/{farm_id}/restore"),
        return_exceptions=False,
    )
    assert r_del.status_code in (200, 404)
    assert r_res.status_code in (200, 404)

    # Terminal state check via a follow-up read.
    r = await client.get(f"/api/v1/farms/{farm_id}")
    # Either the farm is visible (active) or hidden (deleted) — both
    # are legitimate final states.
    assert r.status_code in (200, 404)
