"""Invitation schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class InvitationCreateRequest(BaseModel):
    email: EmailStr
    role_name: str = Field(..., min_length=2, max_length=64)
    farm_id: UUID | None = None


class AcceptInvitationRequest(BaseModel):
    token: str = Field(..., min_length=10)


class InvitationPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: UUID
    farm_id: UUID | None
    role_id: UUID
    email: EmailStr
    status: str
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
