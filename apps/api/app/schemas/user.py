"""User schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class PermissionScopePublic(BaseModel):
    organization_id: UUID | None = None
    farm_id: UUID | None = None
    permissions: list[str] = Field(default_factory=list)


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    full_name: str | None = None
    is_active: bool
    is_verified: bool
    is_superuser: bool
    created_at: datetime
    updated_at: datetime
    permissions: list[str] = Field(default_factory=list)
    permission_scopes: list[PermissionScopePublic] = Field(default_factory=list)
