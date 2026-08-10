"""Authorization contract for the organization-owned inventory catalog."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.db import session as db_session_module
from app.models.membership import FarmMembership
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from tests._helpers import (
    create_farm,
    create_org,
    create_verified_user,
    invite_and_accept,
    switch_user,
)

pytestmark = pytest.mark.asyncio


async def _create_item(client: AsyncClient, organization_id: str, *, code: str) -> dict:
    response = await client.post(
        f"/api/v1/organizations/{organization_id}/inventory-items",
        json={
            "code": code,
            "name": f"Catalog item {code}",
            "category": "feed",
            "canonical_unit": "kg",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _create_warehouse(client: AsyncClient, organization_id: str, farm_id: str) -> dict:
    response = await client.post(
        f"/api/v1/organizations/{organization_id}/warehouses",
        json={
            "name": "Catalog authorization warehouse",
            "code": f"WH-{uuid4().hex[:8]}",
            "farm_id": farm_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _owner_org_and_farms(client: AsyncClient) -> dict[str, str]:
    owner = f"catalog-owner-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    organization_id = await create_org(client, slug=f"catalog-{uuid4().hex[:8]}")
    farm_a_id = await create_farm(client, organization_id, name="Catalog Farm A")
    farm_b_id = await create_farm(client, organization_id, name="Catalog Farm B")
    return {
        "owner": owner,
        "organization_id": organization_id,
        "farm_a_id": farm_a_id,
        "farm_b_id": farm_b_id,
    }


async def test_organization_scoped_inventory_reader_retains_catalog_access(
    client: AsyncClient,
) -> None:
    setup = await _owner_org_and_farms(client)
    item = await _create_item(client, setup["organization_id"], code="ORG-READ")
    reader = f"catalog-viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(reader)
    await invite_and_accept(
        client,
        inviter_email=setup["owner"],
        invitee_email=reader,
        org_id=setup["organization_id"],
        role_name="viewer",
    )

    response = await client.get(f"/api/v1/organizations/{setup['organization_id']}/inventory-items")

    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()] == [item["id"]]


async def test_same_org_farm_scoped_inventory_reader_can_read_catalog_once(
    client: AsyncClient,
) -> None:
    setup = await _owner_org_and_farms(client)
    first = await _create_item(client, setup["organization_id"], code="FARM-READ-1")
    second = await _create_item(client, setup["organization_id"], code="FARM-READ-2")
    reader = f"catalog-supervisor-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(reader)
    await invite_and_accept(
        client,
        inviter_email=setup["owner"],
        invitee_email=reader,
        org_id=setup["organization_id"],
        role_name="supervisor",
        farm_id=setup["farm_a_id"],
    )

    # A second qualifying farm grant in the same organization must not
    # duplicate organization-owned catalog rows.
    async with db_session_module.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == reader))).scalar_one()
        role = (await session.execute(select(Role).where(Role.name == "supervisor"))).scalar_one()
        session.add_all(
            [
                FarmMembership(user_id=user.id, farm_id=UUID(setup["farm_b_id"])),
                RoleAssignment(
                    user_id=user.id,
                    role_id=role.id,
                    organization_id=UUID(setup["organization_id"]),
                    farm_id=UUID(setup["farm_b_id"]),
                ),
            ]
        )
        await session.commit()

    response = await client.get(f"/api/v1/organizations/{setup['organization_id']}/inventory-items")

    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()} == {first["id"], second["id"]}
    assert len(response.json()) == 2


async def test_farm_scoped_grant_in_another_org_does_not_expose_target_catalog(
    client: AsyncClient,
) -> None:
    source = await _owner_org_and_farms(client)
    reader = f"catalog-cross-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(reader)
    await invite_and_accept(
        client,
        inviter_email=source["owner"],
        invitee_email=reader,
        org_id=source["organization_id"],
        role_name="supervisor",
        farm_id=source["farm_a_id"],
    )

    target_owner = f"catalog-target-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(target_owner)
    await switch_user(client, target_owner)
    target_org_id = await create_org(client, slug=f"catalog-target-{uuid4().hex[:8]}")
    await _create_item(client, target_org_id, code="TARGET-HIDDEN")
    await switch_user(client, reader)

    response = await client.get(f"/api/v1/organizations/{target_org_id}/inventory-items")

    assert response.status_code == 404, response.text


async def test_same_org_user_without_inventory_read_is_forbidden(
    client: AsyncClient,
) -> None:
    setup = await _owner_org_and_farms(client)
    user_email = f"catalog-no-read-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(user_email)
    await invite_and_accept(
        client,
        inviter_email=setup["owner"],
        invitee_email=user_email,
        org_id=setup["organization_id"],
        role_name="farm_manager",
        farm_id=setup["farm_a_id"],
    )

    async with db_session_module.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == user_email))).scalar_one()
        assignment = (
            await session.execute(
                select(RoleAssignment).where(
                    RoleAssignment.user_id == user.id,
                    RoleAssignment.farm_id == UUID(setup["farm_a_id"]),
                )
            )
        ).scalar_one()
        assignment.revoked_at = assignment.created_at
        session.add(assignment)
        await session.commit()

    response = await client.get(f"/api/v1/organizations/{setup['organization_id']}/inventory-items")

    assert response.status_code == 403, response.text


async def test_farm_catalog_read_does_not_widen_inventory_writes(
    client: AsyncClient,
) -> None:
    setup = await _owner_org_and_farms(client)
    item = await _create_item(client, setup["organization_id"], code="READ-ONLY")
    warehouse = await _create_warehouse(client, setup["organization_id"], setup["farm_a_id"])
    reader = f"catalog-worker-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(reader)
    await invite_and_accept(
        client,
        inviter_email=setup["owner"],
        invitee_email=reader,
        org_id=setup["organization_id"],
        role_name="worker",
        farm_id=setup["farm_a_id"],
    )

    catalog_response = await client.get(
        f"/api/v1/organizations/{setup['organization_id']}/inventory-items"
    )
    create_response = await client.post(
        f"/api/v1/organizations/{setup['organization_id']}/inventory-items",
        json={
            "code": "WRITE-DENIED",
            "name": "Write denied",
            "category": "feed",
            "canonical_unit": "kg",
        },
    )
    stock_response = await client.post(
        f"/api/v1/warehouses/{warehouse['id']}/inventory:receive",
        json={
            "item_id": item["id"],
            "lot_code": "DENIED-LOT",
            "quantity": 1,
            "unit": "kg",
        },
    )

    assert catalog_response.status_code == 200, catalog_response.text
    assert create_response.status_code == 403, create_response.text
    assert stock_response.status_code == 403, stock_response.text
