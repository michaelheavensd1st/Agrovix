"""Release 6.0.2 — Business Partner aggregate.

Frozen contract lives in
``docs/architecture/release-6.0-purchase-to-stock.md`` §4. Every
model shape below maps 1:1 to that document. Any semantic change
must go back to architecture review before code changes.

Design highlights:

* **General partner aggregate** — a single ``business_partners``
  row can carry supplier, customer, transporter, or any other
  future capability. Release 6.0's UI is supplier-oriented but the
  domain model stays deliberately general.
* **Capabilities are a separate relation** — never a
  comma-separated column or an overloaded ``partner_type`` field.
* **Qualification and preference are separate concepts** — never
  collapsed into a single boolean. Only ``qualification=approved``
  + ``supplier`` capability may participate in purchasing (Release
  6.0.3 enforcement).
* **Historical-reference-safe deactivation** — ``is_active``
  toggles usability without erasing history; ``deleted_at``
  provides an administrative soft-delete. No hard-delete API
  exists.
* **Contact multiplicity** — a partner has many contacts, each
  with a role. At most one active *primary* contact per
  ``(partner, role)`` is enforced with a partial unique index.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON as _JSON
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy import (
    Enum as SQLEnum,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

# JSONB on Postgres, plain JSON on SQLite tests.
_PARTNER_JSONB = JSONB().with_variant(_JSON(), "sqlite")

if TYPE_CHECKING:
    from app.models.organization import Organization
    from app.models.user import User


# --------------------------------------------------------------------- #
# Frozen enums — do NOT add values here without a new architecture pass.
# --------------------------------------------------------------------- #
class BusinessPartnerCapabilityCode(enum.StrEnum):
    SUPPLIER = "supplier"
    CUSTOMER = "customer"
    TRANSPORTER = "transporter"
    CONTRACTOR = "contractor"
    VETERINARY_SERVICE = "veterinary_service"
    LABORATORY = "laboratory"
    CONSULTANT = "consultant"
    OTHER = "other"


class BusinessPartnerQualificationStatus(enum.StrEnum):
    UNQUALIFIED = "unqualified"
    APPROVED = "approved"
    BLOCKED = "blocked"


class BusinessPartnerPreferenceTier(enum.StrEnum):
    STANDARD = "standard"
    PREFERRED = "preferred"


class BusinessPartnerContactRole(enum.StrEnum):
    ACCOUNTS = "accounts"
    WAREHOUSE = "warehouse"
    SALES = "sales"
    DRIVER = "driver"
    MANAGING_DIRECTOR = "managing_director"
    TECHNICAL = "technical"
    OTHER = "other"


# --------------------------------------------------------------------- #
# Aggregate root.
# --------------------------------------------------------------------- #
class BusinessPartner(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """An organization-owned Business Partner.

    Immutable after first reference: ``organization_id``, ``code``.
    Mutable via ``PATCH``: ``legal_name``, ``trading_name``,
    address fields, ``notes``.
    """

    __tablename__ = "business_partners"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    legal_name: Mapped[str] = mapped_column(String(255), nullable=False)
    trading_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # §4.1 — primary_address is a bounded JSONB object with the frozen
    # keys {line1, line2, city, region, postal_code, country_code}.
    # Schema validation enforces the shape at the API boundary.
    primary_address: Mapped[dict | None] = mapped_column(_PARTNER_JSONB, nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # ISO 3166-1 alpha-2 partner-level country code (uppercased).
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    tax_identifier: Mapped[str | None] = mapped_column(String(80), nullable=True)
    notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # §4.1 — bounded JSONB for non-core presentation metadata.
    # Schema-layer size cap prevents unbounded documents from ever
    # reaching the DB. Not for secrets, not an audit-payload duplicate.
    metadata_json: Mapped[dict | None] = mapped_column("metadata", _PARTNER_JSONB, nullable=True)

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deactivation_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    organization: Mapped[Organization] = relationship("Organization")
    capabilities: Mapped[list[BusinessPartnerCapability]] = relationship(
        back_populates="business_partner",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    supplier_profile: Mapped[BusinessPartnerSupplierProfile | None] = relationship(
        back_populates="business_partner",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    contacts: Mapped[list[BusinessPartnerContact]] = relationship(
        back_populates="business_partner",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (
        # §4.2 — code is unique within an organization ACROSS all
        # lifecycle states. Codes are NEVER recycled for another
        # legal entity.
        UniqueConstraint(
            "organization_id", "code", name="uq_business_partner_org_code"
        ),
        CheckConstraint(
            "length(btrim(code)) > 0", name="ck_business_partner_code_non_empty"
        ),
        CheckConstraint(
            "length(btrim(legal_name)) > 0",
            name="ck_business_partner_legal_name_non_empty",
        ),
        # ISO 3166-1 alpha-2 length enforced at the DB layer; the
        # uppercase-alpha regex is enforced by the Pydantic schema
        # to stay portable across PostgreSQL and SQLite.
        CheckConstraint(
            "country_code IS NULL OR length(country_code) = 2",
            name="ck_business_partner_country_code_len2",
        ),
        Index(
            "ix_business_partners_org_active_legalname_id",
            "organization_id",
            "is_active",
            "legal_name",
            "id",
        ),
    )


# --------------------------------------------------------------------- #
# Capabilities — separate relation, one row per (partner, capability).
# --------------------------------------------------------------------- #
class BusinessPartnerCapability(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "business_partner_capabilities"

    business_partner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("business_partners.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    capability: Mapped[BusinessPartnerCapabilityCode] = mapped_column(
        SQLEnum(
            BusinessPartnerCapabilityCode,
            name="business_partner_capability",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )

    business_partner: Mapped[BusinessPartner] = relationship(back_populates="capabilities")

    __table_args__ = (
        UniqueConstraint(
            "business_partner_id",
            "capability",
            name="uq_business_partner_capability",
        ),
    )


# --------------------------------------------------------------------- #
# Supplier profile — one-to-one with a partner that has SUPPLIER
# capability. Enforcing "must have SUPPLIER capability" lives in the
# service layer so we can produce the frozen deterministic error
# envelope instead of a raw FK violation.
# --------------------------------------------------------------------- #
class BusinessPartnerSupplierProfile(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "business_partner_supplier_profiles"

    business_partner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("business_partners.id", ondelete="CASCADE"),
        nullable=False,
    )
    qualification_status: Mapped[BusinessPartnerQualificationStatus] = mapped_column(
        SQLEnum(
            BusinessPartnerQualificationStatus,
            name="business_partner_qualification_status",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=BusinessPartnerQualificationStatus.UNQUALIFIED,
        server_default=BusinessPartnerQualificationStatus.UNQUALIFIED.value,
    )
    qualification_note: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    qualified_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    qualified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    preference_tier: Mapped[BusinessPartnerPreferenceTier] = mapped_column(
        SQLEnum(
            BusinessPartnerPreferenceTier,
            name="business_partner_preference_tier",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=BusinessPartnerPreferenceTier.STANDARD,
        server_default=BusinessPartnerPreferenceTier.STANDARD.value,
    )

    business_partner: Mapped[BusinessPartner] = relationship(back_populates="supplier_profile")
    qualified_by: Mapped[User | None] = relationship("User")

    __table_args__ = (
        UniqueConstraint(
            "business_partner_id", name="uq_business_partner_supplier_profile"
        ),
    )


# --------------------------------------------------------------------- #
# Contacts.
# --------------------------------------------------------------------- #
class BusinessPartnerContact(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "business_partner_contacts"

    business_partner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("business_partners.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(80), nullable=True)
    contact_role: Mapped[BusinessPartnerContactRole] = mapped_column(
        SQLEnum(
            BusinessPartnerContactRole,
            name="business_partner_contact_role",
            native_enum=True,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deactivation_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)

    business_partner: Mapped[BusinessPartner] = relationship(back_populates="contacts")

    __table_args__ = (
        CheckConstraint(
            "length(btrim(name)) > 0", name="ck_business_partner_contact_name_non_empty"
        ),
        Index(
            "ix_business_partner_contact_partner_active_name_id",
            "business_partner_id",
            "is_active",
            "name",
            "id",
        ),
    )


# --------------------------------------------------------------------- #
# Partial unique index for "one active primary contact per (partner, role)".
# Implemented as a Postgres partial index at migration time (SQLite
# gets a functionally-equivalent partial-index clause too — SQLite
# supports partial unique indexes).
# --------------------------------------------------------------------- #
Index(
    "uq_business_partner_contact_primary_per_role",
    BusinessPartnerContact.business_partner_id,
    BusinessPartnerContact.contact_role,
    unique=True,
    postgresql_where=(
        (BusinessPartnerContact.is_primary.is_(True))
        & (BusinessPartnerContact.is_active.is_(True))
        & (BusinessPartnerContact.deleted_at.is_(None))
    ),
    sqlite_where=(
        (BusinessPartnerContact.is_primary.is_(True))
        & (BusinessPartnerContact.is_active.is_(True))
        & (BusinessPartnerContact.deleted_at.is_(None))
    ),
)


__all__ = [
    "BusinessPartner",
    "BusinessPartnerCapability",
    "BusinessPartnerCapabilityCode",
    "BusinessPartnerContact",
    "BusinessPartnerContactRole",
    "BusinessPartnerPreferenceTier",
    "BusinessPartnerQualificationStatus",
    "BusinessPartnerSupplierProfile",
]
