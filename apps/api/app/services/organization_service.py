"""Organization + Farm domain services (tenancy-safe)."""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status

from app.models.farm import Farm
from app.models.organization import Organization
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.org_repo import (
    FarmMembershipRepository,
    FarmRepository,
    OrganizationMembershipRepository,
    OrganizationRepository,
)
from app.repositories.role_repo import RoleAssignmentRepository, RoleRepository


class OrganizationService:
    def __init__(
        self,
        *,
        org_repo: OrganizationRepository,
        org_mem_repo: OrganizationMembershipRepository,
        role_repo: RoleRepository,
        role_assign_repo: RoleAssignmentRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.org_repo = org_repo
        self.org_mem_repo = org_mem_repo
        self.role_repo = role_repo
        self.role_assign_repo = role_assign_repo
        self.audit_repo = audit_repo

    async def create(self, *, actor: User, data: dict, request_ctx: dict) -> Organization:
        existing = await self.org_repo.get_by_slug(data["slug"])
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "That slug is already in use.")
        org = await self.org_repo.create(**data)

        # Creator becomes an organization_owner + org-member automatically.
        owner_role = await self.role_repo.get_by_name("organization_owner")
        if owner_role is None:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "Server misconfiguration: organization_owner role missing. Run the seed script.",
            )
        await self.role_assign_repo.create(
            user_id=actor.id, role_id=owner_role.id,
            organization_id=org.id, farm_id=None, granted_by_id=actor.id,
        )
        await self.org_mem_repo.upsert_active(
            user_id=actor.id, org_id=org.id, invited_by_id=None
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="organization.create",
            entity_type="organization", entity_id=str(org.id),
            organization_id=org.id, metadata={"slug": org.slug, "name": org.name},
            **request_ctx,
        )
        return org

    async def delete(self, *, actor: User, org: Organization, request_ctx: dict) -> None:
        # Ownership orphan guard is implicit — soft-delete cascades to
        # memberships but the org itself is preserved with a deleted_at.
        await self.org_repo.soft_delete(org)
        await self.audit_repo.record(
            actor_id=actor.id, action="organization.delete",
            entity_type="organization", entity_id=str(org.id),
            organization_id=org.id, **request_ctx,
        )


class FarmService:
    def __init__(
        self,
        *,
        farm_repo: FarmRepository,
        farm_mem_repo: FarmMembershipRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.farm_repo = farm_repo
        self.farm_mem_repo = farm_mem_repo
        self.audit_repo = audit_repo

    async def create(
        self, *, actor: User, organization_id: uuid.UUID, data: dict, request_ctx: dict
    ) -> Farm:
        farm = await self.farm_repo.create(organization_id=organization_id, **data)
        # Creator gets explicit farm membership.
        await self.farm_mem_repo.upsert_active(user_id=actor.id, farm_id=farm.id)
        # Auto-create the default ProductionSite per Sprint 2 spec —
        # every farm ships with one "Main Site" that can be renamed but
        # never leaves the farm site-less.
        from app.models.production import ProductionSite, ProductionSiteStatus
        default_site = ProductionSite(
            farm_id=farm.id, name="Main Site", code="MAIN",
            description="Default site created automatically with the farm.",
            status=ProductionSiteStatus.ACTIVE, is_default=True,
        )
        self.farm_repo.session.add(default_site)
        await self.farm_repo.session.flush()
        await self.audit_repo.record(
            actor_id=actor.id, action="production_site.create",
            entity_type="production_site", entity_id=str(default_site.id),
            organization_id=organization_id, farm_id=farm.id,
            metadata={"auto_created": True, "is_default": True},
            **request_ctx,
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="farm.create",
            entity_type="farm", entity_id=str(farm.id),
            organization_id=organization_id, farm_id=farm.id,
            metadata={"code": farm.code, "name": farm.name},
            **request_ctx,
        )
        return farm

    @staticmethod
    def ensure_active(farm: Farm) -> None:
        """Guard used by any service that would attach new records to a farm.

        Raises 409 if the farm has been soft-deleted so downstream
        writes (invitations, memberships, future operational records)
        cannot attach to a decommissioned farm.
        """
        if farm.deleted_at is not None or not farm.is_active:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This farm has been deleted. Restore it before attaching new records.",
            )

    async def delete(self, *, actor: User, farm: Farm, request_ctx: dict) -> None:
        if farm.deleted_at is not None:
            # Idempotent — already soft-deleted; do not double-audit.
            return
        await self.farm_repo.soft_delete(farm)
        await self.audit_repo.record(
            actor_id=actor.id, action="farm.delete",
            entity_type="farm", entity_id=str(farm.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )

    async def restore(self, *, actor: User, farm: Farm, request_ctx: dict) -> Farm:
        if farm.deleted_at is None:
            # Idempotent — farm is already active.
            return farm
        await self.farm_repo.restore(farm)
        await self.audit_repo.record(
            actor_id=actor.id, action="farm.restore",
            entity_type="farm", entity_id=str(farm.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )
        return farm
