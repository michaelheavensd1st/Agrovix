"""Effective-permissions resolver.

Given a User plus (optionally) an organization and farm scope, returns
the set of permission codes they hold. Business code should NEVER
inspect role names directly — always call :func:`resolve_permissions`
and check for the required permission code.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User


async def resolve_permissions(
    session: AsyncSession,
    user: User,
    *,
    organization_id: uuid.UUID | None = None,
    farm_id: uuid.UUID | None = None,
) -> set[str]:
    """Return the set of permission codes the user has for the given scope."""
    if not user.is_active:
        return set()

    if user.is_superuser:
        # Convention: superusers implicitly hold every permission.
        return {"platform.admin", "*"}

    stmt = (
        select(RoleAssignment)
        .where(RoleAssignment.user_id == user.id, RoleAssignment.revoked_at.is_(None))
        .options(selectinload(RoleAssignment.role).selectinload(Role.permissions))
    )
    result = await session.execute(stmt)
    assignments = result.scalars().all()

    codes: set[str] = set()
    for a in assignments:
        # Platform-scoped assignments always apply.
        if a.organization_id is None and a.farm_id is None:
            codes.update(p.code for p in a.role.permissions)
            continue
        # Organization-scoped assignments apply when the request is
        # within (or scoped to) that organization.
        if a.farm_id is None:
            if organization_id is None or a.organization_id == organization_id:
                codes.update(p.code for p in a.role.permissions)
            continue
        # Farm-scoped assignments apply when the request targets that
        # exact farm.
        if farm_id is not None and a.farm_id == farm_id:
            codes.update(p.code for p in a.role.permissions)

    return codes


def has_permission(codes: set[str], required: str) -> bool:
    return "*" in codes or required in codes
