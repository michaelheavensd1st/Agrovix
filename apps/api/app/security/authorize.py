"""Effective-permissions resolver.

Given a User plus (optionally) an organization and farm scope, returns
the set of permission codes they hold. Business code should NEVER
inspect role names directly — always call :func:`resolve_permissions`
and check for the required permission code.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.farm import Farm
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User


@dataclass(frozen=True)
class PermissionScope:
    organization_id: uuid.UUID | None
    farm_id: uuid.UUID | None
    permissions: tuple[str, ...]


async def resolve_permission_scopes(
    session: AsyncSession,
    user: User,
) -> list[PermissionScope]:
    """Return active permission grants grouped by their exact tenant scope."""
    if not user.is_active:
        return []
    if user.is_superuser:
        return [PermissionScope(None, None, ("*", "platform.admin"))]

    assignments = (
        (
            await session.execute(
                select(RoleAssignment)
                .where(
                    RoleAssignment.user_id == user.id,
                    RoleAssignment.revoked_at.is_(None),
                )
                .options(selectinload(RoleAssignment.role).selectinload(Role.permissions))
            )
        )
        .scalars()
        .unique()
        .all()
    )

    organization_ids = {
        assignment.organization_id
        for assignment in assignments
        if assignment.organization_id is not None
    }
    farm_ids = {assignment.farm_id for assignment in assignments if assignment.farm_id is not None}

    active_organization_ids: set[uuid.UUID] = set()
    if organization_ids:
        active_organization_ids = set(
            (
                await session.execute(
                    select(OrganizationMembership.organization_id)
                    .join(
                        Organization,
                        Organization.id == OrganizationMembership.organization_id,
                    )
                    .where(
                        OrganizationMembership.user_id == user.id,
                        OrganizationMembership.organization_id.in_(organization_ids),
                        OrganizationMembership.is_active.is_(True),
                        OrganizationMembership.deleted_at.is_(None),
                        Organization.is_active.is_(True),
                        Organization.deleted_at.is_(None),
                    )
                )
            ).scalars()
        )

    active_farm_organizations: dict[uuid.UUID, uuid.UUID] = {}
    if farm_ids:
        active_farm_organizations = dict(
            (
                await session.execute(
                    select(FarmMembership.farm_id, Farm.organization_id)
                    .join(Farm, Farm.id == FarmMembership.farm_id)
                    .where(
                        FarmMembership.user_id == user.id,
                        FarmMembership.farm_id.in_(farm_ids),
                        FarmMembership.is_active.is_(True),
                        FarmMembership.deleted_at.is_(None),
                        Farm.is_active.is_(True),
                        Farm.deleted_at.is_(None),
                        Farm.organization_id.in_(active_organization_ids),
                    )
                )
            ).all()
        )

    grouped: dict[tuple[uuid.UUID | None, uuid.UUID | None], set[str]] = {}
    for assignment in assignments:
        organization_id = assignment.organization_id
        farm_id = assignment.farm_id
        if organization_id is not None and organization_id not in active_organization_ids:
            continue
        if farm_id is not None:
            farm_organization_id = active_farm_organizations.get(farm_id)
            if farm_organization_id is None or farm_organization_id != organization_id:
                continue
        key = (organization_id, farm_id)
        grouped.setdefault(key, set()).update(
            permission.code for permission in assignment.role.permissions
        )

    return [
        PermissionScope(organization_id, farm_id, tuple(sorted(codes)))
        for (organization_id, farm_id), codes in sorted(
            grouped.items(),
            key=lambda item: tuple("" if value is None else str(value) for value in item[0]),
        )
    ]


async def resolve_permissions(
    session: AsyncSession,
    user: User,
    *,
    organization_id: uuid.UUID | None = None,
    farm_id: uuid.UUID | None = None,
    include_farm_grants_in_org: bool = False,
) -> set[str]:
    """Return the set of permission codes the user has for the given scope.

    When ``include_farm_grants_in_org`` is True and ``organization_id`` is
    provided (with ``farm_id`` unset), farm-scoped assignments belonging to
    the same organization also contribute their grants. This models the
    §12 "Scoped" read entries for organization-owned resources such as
    Business Partners: a user with a farm-scoped ``business_partner.read``
    grant may read the org-owned partner aggregate. Mutations remain
    strictly org-scoped (no widening).
    """
    if not user.is_active:
        return set()

    if user.is_superuser:
        # Convention: superusers implicitly hold every permission.
        return {"platform.admin", "*"}

    codes: set[str] = set()
    if include_farm_grants_in_org:
        # The Business Partner read-widening path must use canonical active
        # scopes so a stale farm assignment cannot become an org-wide grant.
        # Other permission paths retain their established lifecycle behavior;
        # their resource services perform the relevant locked status checks.
        scopes = await resolve_permission_scopes(session, user)
        for scope in scopes:
            applies = (
                (scope.organization_id is None and scope.farm_id is None)
                or (scope.farm_id is None and scope.organization_id == organization_id)
                or (farm_id is not None and scope.farm_id == farm_id)
                or (
                    farm_id is None
                    and organization_id is not None
                    and scope.organization_id == organization_id
                )
            )
            if applies:
                codes.update(scope.permissions)
        return codes

    stmt = (
        select(RoleAssignment)
        .where(RoleAssignment.user_id == user.id, RoleAssignment.revoked_at.is_(None))
        .options(selectinload(RoleAssignment.role).selectinload(Role.permissions))
    )
    assignments = (await session.execute(stmt)).scalars().all()
    for assignment in assignments:
        if assignment.organization_id is None and assignment.farm_id is None:
            codes.update(permission.code for permission in assignment.role.permissions)
        elif assignment.farm_id is None:
            if organization_id is None or assignment.organization_id == organization_id:
                codes.update(permission.code for permission in assignment.role.permissions)
        elif farm_id is not None and assignment.farm_id == farm_id:
            codes.update(permission.code for permission in assignment.role.permissions)

    return codes


def has_permission(codes: set[str], required: str) -> bool:
    return "*" in codes or required in codes
