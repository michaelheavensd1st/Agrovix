"""Password hashing + JWT helpers.

The scaffolding is deliberately provider-agnostic — additional identity
providers (Google, Apple, phone-OTP, …) can layer on top of the same
User + Role model without changing this module's public surface.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings

TokenType = Literal["access", "refresh"]

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# --------------------------------------------------------------------- #
# Password hashing
# --------------------------------------------------------------------- #
def hash_password(plain: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against an existing hash."""
    return _pwd_context.verify(plain, hashed)


# --------------------------------------------------------------------- #
# JWT
# --------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_token(
    *,
    subject: str | UUID,
    token_type: TokenType,
    expires_delta: timedelta | None = None,
    extra_claims: dict[str, Any] | None = None,
) -> tuple[str, datetime]:
    """Encode a signed JWT.

    Returns the encoded token and its expiry (UTC).
    """
    settings = get_settings()
    now = _now()

    if expires_delta is None:
        if token_type == "access":
            expires_delta = timedelta(minutes=settings.jwt_access_token_expire_minutes)
        else:
            expires_delta = timedelta(days=settings.jwt_refresh_token_expire_days)

    expire = now + expires_delta

    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "typ": token_type,
    }
    if extra_claims:
        payload.update(extra_claims)

    encoded = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded, expire


def decode_token(token: str, *, expected_type: TokenType | None = None) -> dict[str, Any]:
    """Decode + verify a JWT. Raises :class:`JWTError` on failure."""
    settings = get_settings()
    payload = jwt.decode(
        token,
        settings.jwt_secret_key,
        algorithms=[settings.jwt_algorithm],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
    )
    if expected_type is not None and payload.get("typ") != expected_type:
        raise JWTError(f"Unexpected token type: {payload.get('typ')!r}")
    return payload
