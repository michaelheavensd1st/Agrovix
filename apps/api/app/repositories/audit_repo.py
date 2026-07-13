"""Audit event repository."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent


class AuditRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def record(
        self,
        *,
        actor_id: uuid.UUID | None,
        action: str,
        entity_type: str,
        entity_id: str | None = None,
        organization_id: uuid.UUID | None = None,
        farm_id: uuid.UUID | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
        request_id: str | None = None,
        metadata: dict | None = None,
    ) -> AuditEvent:
        row = AuditEvent(
            actor_id=actor_id,
            organization_id=organization_id,
            farm_id=farm_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            ip_address=ip_address,
            user_agent=user_agent,
            request_id=request_id,
            metadata_json=metadata,
        )
        self.session.add(row)
        await self.session.flush()
        return row

    async def list_for_org(self, org_id: uuid.UUID, *, limit: int = 100) -> list[AuditEvent]:
        stmt = (
            select(AuditEvent)
            .where(AuditEvent.organization_id == org_id)
            .order_by(AuditEvent.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().unique())
