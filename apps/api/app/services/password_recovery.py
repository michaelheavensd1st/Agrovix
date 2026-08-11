"""Release 6.0.5 password-recovery persistence/security kernel.

This module intentionally has no HTTP, email, audit, password-mutation,
cookie, or session-revocation behavior. It owns opaque-token creation and
the frozen user-first persistence locking protocol only.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from app.core.config import get_settings
from app.models.password_recovery import PasswordRecoveryToken
from app.repositories.password_recovery import PasswordRecoveryTokenRepository
from app.repositories.user_repo import UserRepository


def generate_recovery_token() -> str:
    """Return a URL-safe token backed by 32 CSPRNG bytes (256 bits)."""
    return secrets.token_urlsafe(32)


def hash_recovery_token(raw_token: str) -> str:
    """Return the canonical lowercase SHA-256 hexadecimal digest."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


class PasswordRecoveryKernel:
    def __init__(
        self,
        *,
        user_repo: UserRepository,
        token_repo: PasswordRecoveryTokenRepository,
    ) -> None:
        if user_repo.session is not token_repo.session:
            raise ValueError("Password-recovery repositories must share one transaction.")
        self.user_repo = user_repo
        self.token_repo = token_repo
        self.settings = get_settings()

    async def issue(
        self, *, user_id: uuid.UUID, now: datetime | None = None
    ) -> tuple[str, PasswordRecoveryToken] | None:
        """Issue the newest outstanding token under the user-first lock."""
        user = await self.user_repo.get_by_id_for_update(user_id)
        if user is None:
            return None
        issued_at = _utc(now)

        outstanding = await self.token_repo.list_outstanding_for_user_for_update(user.id)
        await self.token_repo.invalidate_rows(outstanding, invalidated_at=issued_at)

        raw_token = generate_recovery_token()
        row = await self.token_repo.create(
            user_id=user.id,
            token_hash=hash_recovery_token(raw_token),
            created_at=issued_at,
            expires_at=issued_at
            + timedelta(minutes=self.settings.password_recovery_token_expire_minutes),
        )
        return raw_token, row

    async def consume(
        self, *, raw_token: str, now: datetime | None = None
    ) -> PasswordRecoveryToken | None:
        """Consume one valid token, locking its user before its row.

        Invalid, expired, invalidated, or previously consumed credentials
        return ``None`` and leave persistence unchanged.
        """
        token_hash = hash_recovery_token(raw_token)
        identity = await self.token_repo.resolve_identity_by_hash(token_hash)
        if identity is None:
            return None

        user = await self.user_repo.get_by_id_for_update(identity.user_id)
        if user is None:
            return None
        row = await self.token_repo.get_by_id_for_update(
            token_id=identity.id,
            user_id=user.id,
        )
        if row is None or row.token_hash != token_hash:
            return None
        if row.consumed_at is not None or row.invalidated_at is not None:
            return None
        consumed_at = _utc(now)
        if _utc(row.expires_at) <= consumed_at:
            return None
        return await self.token_repo.mark_consumed(row, consumed_at=consumed_at)


def _utc(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


__all__ = ["PasswordRecoveryKernel", "generate_recovery_token", "hash_recovery_token"]
