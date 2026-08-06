"""Release 6.0.2 — Business Partner aggregate + supplier profile + capabilities + contacts.

Adds:

* ``business_partners`` — aggregate root (org-owned, code-unique
  within org across all lifecycle states).
* ``business_partner_capabilities`` — many-to-many-ish detail
  table with a unique ``(business_partner_id, capability)`` guard.
* ``business_partner_supplier_profiles`` — one-to-one supplier
  profile with qualification + preference.
* ``business_partner_contacts`` — multi-contact with a partial
  unique index enforcing at-most-one active primary contact per
  ``(partner, role)``.

Enums (Postgres native, SQLite CHECK constraint):

* ``business_partner_capability``
* ``business_partner_qualification_status``
* ``business_partner_preference_tier``
* ``business_partner_contact_role``

Also seeds the four Business Partner permissions and grants them
to the roles defined in §12 of the canonical architecture
(``docs/architecture/release-6.0-purchase-to-stock.md``).

Revision ID: 0011_business_partners
Revises: 0010_sprint_5_4_12_reconcile_ddl
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# ------------------------------------------------------------------ #
revision: str = "0011_business_partners"
down_revision: str | None = "0010_sprint_5_4_12_reconcile_ddl"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


_CAPABILITY_VALUES = (
    "supplier",
    "customer",
    "transporter",
    "contractor",
    "veterinary_service",
    "laboratory",
    "consultant",
    "other",
)
_QUALIFICATION_VALUES = ("unqualified", "approved", "blocked")
_PREFERENCE_VALUES = ("standard", "preferred")
_CONTACT_ROLE_VALUES = (
    "accounts",
    "warehouse",
    "sales",
    "driver",
    "managing_director",
    "technical",
    "other",
)


def _pg_enum(name: str, values: tuple[str, ...]) -> postgresql.ENUM:
    return postgresql.ENUM(*values, name=name, create_type=False)


# ------------------------------------------------------------------ #
# Frozen permission + role-grant list — sourced verbatim from
# canonical architecture §12. Any change must go back to review.
# ------------------------------------------------------------------ #
_PARTNER_PERMISSIONS: tuple[tuple[str, str], ...] = (
    ("business_partner.read", "Read Business Partners"),
    ("business_partner.create", "Create Business Partners"),
    ("business_partner.update", "Update Business Partners"),
    ("business_partner.deactivate", "Deactivate or restore Business Partners"),
)

# role_name → tuple of partner permission codes.
_ROLE_GRANTS: dict[str, tuple[str, ...]] = {
    "organization_owner": (
        "business_partner.read",
        "business_partner.create",
        "business_partner.update",
        "business_partner.deactivate",
    ),
    "farm_director": (
        "business_partner.read",
        "business_partner.create",
        "business_partner.update",
    ),
    "farm_manager": ("business_partner.read",),
    "supervisor": ("business_partner.read",),
    "storekeeper": ("business_partner.read",),
    "accountant": ("business_partner.read",),
    "viewer": ("business_partner.read",),
}


def _seed_permissions(bind: sa.engine.Connection) -> None:
    """Idempotent — safe to run on every deploy.

    Uses the existing ``permissions`` + ``role_permissions`` tables
    seeded by ``app.seed`` — this migration is the persistence
    boundary that lets the seeder wire up role grants.
    """
    # Insert permission rows if missing (do not overwrite descriptions).
    for code, description in _PARTNER_PERMISSIONS:
        bind.execute(
            sa.text(
                """
                INSERT INTO permissions (id, code, description, created_at, updated_at)
                VALUES (gen_random_uuid(), :code, :description, now(), now())
                ON CONFLICT (code) DO NOTHING
                """
            )
            if bind.dialect.name == "postgresql"
            else sa.text(
                """
                INSERT OR IGNORE INTO permissions (id, code, description, created_at, updated_at)
                VALUES (lower(hex(randomblob(16))), :code, :description,
                        strftime('%Y-%m-%d %H:%M:%f000+00:00','now'),
                        strftime('%Y-%m-%d %H:%M:%f000+00:00','now'))
                """
            ),
            {"code": code, "description": description},
        )

    for role_name, codes in _ROLE_GRANTS.items():
        for code in codes:
            # NOTE: role_id / permission_id joins go through a plain
            # sub-select — this migration inherits the existing
            # ``permissions`` + ``roles`` tables from earlier revisions.
            bind.execute(
                sa.text(
                    """
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                      FROM roles r
                      JOIN permissions p ON p.code = :code
                     WHERE r.name = :role_name
                       AND NOT EXISTS (
                         SELECT 1 FROM role_permissions rp
                          WHERE rp.role_id = r.id AND rp.permission_id = p.id
                       )
                    """
                ),
                {"role_name": role_name, "code": code},
            )


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # --- Enums --------------------------------------------------- #
    if is_pg:
        sa.Enum(*_CAPABILITY_VALUES, name="business_partner_capability").create(
            bind, checkfirst=True
        )
        sa.Enum(
            *_QUALIFICATION_VALUES, name="business_partner_qualification_status"
        ).create(bind, checkfirst=True)
        sa.Enum(*_PREFERENCE_VALUES, name="business_partner_preference_tier").create(
            bind, checkfirst=True
        )
        sa.Enum(*_CONTACT_ROLE_VALUES, name="business_partner_contact_role").create(
            bind, checkfirst=True
        )

        capability_col = _pg_enum("business_partner_capability", _CAPABILITY_VALUES)
        qual_col = _pg_enum(
            "business_partner_qualification_status", _QUALIFICATION_VALUES
        )
        pref_col = _pg_enum("business_partner_preference_tier", _PREFERENCE_VALUES)
        contact_role_col = _pg_enum(
            "business_partner_contact_role", _CONTACT_ROLE_VALUES
        )
    else:
        capability_col = sa.Enum(
            *_CAPABILITY_VALUES, name="business_partner_capability"
        )
        qual_col = sa.Enum(
            *_QUALIFICATION_VALUES, name="business_partner_qualification_status"
        )
        pref_col = sa.Enum(*_PREFERENCE_VALUES, name="business_partner_preference_tier")
        contact_role_col = sa.Enum(
            *_CONTACT_ROLE_VALUES, name="business_partner_contact_role"
        )

    # --- business_partners --------------------------------------- #
    op.create_table(
        "business_partners",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("legal_name", sa.String(255), nullable=False),
        sa.Column("trading_name", sa.String(255), nullable=True),
        # §4.1 — bounded structured JSONB address.
        sa.Column("primary_address", postgresql.JSONB, nullable=True),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("phone", sa.String(80), nullable=True),
        # ISO 3166-1 alpha-2 (uppercased, validated at API layer).
        sa.Column("country_code", sa.String(2), nullable=True),
        sa.Column("tax_identifier", sa.String(80), nullable=True),
        sa.Column("notes", sa.String(2000), nullable=True),
        # §4.1 — bounded presentation metadata (size cap at API layer).
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivation_reason", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "organization_id", "code", name="uq_business_partner_org_code"
        ),
        sa.CheckConstraint(
            "length(trim(code)) > 0", name="ck_business_partner_code_non_empty"
        ),
        sa.CheckConstraint(
            "length(trim(legal_name)) > 0",
            name="ck_business_partner_legal_name_non_empty",
        ),
        sa.CheckConstraint(
            "country_code IS NULL OR length(country_code) = 2",
            name="ck_business_partner_country_code_len2",
        ),
    )
    op.create_index(
        "ix_business_partners_organization_id",
        "business_partners",
        ["organization_id"],
    )
    op.create_index(
        "ix_business_partners_deleted_at",
        "business_partners",
        ["deleted_at"],
    )
    op.create_index(
        "ix_business_partners_org_active_legalname_id",
        "business_partners",
        ["organization_id", "is_active", "legal_name", "id"],
    )

    # --- business_partner_capabilities --------------------------- #
    op.create_table(
        "business_partner_capabilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "business_partner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("business_partners.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("capability", capability_col, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "business_partner_id",
            "capability",
            name="uq_business_partner_capability",
        ),
    )
    op.create_index(
        "ix_business_partner_capabilities_business_partner_id",
        "business_partner_capabilities",
        ["business_partner_id"],
    )

    # --- business_partner_supplier_profiles ---------------------- #
    op.create_table(
        "business_partner_supplier_profiles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "business_partner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("business_partners.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "qualification_status",
            qual_col,
            nullable=False,
            server_default="unqualified",
        ),
        sa.Column("qualification_note", sa.String(2000), nullable=True),
        sa.Column(
            "qualified_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("qualified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "preference_tier",
            pref_col,
            nullable=False,
            server_default="standard",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "business_partner_id", name="uq_business_partner_supplier_profile"
        ),
    )

    # --- business_partner_contacts ------------------------------- #
    op.create_table(
        "business_partner_contacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "business_partner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("business_partners.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("job_title", sa.String(255), nullable=True),
        sa.Column("email", sa.String(320), nullable=True),
        sa.Column("phone", sa.String(80), nullable=True),
        sa.Column("contact_role", contact_role_col, nullable=False),
        sa.Column(
            "is_primary",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "is_active",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("notes", sa.String(2000), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivation_reason", sa.String(500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(trim(name)) > 0",
            name="ck_business_partner_contact_name_non_empty",
        ),
    )
    op.create_index(
        "ix_business_partner_contacts_business_partner_id",
        "business_partner_contacts",
        ["business_partner_id"],
    )
    op.create_index(
        "ix_business_partner_contacts_deleted_at",
        "business_partner_contacts",
        ["deleted_at"],
    )
    op.create_index(
        "ix_business_partner_contact_partner_active_name_id",
        "business_partner_contacts",
        ["business_partner_id", "is_active", "name", "id"],
    )

    # Partial unique index — one active primary contact per
    # (partner, role). Both Postgres and SQLite support partial
    # indexes; use raw SQL for the filter clause.
    if is_pg:
        op.execute(
            """
            CREATE UNIQUE INDEX uq_business_partner_contact_primary_per_role
                ON business_partner_contacts (business_partner_id, contact_role)
             WHERE is_primary IS TRUE
               AND is_active IS TRUE
               AND deleted_at IS NULL
            """
        )
    else:
        op.execute(
            """
            CREATE UNIQUE INDEX uq_business_partner_contact_primary_per_role
                ON business_partner_contacts (business_partner_id, contact_role)
             WHERE is_primary = 1
               AND is_active = 1
               AND deleted_at IS NULL
            """
        )

    # --- Seeded permissions + role grants (§12) ------------------ #
    _seed_permissions(bind)


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # --- role_permission grants (revoke Business Partner codes) -- #
    for code, _ in _PARTNER_PERMISSIONS:
        bind.execute(
            sa.text(
                """
                DELETE FROM role_permissions
                 WHERE permission_id IN (
                     SELECT id FROM permissions WHERE code = :code
                 )
                """
            ),
            {"code": code},
        )
    # Do NOT delete the permission rows themselves — a downgrade
    # should be reversible without cascading to any custom roles a
    # human may have granted the permission to outside seed.

    op.drop_index(
        "uq_business_partner_contact_primary_per_role",
        table_name="business_partner_contacts",
    )
    op.drop_index(
        "ix_business_partner_contact_partner_active_name_id",
        table_name="business_partner_contacts",
    )
    op.drop_index(
        "ix_business_partner_contacts_deleted_at",
        table_name="business_partner_contacts",
    )
    op.drop_index(
        "ix_business_partner_contacts_business_partner_id",
        table_name="business_partner_contacts",
    )
    op.drop_table("business_partner_contacts")

    op.drop_table("business_partner_supplier_profiles")

    op.drop_index(
        "ix_business_partner_capabilities_business_partner_id",
        table_name="business_partner_capabilities",
    )
    op.drop_table("business_partner_capabilities")

    op.drop_index(
        "ix_business_partners_org_active_legalname_id",
        table_name="business_partners",
    )
    op.drop_index(
        "ix_business_partners_deleted_at",
        table_name="business_partners",
    )
    op.drop_index(
        "ix_business_partners_organization_id",
        table_name="business_partners",
    )
    op.drop_table("business_partners")

    if is_pg:
        sa.Enum(name="business_partner_contact_role").drop(bind, checkfirst=True)
        sa.Enum(name="business_partner_preference_tier").drop(bind, checkfirst=True)
        sa.Enum(name="business_partner_qualification_status").drop(
            bind, checkfirst=True
        )
        sa.Enum(name="business_partner_capability").drop(bind, checkfirst=True)


__all__ = ["down_revision", "downgrade", "revision", "upgrade"]
