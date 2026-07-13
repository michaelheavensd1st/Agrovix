"""Farm soft-delete + restore lifecycle tests."""

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


@pytest.mark.asyncio
async def test_soft_delete_hides_farm_from_normal_queries(client: AsyncClient) -> None:
    owner = f"owner-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    # Baseline — farm is visible.
    r = await client.get(f"/api/v1/organizations/{org_id}/farms")
    assert r.status_code == 200
    assert any(f["id"] == farm_id for f in r.json())
    r = await client.get(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200

    # Soft delete.
    r = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is False

    # List no longer includes it.
    r = await client.get(f"/api/v1/organizations/{org_id}/farms")
    assert r.status_code == 200
    assert all(f["id"] != farm_id for f in r.json())

    # Direct read returns 404 (tenant-leak-safe shape).
    r = await client.get(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_deleted_farm_rejects_new_invitations(client: AsyncClient) -> None:
    owner = f"deletehost-{uuid4().hex[:8]}@agrovix.dev"
    invitee = f"invitee-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await create_verified_user(invitee)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    # Delete the farm...
    r = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200

    # ...then try to invite someone to it → 409.
    r = await client.post(
        f"/api/v1/organizations/{org_id}/invitations",
        json={"email": invitee, "role_name": "farm_manager", "farm_id": farm_id},
    )
    assert r.status_code == 409
    assert "deleted farm" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_restore_reactivates_the_farm(client: AsyncClient) -> None:
    owner = f"restore-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    r = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200

    r = await client.post(f"/api/v1/farms/{farm_id}/restore")
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is True

    # Farm reappears in listings.
    r = await client.get(f"/api/v1/organizations/{org_id}/farms")
    assert r.status_code == 200
    assert any(f["id"] == farm_id for f in r.json())


@pytest.mark.asyncio
async def test_delete_and_restore_are_idempotent(client: AsyncClient) -> None:
    owner = f"idem-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)

    # Delete twice: 2nd delete returns 404 (farm already hidden).
    r1 = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r1.status_code == 200
    r2 = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r2.status_code == 404

    # Restore is available; restore twice returns 200 both times.
    r3 = await client.post(f"/api/v1/farms/{farm_id}/restore")
    assert r3.status_code == 200
    r4 = await client.post(f"/api/v1/farms/{farm_id}/restore")
    assert r4.status_code == 200
    assert r4.json()["is_active"] is True


@pytest.mark.asyncio
async def test_restore_requires_permission(client: AsyncClient) -> None:
    owner = f"restoreperm-{uuid4().hex[:8]}@agrovix.dev"
    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await create_verified_user(outsider)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_id = await create_farm(client, org_id)
    r = await client.delete(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200

    # Outsider tries to restore → 403 (permission) — but they can't even
    # tell it exists, so a 404 is also acceptable. Either way, no leak.
    await switch_user(client, outsider)
    r = await client.post(f"/api/v1/farms/{farm_id}/restore")
    assert r.status_code in (403, 404)
