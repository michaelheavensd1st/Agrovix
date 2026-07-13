"""Idempotent seeder for permissions + system roles + system reference data.

Safe to run on every deploy. NEVER seeds a default superuser — use
``python -m app.cli create_admin`` for that (interactive prompt).
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.models.production import ProductionUnitType
from app.models.role import Permission, Role
from app.security.permissions import ALL_PERMISSIONS, ROLE_DEFINITIONS


# System-owned production unit types (aquaculture-first; extend on release).
SYSTEM_UNIT_TYPES: tuple[dict, ...] = (
    {
        "code": "HATCHERY_TANK", "name": "Hatchery Tank",
        "category": "hatchery",
        "description": "Indoor rearing tank for larvae and post-larvae.",
    },
    {
        "code": "NURSERY_TANK", "name": "Nursery Tank",
        "category": "nursery",
        "description": "Grow-on tank for juveniles before pond transfer.",
    },
    {
        "code": "GROW_OUT_POND", "name": "Grow-out Pond",
        "category": "grow_out",
        "description": "Outdoor pond used for the main grow-out cycle.",
    },
    {
        "code": "CAGE", "name": "Cage",
        "category": "grow_out",
        "description": "Suspended net cage in open water.",
    },
    {
        "code": "RACEWAY", "name": "Raceway",
        "category": "grow_out",
        "description": "Linear flow-through raceway system.",
    },
    {
        "code": "BIOFLOC_TANK", "name": "Biofloc Tank",
        "category": "biofloc",
        "description": "High-density biofloc-based rearing tank.",
    },
)


async def seed_permissions_and_roles() -> None:
    # Late import so test fixtures that swap the engine take effect.
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        # Permissions
        perms_by_code: dict[str, Permission] = {}
        for perm_def in ALL_PERMISSIONS:
            row = (
                await session.execute(select(Permission).where(Permission.code == perm_def.code))
            ).scalar_one_or_none()
            if row is None:
                row = Permission(code=perm_def.code, description=perm_def.description)
                session.add(row)
            else:
                row.description = perm_def.description
            perms_by_code[perm_def.code] = row
        await session.flush()

        # Roles + attach permissions
        for role_def in ROLE_DEFINITIONS:
            row = (
                await session.execute(select(Role).where(Role.name == role_def.name))
            ).scalar_one_or_none()
            if row is None:
                row = Role(
                    name=role_def.name,
                    scope=role_def.scope,
                    description=role_def.description,
                    is_system=True,
                )
                session.add(row)
            else:
                row.scope = role_def.scope
                row.description = role_def.description
                row.is_system = True
            row.permissions = [perms_by_code[c] for c in role_def.permissions]

        # System production unit types — org_id is NULL, is_system=True.
        # Refresh description/name on each run so platform updates propagate.
        for spec in SYSTEM_UNIT_TYPES:
            existing = (
                await session.execute(
                    select(ProductionUnitType).where(
                        ProductionUnitType.code == spec["code"],
                        ProductionUnitType.is_system.is_(True),
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                session.add(
                    ProductionUnitType(
                        organization_id=None, is_system=True, **spec,
                    )
                )
            else:
                existing.name = spec["name"]
                existing.description = spec["description"]
                existing.category = spec["category"]

        await session.commit()


def main() -> None:
    asyncio.run(seed_permissions_and_roles())


if __name__ == "__main__":
    main()
