"""Invitation repository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invitation import Invitation, InvitationStatus


class InvitationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **data) -> Invitation:
        row = Invitation(**data)
        self.session.add(row)
        await self.session.flush()
        return row

    async def get_by_id(self, invitation_id: uuid.UUID) -> Invitation | None:
        stmt = select(Invitation).where(Invitation.id == invitation_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_token_hash(self, token_hash: str) -> Invitation | None:
        stmt = select(Invitation).where(Invitation.token_hash == token_hash)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_org(self, org_id: uuid.UUID) -> list[Invitation]:
        stmt = (
            select(Invitation)
            .where(Invitation.organization_id == org_id)
            .order_by(Invitation.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())

    async def mark_accepted(self, invitation: Invitation) -> None:
        invitation.status = InvitationStatus.ACCEPTED
        invitation.accepted_at = datetime.now(UTC)
        self.session.add(invitation)
        await self.session.flush()

    async def mark_revoked(self, invitation: Invitation) -> None:
        invitation.status = InvitationStatus.REVOKED
        invitation.revoked_at = datetime.now(UTC)
        self.session.add(invitation)
        await self.session.flush()

    async def expire_if_needed(self, invitation: Invitation) -> Invitation:
        if invitation.status == InvitationStatus.PENDING:
            exp = invitation.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=UTC)
            if exp < datetime.now(UTC):
                invitation.status = InvitationStatus.EXPIRED
                self.session.add(invitation)
                await self.session.flush()
        return invitation
