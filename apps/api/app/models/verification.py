"""Email verification token (hashed at rest, single-use, expiring).

Invariant: at most one active (``is_used = false``) token exists per
user at a time. This is enforced in three layers:

1. Application layer — :class:`AuthService` invalidates residual tokens
   before issuing a new one and again after a successful verify.
2. Database (Postgres) — a **partial unique index** on
   ``(user_id) WHERE is_used = false`` (migration
   ``0003_verification_active_unique_index``) protects the invariant
   against concurrent ``resend-verification`` requests.
3. Rate limiting — :class:`RateLimiter` throttles ``resend-verification``
   per email + per IP so an attacker cannot spin up new tokens rapidly.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.user import User


class EmailVerificationToken(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "email_verification_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    user: Mapped[User] = relationship("User", back_populates="verification_tokens")
