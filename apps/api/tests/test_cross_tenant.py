"""Cross-tenant isolation tests.

Two disjoint organizations. For every relevant endpoint we verify that
a member of ``Alpha`` can never see, modify, delete, restore or audit
anything belonging to ``Beta`` — even when they know the exact UUIDs.

The tests deliberately use 404 as the "resource not found or not
authorized" shape so that we do not leak whether a resource exists in
another tenant (see ``get_current_organization`` / ``get_current_farm``
in ``deps.py``).
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from tests._helpers import (
    create_farm,
    create_org,
    create_verified_user,
    switch_user,
)


async def _two_tenants(client: AsyncClient) -> dict:
    alpha_owner = f"alpha-{uuid4().hex[:8]}@agrovix.dev"
    beta_owner = f"beta-{uuid4().hex[:8]}@agrovix.dev"
    for email in (alpha_owner, beta_owner):
        await create_verified_user(email)

    await switch_user(client, alpha_owner)
    alpha_org = await create_org(client, name="Alpha Co")
    alpha_farm = await create_farm(client, alpha_org, name="Alpha Farm")

    await switch_user(client, beta_owner)
    beta_org = await create_org(client, name="Beta Co")
    beta_farm = await create_farm(client, beta_org, name="Beta Farm")

    return {
        "alpha_owner": alpha_owner,
        "beta_owner": beta_owner,
        "alpha_org": alpha_org,
        "alpha_farm": alpha_farm,
        "beta_org": beta_org,
        "beta_farm": beta_farm,
    }


@pytest.mark.asyncio
async def test_alpha_cannot_read_beta_org_or_farm(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])

    # Beta organization → 404 (not found or not member)
    r = await client.get(f"/api/v1/organizations/{t['beta_org']}")
    assert r.status_code == 404

    # Beta farm → 404
    r = await client.get(f"/api/v1/farms/{t['beta_farm']}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alpha_cannot_list_beta_farms(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])
    r = await client.get(f"/api/v1/organizations/{t['beta_org']}/farms")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alpha_cannot_update_beta_farm(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])
    r = await client.patch(
        f"/api/v1/farms/{t['beta_farm']}",
        json={"name": "Owned!"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alpha_cannot_delete_or_restore_beta_farm(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])

    r = await client.delete(f"/api/v1/farms/{t['beta_farm']}")
    assert r.status_code == 404, r.text

    # Now let beta owner delete their own farm — then alpha still can't restore it.
    await switch_user(client, t["beta_owner"])
    r = await client.delete(f"/api/v1/farms/{t['beta_farm']}")
    assert r.status_code == 200

    await switch_user(client, t["alpha_owner"])
    r = await client.post(f"/api/v1/farms/{t['beta_farm']}/restore")
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_alpha_cannot_invite_into_beta(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])
    r = await client.post(
        f"/api/v1/organizations/{t['beta_org']}/invitations",
        json={"email": "someone@example.com", "role_name": "worker", "farm_id": t["beta_farm"]},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alpha_cannot_read_beta_audit_events(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    await switch_user(client, t["alpha_owner"])
    r = await client.get(f"/api/v1/organizations/{t['beta_org']}/audit-events")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alpha_cannot_assign_or_revoke_roles_in_beta(client: AsyncClient) -> None:
    t = await _two_tenants(client)
    # Alpha's own user id — try to slip in as a beta member via the assignment endpoint.
    from sqlalchemy import select

    from app.db import session as _db
    from app.models.user import User

    async with _db.AsyncSessionLocal() as session:
        alpha_user = (
            await session.execute(select(User).where(User.email == t["alpha_owner"]))
        ).scalar_one()

    await switch_user(client, t["alpha_owner"])
    r = await client.post(
        f"/api/v1/organizations/{t['beta_org']}/role-assignments",
        json={"user_id": str(alpha_user.id), "role_name": "worker", "farm_id": t["beta_farm"]},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_beta_audit_events_only_show_beta_actions(client: AsyncClient) -> None:
    """Sanity: audit list is strictly scoped to the requested organization."""
    t = await _two_tenants(client)
    # Alpha owner: read alpha events
    await switch_user(client, t["alpha_owner"])
    r = await client.get(f"/api/v1/organizations/{t['alpha_org']}/audit-events")
    assert r.status_code == 200
    for event in r.json()["items"]:
        # organization_id in the event must match the URL scope.
        assert event["organization_id"] == t["alpha_org"]
