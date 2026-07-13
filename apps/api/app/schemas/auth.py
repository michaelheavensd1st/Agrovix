"""Authentication request / response schemas."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.core.config import get_settings

_settings = get_settings()


class RegisterRequest(BaseModel):
    """Payload for ``POST /api/v1/auth/register``."""

    model_config = ConfigDict(str_strip_whitespace=True)

    email: EmailStr
    password: str = Field(..., min_length=_settings.password_min_length, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)


class LoginRequest(BaseModel):
    """Payload for ``POST /api/v1/auth/login``."""

    model_config = ConfigDict(str_strip_whitespace=True)

    email: EmailStr
    password: str = Field(..., min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    """Payload for ``POST /api/v1/auth/refresh``."""

    refresh_token: str = Field(..., min_length=10)


class LogoutRequest(BaseModel):
    """Payload for ``POST /api/v1/auth/logout``."""

    refresh_token: str = Field(..., min_length=10)


class TokenPair(BaseModel):
    """Access + refresh token pair returned by login / refresh."""

    access_token: str
    refresh_token: str
    token_type: str = Field(default="bearer")
    expires_in: int = Field(..., description="Access token lifetime in seconds")
