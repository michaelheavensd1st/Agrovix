"""Role assignment — attaches a Role to a User at a specific scope."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.models.farm import Farm
    from app.models.organization import Organization
    from app.models.role import Role
    from app.models.user import User


class RoleAssignment(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Concrete authorization grant.

    Scope is implicit in the combination of nullable ``organization_id`` and
    ``farm_id``:

    * platform-scoped assignment       → both NULL
    * organization-scoped assignment   → org set, farm NULL
    * farm-scoped assignment           → both set (farm.organization_id must match)
    """

    __tablename__ = "role_assignments"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "role_id",
            "organization_id",
            "farm_id",
            name="uq_role_assignment_unique_grant",
        ),
        CheckConstraint(
            # farm-scoped assignments always require an organization_id
            "(farm_id IS NULL) OR (organization_id IS NOT NULL)",
            name="ck_role_assignment_farm_requires_org",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    farm_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("farms.id", ondelete="CASCADE"), nullable=True, index=True
    )

    granted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    user: Mapped[User] = relationship(
        "User", back_populates="role_assignments", foreign_keys=[user_id]
    )
    role: Mapped[Role] = relationship("Role", back_populates="assignments", lazy="joined")
    organization: Mapped[Organization | None] = relationship("Organization")
    farm: Mapped[Farm | None] = relationship("Farm")
