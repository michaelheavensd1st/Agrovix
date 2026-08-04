"""Idempotently bootstrap the minimum persistent data needed for browser UAT.

This command is deliberately unavailable in production. It never deletes,
truncates, or rewrites an existing domain record; matching records are reused
only when they already satisfy the UAT invariants.
"""

from __future__ import annotations

import asyncio
import getpass
import os
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.security import hash_password
from app.db.session import AsyncSessionLocal
from app.models.farm import Farm
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.production import (
    ProductionBatch,
    ProductionBatchState,
    ProductionSite,
    ProductionSiteStatus,
    ProductionUnit,
    ProductionUnitStatus,
    ProductionUnitType,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.org_repo import (
    FarmMembershipRepository,
    FarmRepository,
    OrganizationMembershipRepository,
    OrganizationRepository,
)
from app.repositories.production import (
    ProductionBatchRepository,
    ProductionBatchTransitionRepository,
    ProductionSiteRepository,
    ProductionUnitRepository,
    ProductionUnitTypeRepository,
)
from app.repositories.role_repo import RoleAssignmentRepository, RoleRepository
from app.repositories.user_repo import UserRepository
from app.seed import seed_permissions_and_roles
from app.services.organization_service import FarmService, OrganizationService
from app.services.production import (
    ProductionBatchService,
    ProductionSiteService,
    ProductionUnitService,
)

DEFAULT_EMAIL = "michael.h@tgcorps.com"
DEFAULT_ORG_NAME = "Agrovix UAT"
DEFAULT_FARM_NAME = "Agrovix UAT Farm"
ORG_SLUG = "agrovix-uat"
FARM_CODE = "UAT-FARM"
SITE_CODE = "MAIN"
UNIT_CODE = "UAT-UNIT"
BATCH_CODE = "UAT-BATCH"
UNIT_TYPE_CODE = "GROW_OUT_POND"

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_REQUEST_CTX = {
    "ip_address": None,
    "user_agent": "agrovix-uat-bootstrap",
    "request_id": None,
}


class BootstrapRefusedError(RuntimeError):
    """Raised when bootstrapping would be unsafe or overwrite existing data."""


@dataclass(frozen=True)
class BootstrapConfig:
    email: str
    password: str
    organization_name: str
    farm_name: str


@dataclass
class BootstrapSummary:
    records: dict[str, str] = field(default_factory=dict)

    def mark(self, record: str, status: str) -> None:
        self.records[record] = status

    def print(self) -> None:
        print("Agrovix UAT bootstrap complete:")
        for record, status in self.records.items():
            print(f"- {record}: {status}")


def config_from_environment(
    environ: Mapping[str, str] | None = None,
    *,
    password_prompt: Callable[[str], str] | None = None,
) -> BootstrapConfig:
    env = os.environ if environ is None else environ
    email = env.get("AGROVIX_UAT_EMAIL", DEFAULT_EMAIL).strip().lower()
    if not _EMAIL_RE.match(email):
        raise BootstrapRefusedError("AGROVIX_UAT_EMAIL is not a valid email address.")

    password = env.get("AGROVIX_UAT_PASSWORD", "")
    if not password:
        if password_prompt is None:
            raise BootstrapRefusedError(
                "AGROVIX_UAT_PASSWORD is required when no secure interactive prompt is available."
            )
        password = password_prompt("UAT password: ")
    if not password:
        raise BootstrapRefusedError("The UAT password cannot be empty.")

    return BootstrapConfig(
        email=email,
        password=password,
        organization_name=env.get("AGROVIX_UAT_ORG_NAME", DEFAULT_ORG_NAME).strip()
        or DEFAULT_ORG_NAME,
        farm_name=env.get("AGROVIX_UAT_FARM_NAME", DEFAULT_FARM_NAME).strip() or DEFAULT_FARM_NAME,
    )


def _assert_non_production(settings: Settings) -> None:
    if settings.is_production:
        raise BootstrapRefusedError("UAT bootstrap is disabled in production environments.")


def _assert_active(label: str, *, active: bool, deleted: bool) -> None:
    if not active or deleted:
        raise BootstrapRefusedError(
            f"Existing {label} matches the UAT identifier but is inactive or deleted; "
            "refusing to alter it."
        )


async def bootstrap_uat(
    session: AsyncSession,
    config: BootstrapConfig,
    *,
    settings: Settings | None = None,
) -> BootstrapSummary:
    """Create only missing UAT records in one transaction."""

    effective_settings = settings or get_settings()
    _assert_non_production(effective_settings)
    if len(config.password) < effective_settings.password_min_length:
        raise BootstrapRefusedError(
            f"UAT password must be at least {effective_settings.password_min_length} characters."
        )

    summary = BootstrapSummary()
    user_repo = UserRepository(session)
    org_repo = OrganizationRepository(session)
    org_membership_repo = OrganizationMembershipRepository(session)
    farm_repo = FarmRepository(session)
    farm_membership_repo = FarmMembershipRepository(session)
    role_repo = RoleRepository(session)
    role_assignment_repo = RoleAssignmentRepository(session)
    audit_repo = AuditRepository(session)
    site_repo = ProductionSiteRepository(session)
    unit_type_repo = ProductionUnitTypeRepository(session)
    unit_repo = ProductionUnitRepository(session)
    batch_repo = ProductionBatchRepository(session)
    transition_repo = ProductionBatchTransitionRepository(session)

    user = (
        await session.execute(select(User).where(User.email == config.email.lower()))
    ).scalar_one_or_none()
    if user is None:
        user = await user_repo.create(
            email=config.email,
            hashed_password=hash_password(config.password),
            full_name="Agrovix UAT Administrator",
        )
        user.is_active = True
        user.is_verified = True
        user.verified_at = datetime.now(UTC)
        session.add(user)
        await session.flush()
        summary.mark("user", "created")
    else:
        if (
            user.deleted_at is not None
            or not user.is_active
            or not user.is_verified
            or user.hashed_password is None
        ):
            raise BootstrapRefusedError(
                "Existing UAT user is not active, verified, and password-enabled; "
                "refusing to alter it."
            )
        summary.mark("user", "existing")

    organization_service = OrganizationService(
        org_repo=org_repo,
        org_mem_repo=org_membership_repo,
        role_repo=role_repo,
        role_assign_repo=role_assignment_repo,
        audit_repo=audit_repo,
    )
    organization = (
        await session.execute(select(Organization).where(Organization.slug == ORG_SLUG))
    ).scalar_one_or_none()
    if organization is None:
        organization = await organization_service.create(
            actor=user,
            data={
                "name": config.organization_name,
                "slug": ORG_SLUG,
                "description": "Persistent non-production tenant for browser UAT.",
                "country": None,
                "timezone": "UTC",
            },
            request_ctx=_REQUEST_CTX,
        )
        summary.mark("organization", "created")
        summary.mark("organization_owner role", "created")
        summary.mark("organization membership", "created")
    else:
        _assert_active(
            "organization",
            active=organization.is_active,
            deleted=organization.deleted_at is not None,
        )
        summary.mark("organization", "existing")

        membership = (
            await session.execute(
                select(OrganizationMembership).where(
                    OrganizationMembership.user_id == user.id,
                    OrganizationMembership.organization_id == organization.id,
                )
            )
        ).scalar_one_or_none()
        if membership is None:
            await org_membership_repo.upsert_active(user_id=user.id, org_id=organization.id)
            summary.mark("organization membership", "created")
        elif membership.deleted_at is not None or not membership.is_active:
            raise BootstrapRefusedError(
                "Existing UAT organization membership is inactive or deleted; "
                "refusing to reactivate it."
            )
        else:
            summary.mark("organization membership", "existing")

        owner_role = await role_repo.get_by_name("organization_owner")
        if owner_role is None:
            raise BootstrapRefusedError(
                "Canonical organization_owner role is missing; run the canonical seeder first."
            )
        assignments = await role_assignment_repo.list_for_user(user.id)
        owner_assignment = next(
            (
                assignment
                for assignment in assignments
                if assignment.role_id == owner_role.id
                and assignment.organization_id == organization.id
                and assignment.farm_id is None
            ),
            None,
        )
        if owner_assignment is None:
            await role_assignment_repo.create(
                user_id=user.id,
                role_id=owner_role.id,
                organization_id=organization.id,
                farm_id=None,
                granted_by_id=user.id,
            )
            summary.mark("organization_owner role", "created")
        else:
            summary.mark("organization_owner role", "existing")

    farm_service = FarmService(
        farm_repo=farm_repo,
        farm_mem_repo=farm_membership_repo,
        audit_repo=audit_repo,
    )
    farm = (
        await session.execute(
            select(Farm).where(
                Farm.organization_id == organization.id,
                Farm.code == FARM_CODE,
            )
        )
    ).scalar_one_or_none()
    if farm is None:
        farm = await farm_service.create(
            actor=user,
            organization_id=organization.id,
            data={
                "name": config.farm_name,
                "code": FARM_CODE,
                "address": None,
                "timezone": "UTC",
            },
            request_ctx=_REQUEST_CTX,
        )
        summary.mark("farm", "created")
        summary.mark("farm membership", "created")
    else:
        _assert_active("farm", active=farm.is_active, deleted=farm.deleted_at is not None)
        summary.mark("farm", "existing")
        farm_membership = (
            await session.execute(
                select(FarmMembership).where(
                    FarmMembership.user_id == user.id,
                    FarmMembership.farm_id == farm.id,
                )
            )
        ).scalar_one_or_none()
        if farm_membership is None:
            await farm_membership_repo.upsert_active(user_id=user.id, farm_id=farm.id)
            summary.mark("farm membership", "created")
        elif farm_membership.deleted_at is not None or not farm_membership.is_active:
            raise BootstrapRefusedError(
                "Existing UAT farm membership is inactive or deleted; refusing to reactivate it."
            )
        else:
            summary.mark("farm membership", "existing")

    site_service = ProductionSiteService(
        site_repo=site_repo,
        unit_repo=unit_repo,
        audit_repo=audit_repo,
    )
    site = (
        await session.execute(
            select(ProductionSite).where(
                ProductionSite.farm_id == farm.id,
                ProductionSite.code == SITE_CODE,
            )
        )
    ).scalar_one_or_none()
    if site is None:
        site = await site_service.create(
            actor=user,
            farm=farm,
            data={
                "name": "Main Site",
                "code": SITE_CODE,
                "description": "Default active UAT production site.",
                "status": ProductionSiteStatus.ACTIVE,
            },
            request_ctx=_REQUEST_CTX,
            is_default=True,
        )
        summary.mark("production site", "created")
    else:
        if site.deleted_at is not None or site.status != ProductionSiteStatus.ACTIVE:
            raise BootstrapRefusedError(
                "Existing UAT production site is not active; refusing to alter it."
            )
        summary.mark("production site", "existing")

    unit_type = (
        await session.execute(
            select(ProductionUnitType).where(
                ProductionUnitType.code == UNIT_TYPE_CODE,
                ProductionUnitType.is_system.is_(True),
                ProductionUnitType.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if unit_type is None:
        raise BootstrapRefusedError(
            f"Canonical unit type {UNIT_TYPE_CODE} is missing; run the canonical seeder first."
        )
    summary.mark("canonical reference data", "existing")

    unit_service = ProductionUnitService(
        unit_repo=unit_repo,
        unit_type_repo=unit_type_repo,
        site_repo=site_repo,
        audit_repo=audit_repo,
    )
    unit = (
        await session.execute(
            select(ProductionUnit).where(
                ProductionUnit.site_id == site.id,
                ProductionUnit.code == UNIT_CODE,
            )
        )
    ).scalar_one_or_none()
    if unit is None:
        unit = await unit_service.create(
            actor=user,
            site=site,
            farm=farm,
            data={
                "unit_type_id": unit_type.id,
                "name": "UAT Pond",
                "code": UNIT_CODE,
                "capacity": 1000,
                "status": ProductionUnitStatus.ACTIVE,
            },
            request_ctx=_REQUEST_CTX,
        )
        summary.mark("production unit", "created")
    else:
        if unit.deleted_at is not None or unit.status != ProductionUnitStatus.ACTIVE:
            raise BootstrapRefusedError(
                "Existing UAT production unit is not active; refusing to alter it."
            )
        if unit.unit_type_id != unit_type.id:
            raise BootstrapRefusedError(
                "Existing UAT production unit uses a different unit type; refusing to alter it."
            )
        summary.mark("production unit", "existing")

    batch_service = ProductionBatchService(
        batch_repo=batch_repo,
        transition_repo=transition_repo,
        unit_repo=unit_repo,
        audit_repo=audit_repo,
    )
    batch = (
        await session.execute(
            select(ProductionBatch).where(
                ProductionBatch.unit_id == unit.id,
                ProductionBatch.code == BATCH_CODE,
            )
        )
    ).scalar_one_or_none()
    if batch is None:
        await batch_service.create(
            actor=user,
            unit=unit,
            site=site,
            farm=farm,
            data={
                "code": BATCH_CODE,
                "species": "Tilapia",
                "planned_at": datetime.now(UTC),
                "expected_quantity": 1000,
                "notes": "Persistent planned batch for Production Event browser UAT.",
            },
            request_ctx=_REQUEST_CTX,
        )
        summary.mark("production batch", "created (planned)")
    else:
        if batch.deleted_at is not None or batch.state not in {
            ProductionBatchState.PLANNED,
            ProductionBatchState.STOCKED,
            ProductionBatchState.ACTIVE,
        }:
            raise BootstrapRefusedError(
                "Existing UAT production batch is not suitable for event UAT; refusing to alter it."
            )
        summary.mark("production batch", f"existing ({batch.state.value})")

    return summary


async def run(config: BootstrapConfig, *, settings: Settings | None = None) -> BootstrapSummary:
    effective_settings = settings or get_settings()
    _assert_non_production(effective_settings)
    await seed_permissions_and_roles()
    async with AsyncSessionLocal() as session, session.begin():
        return await bootstrap_uat(session, config, settings=effective_settings)


def main() -> None:
    try:
        settings = get_settings()
        _assert_non_production(settings)
        prompt = getpass.getpass if sys.stdin.isatty() else None
        config = config_from_environment(password_prompt=prompt)
        summary = asyncio.run(run(config, settings=settings))
    except BootstrapRefusedError as exc:
        print(f"UAT bootstrap refused: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    summary.print()


if __name__ == "__main__":
    main()
