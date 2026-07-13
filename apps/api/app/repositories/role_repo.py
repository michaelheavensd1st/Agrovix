"""Role, Permission, RoleAssignment repositories."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.role import Permission, Role
from app.models.role_assignment import RoleAssignment


class RoleRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_name(self, name: str) -> Role | None:
        stmt = select(Role).where(Role.name == name).options(selectinload(Role.permissions))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id(self, role_id: uuid.UUID) -> Role | None:
        stmt = select(Role).where(Role.id == role_id).options(selectinload(Role.permissions))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()


class PermissionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_code(self, code: str) -> Permission | None:
        stmt = select(Permission).where(Permission.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()


class RoleAssignmentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        role_id: uuid.UUID,
        organization_id: uuid.UUID | None,
        farm_id: uuid.UUID | None,
        granted_by_id: uuid.UUID | None,
    ) -> RoleAssignment:
        row = RoleAssignment(
            user_id=user_id,
            role_id=role_id,
            organization_id=organization_id,
            farm_id=farm_id,
            granted_by_id=granted_by_id,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def get_by_id(self, assignment_id: uuid.UUID) -> RoleAssignment | None:
        stmt = select(RoleAssignment).where(RoleAssignment.id == assignment_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def revoke(self, assignment: RoleAssignment) -> None:
        assignment.revoked_at = datetime.now(timezone.utc)
        self.session.add(assignment)
        await self.session.flush()

    async def list_for_user(self, user_id: uuid.UUID) -> list[RoleAssignment]:
        stmt = (
            select(RoleAssignment)
            .where(RoleAssignment.user_id == user_id, RoleAssignment.revoked_at.is_(None))
            .options(selectinload(RoleAssignment.role).selectinload(Role.permissions))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())

    async def list_for_org(self, org_id: uuid.UUID) -> list[RoleAssignment]:
        stmt = (
            select(RoleAssignment)
            .where(RoleAssignment.organization_id == org_id, RoleAssignment.revoked_at.is_(None))
            .options(selectinload(RoleAssignment.role))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())
