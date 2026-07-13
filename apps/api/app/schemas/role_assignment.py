"""Role assignment schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RoleAssignmentRequest(BaseModel):
    user_id: UUID
    role_name: str = Field(..., min_length=2, max_length=64)
    farm_id: UUID | None = None  # None → organization-scoped


class RoleAssignmentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    role_id: UUID
    organization_id: UUID | None
    farm_id: UUID | None
    revoked_at: datetime | None
    created_at: datetime
