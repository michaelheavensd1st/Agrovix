"""Scoped effective-permission contract for ``GET /auth/me``."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.security import create_token, hash_password
from app.db import session as db_session_module
from app.models.farm import Farm
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User


@pytest.mark.asyncio
async def test_me_returns_only_active_scoped_permissions(
    client: AsyncClient,
) -> None:
    async with db_session_module.AsyncSessionLocal() as session:
        user = User(
            email=f"scoped-{uuid4().hex[:8]}@agrovix.dev",
            hashed_password=hash_password("ScopedPermissions!2026"),
            is_active=True,
            is_verified=True,
        )
        org = Organization(name="Authorized Org", slug=f"authorized-{uuid4().hex[:8]}")
        other_org = Organization(name="Other Org", slug=f"other-{uuid4().hex[:8]}")
        session.add_all([user, org, other_org])
        await session.flush()

        farm = Farm(organization_id=org.id, name="Authorized Farm", code="AUTH")
        other_farm = Farm(organization_id=other_org.id, name="Other Farm", code="OTHER")
        revoked_farm = Farm(organization_id=org.id, name="Revoked Farm", code="REVOKED")
        session.add_all([farm, other_farm, revoked_farm])
        await session.flush()

        session.add_all(
            [
                OrganizationMembership(user_id=user.id, organization_id=org.id),
                OrganizationMembership(
                    user_id=user.id,
                    organization_id=other_org.id,
                    is_active=False,
                    deleted_at=datetime.now(UTC),
                ),
                FarmMembership(user_id=user.id, farm_id=farm.id),
                FarmMembership(user_id=user.id, farm_id=other_farm.id),
                FarmMembership(user_id=user.id, farm_id=revoked_farm.id),
            ]
        )

        org_owner = (
            await session.execute(select(Role).where(Role.name == "organization_owner"))
        ).scalar_one()
        farm_manager = (
            await session.execute(select(Role).where(Role.name == "farm_manager"))
        ).scalar_one()
        session.add_all(
            [
                RoleAssignment(
                    user_id=user.id,
                    role_id=org_owner.id,
                    organization_id=org.id,
                ),
                RoleAssignment(
                    user_id=user.id,
                    role_id=farm_manager.id,
                    organization_id=org.id,
                    farm_id=farm.id,
                ),
                RoleAssignment(
                    user_id=user.id,
                    role_id=org_owner.id,
                    organization_id=other_org.id,
                ),
                RoleAssignment(
                    user_id=user.id,
                    role_id=farm_manager.id,
                    organization_id=other_org.id,
                    farm_id=other_farm.id,
                ),
                RoleAssignment(
                    user_id=user.id,
                    role_id=farm_manager.id,
                    organization_id=org.id,
                    farm_id=revoked_farm.id,
                    revoked_at=datetime.now(UTC),
                ),
            ]
        )
        await session.commit()
        user_id = user.id
        org_id = org.id
        other_org_id = other_org.id
        farm_id = farm.id
        other_farm_id = other_farm.id
        revoked_farm_id = revoked_farm.id

    token, _ = create_token(subject=user_id, token_type="access")
    response = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["permissions"] == []

    scopes = {
        (scope["organization_id"], scope["farm_id"]): set(scope["permissions"])
        for scope in body["permission_scopes"]
    }
    assert "production_unit.create" in scopes[(str(org_id), None)]
    assert "production_batch.create" in scopes[(str(org_id), str(farm_id))]
    assert (str(other_org_id), None) not in scopes
    assert (str(other_org_id), str(other_farm_id)) not in scopes
    assert (str(org_id), str(revoked_farm_id)) not in scopes


@pytest.mark.asyncio
async def test_me_preserves_superuser_permissions(
    client: AsyncClient,
) -> None:
    async with db_session_module.AsyncSessionLocal() as session:
        user = User(
            email=f"super-{uuid4().hex[:8]}@agrovix.dev",
            hashed_password=hash_password("SuperuserPermissions!2026"),
            is_active=True,
            is_verified=True,
            is_superuser=True,
        )
        session.add(user)
        await session.commit()
        user_id = user.id

    token, _ = create_token(subject=user_id, token_type="access")
    response = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    assert set(response.json()["permissions"]) == {"*", "platform.admin"}
    assert response.json()["permission_scopes"] == []
