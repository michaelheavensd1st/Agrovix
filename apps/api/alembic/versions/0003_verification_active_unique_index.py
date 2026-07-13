"""Sprint 1 hardening: enforce single-active email-verification token per user.

Revision ID: 0003_verification_active_unique_index
Revises: 0002_sprint1_identity_tenancy
Create Date: 2026-02-06 00:00:00.000000

Adds a Postgres **partial unique index** on
``email_verification_tokens (user_id) WHERE is_used = false`` so that
even concurrent ``resend-verification`` requests cannot leave two
active tokens for the same user.

Application-layer invalidation (see ``VerificationTokenRepository``)
remains as a fast path; this migration is the last line of defence.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_verification_active_unique_index"
down_revision = "0002_sprint1_identity_tenancy"
branch_labels = None
depends_on = None


INDEX_NAME = "uq_email_verification_active_per_user"
TABLE_NAME = "email_verification_tokens"


def upgrade() -> None:
    # Best-effort: consolidate any pre-existing duplicate active tokens
    # (belt-and-suspenders — the app layer should already keep exactly one).
    op.execute(
        sa.text(
            f"""
            UPDATE {TABLE_NAME} t
               SET is_used = true,
                   used_at = COALESCE(t.used_at, NOW())
              FROM (
                    SELECT id
                      FROM (
                            SELECT id,
                                   ROW_NUMBER() OVER (
                                     PARTITION BY user_id
                                     ORDER BY created_at DESC
                                   ) AS rn
                              FROM {TABLE_NAME}
                             WHERE is_used = false
                          ) ranked
                     WHERE ranked.rn > 1
                  ) dupes
             WHERE t.id = dupes.id
            """
        )
    )

    op.create_index(
        INDEX_NAME,
        TABLE_NAME,
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_used = false"),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
