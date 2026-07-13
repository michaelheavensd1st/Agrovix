"""Role + Permission models for RBAC.

Designed as an extensible foundation:
- Users have many Roles (many-to-many)
- Roles have many Permissions (many-to-many)
- New providers / scopes can be introduced without altering the User model.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Column, ForeignKey, String, Table
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.user import User


# --- Association tables ---------------------------------------------------

user_roles_table = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)

role_permissions_table = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", UUID(as_uuid=True), ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


# --- Entities -------------------------------------------------------------

class Role(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """RBAC role (e.g. ``admin``, ``farm_manager``, ``field_worker``)."""

    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)

    users: Mapped[list["User"]] = relationship(
        "User",
        secondary=user_roles_table,
        back_populates="roles",
    )
    permissions: Mapped[list["Permission"]] = relationship(
        "Permission",
        secondary=role_permissions_table,
        back_populates="roles",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Role name={self.name!r}>"


class Permission(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Fine-grained permission (e.g. ``farm.read``, ``farm.write``)."""

    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)

    roles: Mapped[list[Role]] = relationship(
        "Role",
        secondary=role_permissions_table,
        back_populates="permissions",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Permission code={self.code!r}>"
