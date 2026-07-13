"""Authentication service.

Sprint 0 scope:
- Register (email + password), login, refresh, logout.
- Rotating refresh tokens with server-side revocation store.
- Deliberately provider-agnostic so Google/Microsoft/Apple/OTP can be
  added later without changing this module's public surface.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from jose import JWTError

from app.core.config import get_settings
from app.core.security import (
    create_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.user import User
from app.repositories.refresh_token_repo import RefreshTokenRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import TokenPair


def _hash_refresh_token(raw: str) -> str:
    """One-way hash for storage. Stored tokens are never reversible."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AuthService:
    """High-level authentication use-cases."""

    def __init__(
        self,
        user_repo: UserRepository,
        refresh_repo: RefreshTokenRepository,
    ) -> None:
        self.user_repo = user_repo
        self.refresh_repo = refresh_repo
        self.settings = get_settings()

    # ------------------------------------------------------------------ #
    # Registration
    # ------------------------------------------------------------------ #
    async def register(
        self,
        *,
        email: str,
        password: str,
        full_name: str | None = None,
    ) -> User:
        existing = await self.user_repo.get_by_email(email)
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="An account with that email already exists.",
            )

        user = await self.user_repo.create(
            email=email,
            hashed_password=hash_password(password),
            full_name=full_name,
        )
        return user

    # ------------------------------------------------------------------ #
    # Login
    # ------------------------------------------------------------------ #
    async def login(
        self,
        *,
        email: str,
        password: str,
        user_agent: str | None = None,
        ip_address: str | None = None,
    ) -> tuple[User, TokenPair]:
        user = await self.user_repo.get_by_email(email)
        if user is None or user.hashed_password is None:
            raise self._invalid_credentials()
        if not verify_password(password, user.hashed_password):
            raise self._invalid_credentials()
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This account is disabled.",
            )

        tokens = await self._issue_token_pair(
            user=user, user_agent=user_agent, ip_address=ip_address
        )
        return user, tokens

    # ------------------------------------------------------------------ #
    # Refresh
    # ------------------------------------------------------------------ #
    async def refresh(
        self,
        *,
        refresh_token: str,
        user_agent: str | None = None,
        ip_address: str | None = None,
    ) -> TokenPair:
        try:
            payload = decode_token(refresh_token, expected_type="refresh")
        except JWTError as exc:
            raise self._invalid_refresh() from exc

        token_hash = _hash_refresh_token(refresh_token)
        stored = await self.refresh_repo.get_by_hash(token_hash)
        if stored is None or stored.is_revoked:
            raise self._invalid_refresh()
        if stored.expires_at < datetime.now(timezone.utc):
            raise self._invalid_refresh()

        try:
            user_id = UUID(payload["sub"])
        except (KeyError, ValueError) as exc:
            raise self._invalid_refresh() from exc

        user = await self.user_repo.get_by_id(user_id)
        if user is None or not user.is_active:
            raise self._invalid_refresh()

        # Rotate: revoke the used refresh token, issue a fresh pair.
        await self.refresh_repo.revoke_by_hash(token_hash)
        return (await self._issue_token_pair(
            user=user, user_agent=user_agent, ip_address=ip_address
        ))

    # ------------------------------------------------------------------ #
    # Logout
    # ------------------------------------------------------------------ #
    async def logout(self, *, refresh_token: str) -> None:
        token_hash = _hash_refresh_token(refresh_token)
        await self.refresh_repo.revoke_by_hash(token_hash)

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    async def _issue_token_pair(
        self,
        *,
        user: User,
        user_agent: str | None,
        ip_address: str | None,
    ) -> TokenPair:
        roles = [r.name for r in user.roles]
        access_token, access_exp = create_token(
            subject=user.id,
            token_type="access",
            extra_claims={"email": user.email, "roles": roles},
        )
        # A per-token jti prevents refresh-token hash collisions between
        # rapid successive logins.
        jti = secrets.token_urlsafe(16)
        refresh_token, refresh_exp = create_token(
            subject=user.id,
            token_type="refresh",
            extra_claims={"jti": jti},
        )

        await self.refresh_repo.create(
            user_id=user.id,
            token_hash=_hash_refresh_token(refresh_token),
            expires_at=refresh_exp,
            user_agent=user_agent,
            ip_address=ip_address,
        )

        expires_in = int(
            (access_exp - datetime.now(timezone.utc)).total_seconds()
        )
        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=max(expires_in, 0),
        )

    @staticmethod
    def _invalid_credentials() -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    @staticmethod
    def _invalid_refresh() -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
