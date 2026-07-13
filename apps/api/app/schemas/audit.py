"""Audit event schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class AuditEventPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    actor_id: UUID | None
    organization_id: UUID | None
    farm_id: UUID | None
    action: str
    entity_type: str
    entity_id: str | None
    ip_address: str | None
    request_id: str | None
    metadata_json: dict | None
    created_at: datetime
