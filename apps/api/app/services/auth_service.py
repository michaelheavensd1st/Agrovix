"""Authentication + verification service."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import HTTPException, status

from app.core.config import get_settings
from app.core.security import (
    TokenExpiredError,
    TokenInvalidError,
    create_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.email.base import EmailMessage, EmailSender
from app.models.user import User
from app.repositories.refresh_token_repo import RefreshTokenRepository
from app.repositories.user_repo import UserRepository
from app.repositories.verification_repo import VerificationTokenRepository
from app.schemas.auth import TokenPair


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AuthService:
    def __init__(
        self,
        *,
        user_repo: UserRepository,
        refresh_repo: RefreshTokenRepository,
        verification_repo: VerificationTokenRepository,
        email_sender: EmailSender,
    ) -> None:
        self.user_repo = user_repo
        self.refresh_repo = refresh_repo
        self.verification_repo = verification_repo
        self.email_sender = email_sender
        self.settings = get_settings()

    # ------------------------------------------------------------------ #
    # Register + verification
    # ------------------------------------------------------------------ #
    async def register(
        self, *, email: str, password: str, full_name: str | None = None
    ) -> User:
        existing = await self.user_repo.get_by_email(email)
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists.")
        user = await self.user_repo.create(
            email=email, hashed_password=hash_password(password), full_name=full_name,
        )
        await self._issue_verification_email(user)
        return user

    async def resend_verification(self, *, email: str) -> None:
        user = await self.user_repo.get_by_email(email)
        # Do not leak account existence — silently no-op if user not found.
        if user is None or user.is_verified:
            return
        await self.verification_repo.invalidate_all_for_user(user.id)
        await self._issue_verification_email(user)

    async def verify_email(self, *, token: str) -> User:
        try:
            payload = decode_token(token, expected_type="verify")
        except (TokenExpiredError, TokenInvalidError) as exc:
            raise self._bad_token() from exc

        token_hash = _hash_token(token)
        row = await self.verification_repo.get_by_hash(token_hash)
        if row is None or row.is_used or row.expires_at < datetime.now(timezone.utc):
            raise self._bad_token()

        try:
            user_id = UUID(payload["sub"])
        except (KeyError, ValueError) as exc:
            raise self._bad_token() from exc

        user = await self.user_repo.get_by_id(user_id)
        if user is None:
            raise self._bad_token()

        await self.verification_repo.mark_used(row)
        user = await self.user_repo.mark_verified(user)
        return user

    async def _issue_verification_email(self, user: User) -> None:
        token, expires_at = create_token(subject=user.id, token_type="verify")
        await self.verification_repo.create(
            user_id=user.id, token_hash=_hash_token(token), expires_at=expires_at
        )
        verify_url = f"{self.settings.web_app_url.rstrip('/')}/verify?token={token}"
        await self.email_sender.send(
            EmailMessage(
                to=user.email,
                subject="Verify your Agrovix AgOS account",
                text_body=(
                    "Welcome to Agrovix AgOS!\n\n"
                    f"Please verify your email by opening:\n{verify_url}\n\n"
                    f"This link expires in {self.settings.verification_token_expire_hours} hours.\n"
                ),
                template="auth.verify_email",
                context={"verify_url": verify_url, "user_email": user.email},
            )
        )

    # ------------------------------------------------------------------ #
    # Login / refresh / logout
    # ------------------------------------------------------------------ #
    async def login(
        self, *, email: str, password: str, user_agent: str | None = None, ip_address: str | None = None,
    ) -> tuple[User, TokenPair]:
        user = await self.user_repo.get_by_email(email)
        if user is None or user.hashed_password is None:
            raise self._invalid_credentials()
        if not verify_password(password, user.hashed_password):
            raise self._invalid_credentials()
        if not user.is_active:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled.")
        if not user.is_verified and not self.settings.allow_unverified_login:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Please verify your email before signing in.")

        tokens = await self._issue_token_pair(user=user, user_agent=user_agent, ip_address=ip_address)
        return user, tokens

    async def refresh(
        self, *, refresh_token: str, user_agent: str | None = None, ip_address: str | None = None,
    ) -> TokenPair:
        try:
            payload = decode_token(refresh_token, expected_type="refresh")
        except (TokenExpiredError, TokenInvalidError) as exc:
            raise self._invalid_refresh() from exc

        token_hash = _hash_token(refresh_token)
        stored = await self.refresh_repo.get_by_hash(token_hash)
        if stored is None or stored.is_revoked:
            raise self._invalid_refresh()
        # SQLite drops tz info — normalise before comparing.
        exp = stored.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < datetime.now(timezone.utc):
            raise self._invalid_refresh()

        try:
            user_id = UUID(payload["sub"])
        except (KeyError, ValueError) as exc:
            raise self._invalid_refresh() from exc

        user = await self.user_repo.get_by_id(user_id)
        if user is None or not user.is_active:
            raise self._invalid_refresh()

        await self.refresh_repo.revoke_by_hash(token_hash)
        return await self._issue_token_pair(user=user, user_agent=user_agent, ip_address=ip_address)

    async def logout(self, *, refresh_token: str) -> None:
        await self.refresh_repo.revoke_by_hash(_hash_token(refresh_token))

    async def _issue_token_pair(
        self, *, user: User, user_agent: str | None, ip_address: str | None,
    ) -> TokenPair:
        access_token, access_exp = create_token(
            subject=user.id, token_type="access", extra_claims={"email": user.email},
        )
        jti = secrets.token_urlsafe(16)
        refresh_token, refresh_exp = create_token(
            subject=user.id, token_type="refresh", extra_claims={"jti": jti},
        )
        await self.refresh_repo.create(
            user_id=user.id, token_hash=_hash_token(refresh_token),
            expires_at=refresh_exp, user_agent=user_agent, ip_address=ip_address,
        )
        expires_in = int((access_exp - datetime.now(timezone.utc)).total_seconds())
        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=max(expires_in, 0),
        )

    # Convenience for cookie handlers
    def token_lifetimes(self) -> tuple[timedelta, timedelta]:
        return (
            timedelta(minutes=self.settings.jwt_access_token_expire_minutes),
            timedelta(days=self.settings.jwt_refresh_token_expire_days),
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

    @staticmethod
    def _bad_token() -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired verification token.",
        )
