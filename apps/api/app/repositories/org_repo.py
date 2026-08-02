"""Organization + Farm repositories (with membership helpers)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.farm import Farm
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.role_assignment import RoleAssignment


class OrganizationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **data) -> Organization:
        org = Organization(**data)
        self.session.add(org)
        await self.session.flush()
        return org

    async def get_by_id(self, org_id: uuid.UUID) -> Organization | None:
        stmt = select(Organization).where(
            Organization.id == org_id, Organization.deleted_at.is_(None)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_slug(self, slug: str) -> Organization | None:
        stmt = select(Organization).where(
            Organization.slug == slug.lower(), Organization.deleted_at.is_(None)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_ids_for_update(
        self, ids: list[uuid.UUID] | tuple[uuid.UUID, ...]
    ) -> list[Organization]:
        """Sprint 5.4.7 — row-lock a set of organizations deterministically.

        Emits ``SELECT ... WHERE id IN (:ids) ORDER BY id ASC
        FOR UPDATE`` with ``populate_existing`` so the identity map
        adopts the LOCKED authoritative row. Callers pass the ids in
        already-sorted order; the ``ORDER BY`` clause is redundant
        for a single id but guards multi-org acquisition against
        deadlocks. Soft-deleted rows are INCLUDED — reversal callers
        need to observe ``deleted_at`` explicitly to refuse the
        operation.
        """
        if not ids:
            return []
        stmt = (
            select(Organization)
            .where(Organization.id.in_(list(ids)))
            .order_by(Organization.id.asc())
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def list_for_user(self, user_id: uuid.UUID) -> list[Organization]:
        stmt = (
            select(Organization)
            .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
            .where(
                OrganizationMembership.user_id == user_id,
                OrganizationMembership.is_active.is_(True),
                OrganizationMembership.deleted_at.is_(None),
                Organization.deleted_at.is_(None),
            )
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())

    async def soft_delete(self, org: Organization) -> None:
        org.deleted_at = datetime.now(UTC)
        org.is_active = False
        self.session.add(org)
        await self.session.flush()

    async def count_owners(self, org_id: uuid.UUID) -> int:
        """Count active role assignments for `organization_owner` in this org.

        Used to prevent orphaning ownership on member removal.
        """
        from app.models.role import Role

        stmt = (
            select(RoleAssignment)
            .join(Role, Role.id == RoleAssignment.role_id)
            .where(
                RoleAssignment.organization_id == org_id,
                RoleAssignment.farm_id.is_(None),
                RoleAssignment.revoked_at.is_(None),
                Role.name == "organization_owner",
            )
        )
        result = await self.session.execute(stmt)
        return len(result.scalars().all())

    async def lock_owner_set(self, org_id: uuid.UUID) -> None:
        """Serialize concurrent transactions that mutate the ownership
        set of this organization.

        Uses a Postgres transaction-scoped advisory lock keyed on the
        organization id so that two callers racing to revoke DIFFERENT
        owner assignments queue up rather than both passing the
        "≥ 1 owner remains" post-check with a stale (uncommitted) view
        of each other's writes. Falls back to a no-op on non-Postgres
        engines (SQLite unit-test path serialises writers anyway).
        """
        dialect = self.session.bind.dialect.name if self.session.bind else ""
        if dialect != "postgresql":
            return
        # Advisory locks are keyed on two int4s; derive them from the
        # UUID bytes so two different orgs never collide.
        as_int = int(org_id.int)
        key1 = (as_int >> 32) & 0x7FFFFFFF
        key2 = as_int & 0x7FFFFFFF
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(:k1, :k2)"),
            {"k1": key1, "k2": key2},
        )


class OrganizationMembershipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, user_id: uuid.UUID, org_id: uuid.UUID) -> OrganizationMembership | None:
        stmt = select(OrganizationMembership).where(
            OrganizationMembership.user_id == user_id,
            OrganizationMembership.organization_id == org_id,
            OrganizationMembership.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def upsert_active(
        self, *, user_id: uuid.UUID, org_id: uuid.UUID, invited_by_id: uuid.UUID | None = None
    ) -> OrganizationMembership:
        existing = await self.get(user_id, org_id)
        if existing is not None:
            if not existing.is_active:
                existing.is_active = True
                self.session.add(existing)
                await self.session.flush()
            return existing
        row = OrganizationMembership(
            user_id=user_id,
            organization_id=org_id,
            invited_by_id=invited_by_id,
            is_active=True,
        )
        self.session.add(row)
        await self.session.flush()
        return row


class FarmRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **data) -> Farm:
        farm = Farm(**data)
        self.session.add(farm)
        await self.session.flush()
        return farm

    async def get_by_id(self, farm_id: uuid.UUID) -> Farm | None:
        stmt = (
            select(Farm)
            .where(Farm.id == farm_id, Farm.deleted_at.is_(None))
            .options(selectinload(Farm.organization))
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id_including_deleted(self, farm_id: uuid.UUID) -> Farm | None:
        """Lookup that INCLUDES soft-deleted rows — used solely for restore."""
        stmt = select(Farm).where(Farm.id == farm_id).options(selectinload(Farm.organization))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_by_ids_for_update(
        self, ids: list[uuid.UUID] | tuple[uuid.UUID, ...]
    ) -> list[Farm]:
        """Sprint 5.4.7 — row-lock a set of farms deterministically.

        Emits ``SELECT ... WHERE id IN (:ids) ORDER BY id ASC
        FOR UPDATE`` with ``populate_existing`` so the identity map
        adopts the LOCKED authoritative row. Soft-deleted rows are
        INCLUDED — reversal callers must inspect ``deleted_at`` /
        ``is_active`` under the lock to refuse the operation with
        the appropriate ``transfer_farm_deleted`` /
        ``transfer_farm_inactive`` diagnostic.
        """
        if not ids:
            return []
        stmt = (
            select(Farm)
            .where(Farm.id.in_(list(ids)))
            .order_by(Farm.id.asc())
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def list_for_org(self, org_id: uuid.UUID) -> list[Farm]:
        stmt = (
            select(Farm)
            .where(Farm.organization_id == org_id, Farm.deleted_at.is_(None))
            .order_by(Farm.name)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())

    async def list_accessible_for_user(
        self, *, user_id: uuid.UUID, org_id: uuid.UUID
    ) -> list[Farm]:
        """Farms in org that the user can see.

        Users with any active organization-scoped role assignment see all
        farms in that org. Users with only farm-scoped assignments see
        just the farms they were assigned to.
        """
        org_scoped_stmt = select(RoleAssignment).where(
            RoleAssignment.user_id == user_id,
            RoleAssignment.organization_id == org_id,
            RoleAssignment.farm_id.is_(None),
            RoleAssignment.revoked_at.is_(None),
        )
        org_scoped = (await self.session.execute(org_scoped_stmt)).scalars().first()

        if org_scoped is not None:
            return await self.list_for_org(org_id)

        stmt = (
            select(Farm)
            .join(FarmMembership, FarmMembership.farm_id == Farm.id)
            .where(
                Farm.organization_id == org_id,
                Farm.deleted_at.is_(None),
                FarmMembership.user_id == user_id,
                FarmMembership.is_active.is_(True),
                FarmMembership.deleted_at.is_(None),
            )
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())

    async def soft_delete(self, farm: Farm) -> None:
        now = datetime.now(UTC)
        farm.deleted_at = now
        farm.is_active = False
        # Set updated_at explicitly so the returned ORM instance has a
        # non-expired value — the ``onupdate=func.now()`` server default
        # otherwise triggers a lazy re-fetch on attribute access, which
        # is unsafe outside a greenlet under async SQLAlchemy.
        farm.updated_at = now
        self.session.add(farm)
        await self.session.flush()

    async def restore(self, farm: Farm) -> None:
        """Undo a soft delete. Returns the farm to normal query visibility."""
        now = datetime.now(UTC)
        farm.deleted_at = None
        farm.is_active = True
        farm.updated_at = now
        self.session.add(farm)
        await self.session.flush()


class FarmMembershipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, user_id: uuid.UUID, farm_id: uuid.UUID) -> FarmMembership | None:
        stmt = select(FarmMembership).where(
            FarmMembership.user_id == user_id,
            FarmMembership.farm_id == farm_id,
            FarmMembership.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def upsert_active(self, *, user_id: uuid.UUID, farm_id: uuid.UUID) -> FarmMembership:
        existing = await self.get(user_id, farm_id)
        if existing is not None:
            if not existing.is_active:
                existing.is_active = True
                self.session.add(existing)
                await self.session.flush()
            return existing
        row = FarmMembership(user_id=user_id, farm_id=farm_id, is_active=True)
        self.session.add(row)
        await self.session.flush()
        return row

    async def user_has_farm(self, *, user_id: uuid.UUID, farm_id: uuid.UUID) -> bool:
        row = await self.get(user_id, farm_id)
        return row is not None and row.is_active

    async def user_org_farms_or_all(
        self, *, user_id: uuid.UUID, org_id: uuid.UUID
    ) -> list[uuid.UUID] | None:
        """Return the list of farm IDs a user has explicit membership to
        in the given org, or ``None`` when the user's assignments already
        grant them access to *all* farms in the org (org-scoped role).
        """
        org_stmt = select(RoleAssignment).where(
            RoleAssignment.user_id == user_id,
            RoleAssignment.organization_id == org_id,
            RoleAssignment.farm_id.is_(None),
            RoleAssignment.revoked_at.is_(None),
        )
        if (await self.session.execute(org_stmt)).scalars().first() is not None:
            return None

        stmt = (
            select(FarmMembership.farm_id)
            .join(Farm, Farm.id == FarmMembership.farm_id)
            .where(
                FarmMembership.user_id == user_id,
                FarmMembership.is_active.is_(True),
                FarmMembership.deleted_at.is_(None),
                Farm.organization_id == org_id,
                Farm.deleted_at.is_(None),
            )
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


__all__ = [
    "FarmMembershipRepository",
    "FarmRepository",
    "OrganizationMembershipRepository",
    "OrganizationRepository",
]
