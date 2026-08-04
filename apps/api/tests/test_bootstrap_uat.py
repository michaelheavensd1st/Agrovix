"""Safety and idempotency tests for the persistent UAT bootstrap command."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app.core.config import Settings
from app.core.security import hash_password
from app.models.farm import Farm
from app.models.inventory import InventoryItem, InventoryLot, InventoryTransaction, Warehouse
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.production import ProductionBatch, ProductionSite, ProductionUnit
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from app.repositories.user_repo import UserRepository
from app.scripts.bootstrap_uat import (
    BATCH_CODE,
    FARM_CODE,
    ORG_SLUG,
    UNIT_CODE,
    BootstrapConfig,
    BootstrapRefusedError,
    bootstrap_uat,
    config_from_environment,
)

CONFIG = BootstrapConfig(
    email="uat-bootstrap@example.com",
    password="UAT-bootstrap-password-123!",
    organization_name="Bootstrap UAT Org",
    farm_name="Bootstrap UAT Farm",
)


async def _count(session, model) -> int:
    return int((await session.execute(select(func.count()).select_from(model))).scalar_one())


async def test_first_run_creates_required_records(db_session) -> None:
    summary = await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="development"))
    await db_session.commit()

    assert summary.records["user"] == "created"
    assert summary.records["organization"] == "created"
    assert summary.records["farm"] == "created"
    assert summary.records["production unit"] == "created"
    assert summary.records["production batch"] == "created (planned)"
    assert summary.records["feed warehouse"] == "created"
    assert summary.records["feed inventory item"] == "created"
    assert summary.records["feed inventory lot"] == "created (100 kg)"

    user = (await db_session.execute(select(User).where(User.email == CONFIG.email))).scalar_one()
    assert user.is_active is True
    assert user.is_verified is True
    assert user.is_superuser is False
    assert user.hashed_password != CONFIG.password

    org = (
        await db_session.execute(select(Organization).where(Organization.slug == ORG_SLUG))
    ).scalar_one()
    farm = (
        await db_session.execute(
            select(Farm).where(Farm.organization_id == org.id, Farm.code == FARM_CODE)
        )
    ).scalar_one()
    site = (
        await db_session.execute(select(ProductionSite).where(ProductionSite.farm_id == farm.id))
    ).scalar_one()
    unit = (
        await db_session.execute(
            select(ProductionUnit).where(
                ProductionUnit.site_id == site.id, ProductionUnit.code == UNIT_CODE
            )
        )
    ).scalar_one()
    batch = (
        await db_session.execute(
            select(ProductionBatch).where(
                ProductionBatch.unit_id == unit.id, ProductionBatch.code == BATCH_CODE
            )
        )
    ).scalar_one()
    assert batch.state.value == "planned"


async def test_second_run_creates_no_duplicates(db_session) -> None:
    await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="development"))
    await db_session.commit()
    before = {
        model: await _count(db_session, model)
        for model in (
            User,
            Organization,
            Farm,
            ProductionSite,
            ProductionUnit,
            ProductionBatch,
            Warehouse,
            InventoryItem,
            InventoryLot,
            InventoryTransaction,
        )
    }

    summary = await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="development"))
    await db_session.commit()

    after = {model: await _count(db_session, model) for model in before}
    assert after == before
    assert all(not status.startswith("created") for status in summary.records.values())


async def test_existing_user_is_preserved(db_session) -> None:
    existing_config = BootstrapConfig(
        email="existing-uat-bootstrap@example.com",
        password=CONFIG.password,
        organization_name=CONFIG.organization_name,
        farm_name=CONFIG.farm_name,
    )
    original_hash = hash_password("Existing-user-password-456!")
    user = await UserRepository(db_session).create(
        email=existing_config.email,
        hashed_password=original_hash,
        full_name="Existing Name",
    )
    user.is_active = True
    user.is_verified = True
    await db_session.commit()

    summary = await bootstrap_uat(
        db_session, existing_config, settings=Settings(app_env="development")
    )
    await db_session.commit()
    await db_session.refresh(user)

    assert summary.records["user"] == "existing"
    assert user.hashed_password == original_hash
    assert user.full_name == "Existing Name"


async def test_production_environment_is_rejected_without_writes(db_session) -> None:
    before = await _count(db_session, User)
    with pytest.raises(BootstrapRefusedError, match="disabled in production"):
        await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="production"))
    assert await _count(db_session, User) == before


def test_missing_password_fails_safely() -> None:
    with pytest.raises(BootstrapRefusedError, match="AGROVIX_UAT_PASSWORD is required"):
        config_from_environment({"AGROVIX_UAT_EMAIL": CONFIG.email})


async def test_permissions_and_tenant_relationships_are_correct(db_session) -> None:
    await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="development"))
    await db_session.commit()

    user = (await db_session.execute(select(User).where(User.email == CONFIG.email))).scalar_one()
    org = (
        await db_session.execute(select(Organization).where(Organization.slug == ORG_SLUG))
    ).scalar_one()
    farm = (
        await db_session.execute(
            select(Farm).where(Farm.organization_id == org.id, Farm.code == FARM_CODE)
        )
    ).scalar_one()
    org_membership = (
        await db_session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.organization_id == org.id,
            )
        )
    ).scalar_one()
    farm_membership = (
        await db_session.execute(
            select(FarmMembership).where(
                FarmMembership.user_id == user.id, FarmMembership.farm_id == farm.id
            )
        )
    ).scalar_one()
    assignment = (
        await db_session.execute(
            select(RoleAssignment)
            .join(Role, Role.id == RoleAssignment.role_id)
            .where(
                RoleAssignment.user_id == user.id,
                RoleAssignment.organization_id == org.id,
                RoleAssignment.farm_id.is_(None),
                RoleAssignment.revoked_at.is_(None),
                Role.name == "organization_owner",
            )
        )
    ).scalar_one()

    assert org_membership.is_active is True
    assert farm_membership.is_active is True
    assert assignment.organization_id == org.id
    owner_role = (
        await db_session.execute(select(Role).where(Role.name == "organization_owner"))
    ).scalar_one()
    assert "production_event.create" in {permission.code for permission in owner_role.permissions}

    org_membership.deleted_at = datetime.now(UTC)
    await db_session.commit()
    with pytest.raises(BootstrapRefusedError, match="membership is inactive or deleted"):
        await bootstrap_uat(db_session, CONFIG, settings=Settings(app_env="development"))
