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

# System-owned production unit types.
#
# Sprint 3 — Aquaculture Vertical Slice 01: this is the first vertical
# to actually populate the catalog. The list below is comprehensive
# enough to model the full grow-out lifecycle from broodstock to
# harvest without introducing any parallel domain tables.
#
# Codes are IMMUTABLE once a system row exists. The seeder updates
# `name`, `display_name`, `plural_name`, `description`, `category`
# and `vertical`, but never changes `code`. Rename in the UI by
# updating `display_name` — do NOT edit `code`.
SYSTEM_UNIT_TYPES: tuple[dict, ...] = (
    # -- Aquaculture — broodstock & hatchery lineage -------------- #
    {
        "code": "BROODSTOCK_UNIT",
        "name": "Broodstock Unit",
        "display_name": "Broodstock Unit",
        "plural_name": "Broodstock Units",
        "category": "broodstock",
        "vertical": "aquaculture",
        "description": "Tank or holding used exclusively for mature broodstock.",
    },
    {
        "code": "INCUBATION_UNIT",
        "name": "Incubation Unit",
        "display_name": "Incubation Unit",
        "plural_name": "Incubation Units",
        "category": "hatchery",
        "vertical": "aquaculture",
        "description": "Incubator holding fertilised eggs before hatching.",
    },
    {
        "code": "HATCHERY_TANK",
        "name": "Hatchery Tank",
        "display_name": "Hatchery Tank",
        "plural_name": "Hatchery Tanks",
        "category": "hatchery",
        "vertical": "aquaculture",
        "description": "Indoor rearing tank for larvae and post-larvae.",
    },
    {
        "code": "FRY_TANK",
        "name": "Fry Tank",
        "display_name": "Fry Tank",
        "plural_name": "Fry Tanks",
        "category": "hatchery",
        "vertical": "aquaculture",
        "description": "Rearing tank for very early juveniles.",
    },
    {
        "code": "NURSERY_TANK",
        "name": "Nursery Tank",
        "display_name": "Nursery Tank",
        "plural_name": "Nursery Tanks",
        "category": "nursery",
        "vertical": "aquaculture",
        "description": "Grow-on tank for juveniles before pond transfer.",
    },
    # -- Aquaculture — grow-out ----------------------------------- #
    {
        "code": "GROW_OUT_POND",
        "name": "Grow-out Pond",
        "display_name": "Pond",
        "plural_name": "Ponds",
        "category": "grow_out",
        "vertical": "aquaculture",
        "description": "Outdoor pond used for the main grow-out cycle.",
    },
    {
        "code": "BIOFLOC_TANK",
        "name": "Biofloc Tank",
        "display_name": "Biofloc Tank",
        "plural_name": "Biofloc Tanks",
        "category": "biofloc",
        "vertical": "aquaculture",
        "description": "High-density biofloc-based rearing tank.",
    },
    {
        "code": "RACEWAY",
        "name": "Raceway",
        "display_name": "Raceway",
        "plural_name": "Raceways",
        "category": "grow_out",
        "vertical": "aquaculture",
        "description": "Linear flow-through raceway system.",
    },
    {
        "code": "FLOATING_CAGE",
        "name": "Floating Cage",
        "display_name": "Cage",
        "plural_name": "Cages",
        "category": "grow_out",
        "vertical": "aquaculture",
        "description": "Suspended net cage in open water.",
    },
    # -- Aquaculture — bio-security ------------------------------- #
    {
        "code": "QUARANTINE_UNIT",
        "name": "Quarantine Unit",
        "display_name": "Quarantine Unit",
        "plural_name": "Quarantine Units",
        "category": "biosecurity",
        "vertical": "aquaculture",
        "description": "Isolated holding used for observation before movement.",
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
                        organization_id=None,
                        is_system=True,
                        **spec,
                    )
                )
            else:
                existing.name = spec["name"]
                existing.description = spec["description"]
                existing.category = spec["category"]
                existing.display_name = spec["display_name"]
                existing.plural_name = spec.get("plural_name")
                existing.vertical = spec.get("vertical")

        await session.commit()


def main() -> None:
    asyncio.run(seed_permissions_and_roles())


if __name__ == "__main__":
    main()
