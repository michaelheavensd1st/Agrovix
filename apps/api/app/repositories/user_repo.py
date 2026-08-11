"""User repository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        stmt = select(User).where(User.id == user_id, User.deleted_at.is_(None))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id_for_update(self, user_id: uuid.UUID) -> User | None:
        """Lock one active-or-disabled, non-deleted user as a security root.

        Credential mutation services must acquire this lock before locking
        any dependent recovery-token or refresh-token row.
        """
        stmt = (
            select(User)
            .where(User.id == user_id, User.deleted_at.is_(None))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        stmt = select(User).where(User.email == email.lower(), User.deleted_at.is_(None))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create(
        self,
        *,
        email: str,
        hashed_password: str | None,
        full_name: str | None = None,
    ) -> User:
        user = User(
            email=email.lower(),
            hashed_password=hashed_password,
            full_name=full_name,
        )
        self.session.add(user)
        await self.session.flush()
        return user

    async def mark_verified(self, user: User) -> User:
        user.is_verified = True
        user.verified_at = datetime.now(UTC)
        self.session.add(user)
        await self.session.flush()
        await self.session.refresh(user)
        return user

    async def soft_delete(self, user: User) -> None:
        user.deleted_at = datetime.now(UTC)
        user.is_active = False
        self.session.add(user)
        await self.session.flush()
