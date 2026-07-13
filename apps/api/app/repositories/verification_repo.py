"""Email-verification token repository."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.verification import EmailVerificationToken


class VerificationTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, *, user_id: uuid.UUID, token_hash: str, expires_at: datetime) -> EmailVerificationToken:
        row = EmailVerificationToken(user_id=user_id, token_hash=token_hash, expires_at=expires_at)
        self.session.add(row)
        await self.session.flush()
        return row

    async def get_by_hash(self, token_hash: str) -> EmailVerificationToken | None:
        stmt = select(EmailVerificationToken).where(EmailVerificationToken.token_hash == token_hash)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def mark_used(self, row: EmailVerificationToken) -> None:
        row.is_used = True
        row.used_at = datetime.now(timezone.utc)
        self.session.add(row)
        await self.session.flush()

    async def invalidate_all_for_user(self, user_id: uuid.UUID) -> None:
        now = datetime.now(timezone.utc)
        stmt = (
            update(EmailVerificationToken)
            .where(EmailVerificationToken.user_id == user_id, EmailVerificationToken.is_used.is_(False))
            .values(is_used=True, used_at=now)
        )
        await self.session.execute(stmt)
