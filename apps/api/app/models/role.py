"""Role + Permission models.

Sprint 1 makes both **permission-driven**:
- Role no longer implies any hard-coded authorization behaviour.
- Access checks happen against ``Permission.code`` values.
- Roles carry a ``scope`` (platform / organization / farm) which
  determines *what kind of assignment* they may be attached to.
"""

from __future__ import annotations

import enum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Column, Enum, ForeignKey, String, Table
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.role_assignment import RoleAssignment


class RoleScope(enum.StrEnum):
    PLATFORM = "platform"
    ORGANIZATION = "organization"
    FARM = "farm"


role_permissions_table = Table(
    "role_permissions",
    Base.metadata,
    Column(
        "role_id", UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    ),
    Column(
        "permission_id",
        UUID(as_uuid=True),
        ForeignKey("permissions.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class Role(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    scope: Mapped[RoleScope] = mapped_column(
        Enum(RoleScope, name="role_scope"), nullable=False, default=RoleScope.ORGANIZATION
    )
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    permissions: Mapped[list[Permission]] = relationship(
        "Permission",
        secondary=role_permissions_table,
        back_populates="roles",
        lazy="selectin",
    )
    assignments: Mapped[list[RoleAssignment]] = relationship(
        "RoleAssignment",
        back_populates="role",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Role name={self.name!r} scope={self.scope.value}>"


class Permission(Base, UUIDPrimaryKeyMixin, TimestampMixin):
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
