"""User model.

Designed to be identity-provider-agnostic:
- ``hashed_password`` is optional so SSO-only accounts remain valid.
- ``identities`` (linked in a future sprint) will carry the ``{provider, subject}``
  tuple for Google/Microsoft/Apple/OTP flows.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.role import user_roles_table

if TYPE_CHECKING:
    from app.models.refresh_token import RefreshToken
    from app.models.role import Role


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A user account in the AgOS platform."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)

    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_superuser: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    roles: Mapped[list["Role"]] = relationship(
        "Role",
        secondary=user_roles_table,
        back_populates="users",
        lazy="selectin",
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken",
        back_populates="user",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User id={self.id} email={self.email!r}>"
