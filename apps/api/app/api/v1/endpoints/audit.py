"""Audit event endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.deps import (
    CurrentOrganization,
    get_audit_repository,
    require_permission,
)
from app.repositories.audit_repo import AuditRepository
from app.schemas.audit import AuditEventPublic

router = APIRouter()


@router.get(
    "/organizations/{organization_id}/audit-events",
    response_model=list[AuditEventPublic],
    dependencies=[Depends(require_permission("audit.read"))],
)
async def list_audit_events(
    org: CurrentOrganization,
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
    limit: int = 100,
) -> list[AuditEventPublic]:
    rows = await audit_repo.list_for_org(org.id, limit=min(limit, 500))
    return [AuditEventPublic.model_validate(r) for r in rows]
