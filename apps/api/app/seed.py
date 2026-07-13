"""Idempotent seeder for permissions + system roles.

Safe to run on every deploy. NEVER seeds a default superuser — use
``python -m app.cli create_admin`` for that (interactive prompt).
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.models.role import Permission, Role
from app.security.permissions import ALL_PERMISSIONS, ROLE_DEFINITIONS


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

        await session.commit()


def main() -> None:
    asyncio.run(seed_permissions_and_roles())


if __name__ == "__main__":
    main()
