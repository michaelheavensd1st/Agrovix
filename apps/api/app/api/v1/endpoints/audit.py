"""Audit event endpoints (filtered + paginated)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.deps import (
    CurrentOrganization,
    get_audit_repository,
    require_permission,
)
from app.repositories.audit_repo import AuditRepository
from app.schemas.audit import AuditEventPage, AuditEventPublic

router = APIRouter()

# Cap the page size so a rogue caller cannot ask for the entire audit log.
_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get(
    "/organizations/{organization_id}/audit-events",
    response_model=AuditEventPage,
    dependencies=[Depends(require_permission("audit.read"))],
)
async def list_audit_events(
    org: CurrentOrganization,
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
    farm_id: uuid.UUID | None = Query(default=None, description="Restrict to a single farm within the org."),
    actor_id: uuid.UUID | None = Query(default=None, description="Restrict to events performed by this user."),
    action: str | None = Query(default=None, description="Exact action match (e.g. ``farm.delete``)."),
    entity_type: str | None = Query(default=None, description="Exact entity_type match (e.g. ``invitation``)."),
    occurred_from: datetime | None = Query(default=None, description="ISO-8601 lower bound (inclusive)."),
    occurred_to: datetime | None = Query(default=None, description="ISO-8601 upper bound (inclusive)."),
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> AuditEventPage:
    """List audit events for the current organization.

    Filtering options: ``farm_id``, ``actor_id``, ``action``,
    ``entity_type``, ``occurred_from``, ``occurred_to``. Results are
    ordered by ``(created_at DESC, id DESC)`` for deterministic
    pagination, and capped at ``limit=200`` per request.
    """
    rows, total = await audit_repo.search_for_org(
        org.id,
        farm_id=farm_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        occurred_from=occurred_from,
        occurred_to=occurred_to,
        limit=limit,
        offset=offset,
    )
    return AuditEventPage(
        items=[AuditEventPublic.model_validate(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )
