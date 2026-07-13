"""User-facing schemas."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserPublic(BaseModel):
    """Safe public projection of a :class:`User`."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    full_name: str | None = None
    is_active: bool
    is_verified: bool
    is_superuser: bool
    roles: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
