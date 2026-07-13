"""Password hashing + JWT helpers.

The JWT layer surfaces expired-vs-invalid as distinct exceptions so
callers can respond with precise error messages.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from jose import ExpiredSignatureError, JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings

TokenType = Literal["access", "refresh", "verify", "invite"]

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# --- Password hashing ------------------------------------------------------
def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)


# --- JWT -------------------------------------------------------------------
class TokenExpiredError(Exception):
    """The JWT was well-formed but expired."""


class TokenInvalidError(Exception):
    """The JWT failed any other validation (bad signature, wrong type, …)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_token(
    *,
    subject: str | UUID,
    token_type: TokenType,
    expires_delta: timedelta | None = None,
    extra_claims: dict[str, Any] | None = None,
) -> tuple[str, datetime]:
    settings = get_settings()
    now = _now()

    if expires_delta is None:
        if token_type == "access":
            expires_delta = timedelta(minutes=settings.jwt_access_token_expire_minutes)
        elif token_type == "refresh":
            expires_delta = timedelta(days=settings.jwt_refresh_token_expire_days)
        elif token_type == "verify":
            expires_delta = timedelta(hours=settings.verification_token_expire_hours)
        else:
            expires_delta = timedelta(days=settings.invitation_token_expire_days)

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
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
        )
    except ExpiredSignatureError as exc:
        raise TokenExpiredError("Token has expired.") from exc
    except JWTError as exc:
        raise TokenInvalidError(str(exc)) from exc

    if expected_type is not None and payload.get("typ") != expected_type:
        raise TokenInvalidError(f"Unexpected token type: {payload.get('typ')!r}")
    return payload
