"""Audit event repository."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
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

    async def search_for_org(
        self,
        org_id: uuid.UUID,
        *,
        farm_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
        action: str | None = None,
        entity_type: str | None = None,
        occurred_from: datetime | None = None,
        occurred_to: datetime | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[AuditEvent], int]:
        """Filtered + paginated audit search scoped to a single organization.

        Ordering is deterministic: (``created_at DESC``, ``id DESC``) so
        that pagination is stable even when rows share a microsecond
        timestamp.

        Returns ``(rows, total_count)``.
        """
        base = select(AuditEvent).where(AuditEvent.organization_id == org_id)
        if farm_id is not None:
            base = base.where(AuditEvent.farm_id == farm_id)
        if actor_id is not None:
            base = base.where(AuditEvent.actor_id == actor_id)
        if action:
            base = base.where(AuditEvent.action == action)
        if entity_type:
            base = base.where(AuditEvent.entity_type == entity_type)
        if occurred_from is not None:
            base = base.where(AuditEvent.created_at >= occurred_from)
        if occurred_to is not None:
            base = base.where(AuditEvent.created_at <= occurred_to)

        # Count query — reuse the same predicates but drop the row shape.
        total_stmt = select(func.count()).select_from(base.subquery())
        total = int((await self.session.execute(total_stmt)).scalar_one())

        page_stmt = (
            base.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
            .limit(limit)
            .offset(offset)
        )
        rows = list((await self.session.execute(page_stmt)).scalars().unique())
        return rows, total

    # Backwards-compatible convenience wrapper.
    async def list_for_org(self, org_id: uuid.UUID, *, limit: int = 100) -> list[AuditEvent]:
        rows, _ = await self.search_for_org(org_id, limit=limit)
        return rows
