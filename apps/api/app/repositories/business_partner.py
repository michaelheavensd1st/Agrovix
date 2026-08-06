"""Release 6.0.2 — Business Partner repositories.

Pure data-access. No business rules; those live in
``app.services.business_partner``. Every query is
organization-scoped or partner-id-anchored (which the service
tenancy-authorises before we run).

Cursor pagination uses the opaque ``base64(<legal_name>|<uuid>)``
encoding described in §11.1 of the architecture — deterministic
tie-breaker on the UUID PK.
"""

from __future__ import annotations

import base64
import binascii
import uuid
from collections.abc import Sequence
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapability,
    BusinessPartnerCapabilityCode,
    BusinessPartnerContact,
    BusinessPartnerContactRole,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
    BusinessPartnerSupplierProfile,
)


# --------------------------------------------------------------------- #
# Cursor helpers (opaque, deterministic, tie-broken on UUID).
# --------------------------------------------------------------------- #
def encode_partner_cursor(legal_name: str, partner_id: uuid.UUID) -> str:
    raw = f"{legal_name}|{partner_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def decode_partner_cursor(cursor: str) -> tuple[str, uuid.UUID]:
    """Any decoding failure → HTTP 422 ``invalid_cursor``.

    Matches the frozen §11.1 pagination contract — never 500 for a
    garbage query parameter, never echo the parser error.
    """
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        name, id_str = raw.split("|", 1)
        return name, uuid.UUID(id_str)
    except (ValueError, TypeError, LookupError, binascii.Error) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {
                "code": "invalid_cursor",
                "message": "Malformed pagination cursor.",
                "context": {},
            },
        ) from exc


def encode_contact_cursor(name: str, contact_id: uuid.UUID) -> str:
    raw = f"{name}|{contact_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def decode_contact_cursor(cursor: str) -> tuple[str, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        name, id_str = raw.split("|", 1)
        return name, uuid.UUID(id_str)
    except (ValueError, TypeError, LookupError, binascii.Error) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {
                "code": "invalid_cursor",
                "message": "Malformed pagination cursor.",
                "context": {},
            },
        ) from exc


# --------------------------------------------------------------------- #
# BusinessPartnerRepository — aggregate root operations.
# --------------------------------------------------------------------- #
class BusinessPartnerRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(
        self, partner_id: uuid.UUID, *, with_relations: bool = False
    ) -> BusinessPartner | None:
        stmt = select(BusinessPartner).where(BusinessPartner.id == partner_id)
        if with_relations:
            stmt = stmt.options(
                selectinload(BusinessPartner.capabilities),
                selectinload(BusinessPartner.supplier_profile),
                selectinload(BusinessPartner.contacts),
            )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_by_org_and_code(
        self, organization_id: uuid.UUID, code: str
    ) -> BusinessPartner | None:
        stmt = select(BusinessPartner).where(
            BusinessPartner.organization_id == organization_id,
            BusinessPartner.code == code,
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def create(self, **kwargs) -> BusinessPartner:
        row = BusinessPartner(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def list_page(
        self,
        organization_id: uuid.UUID,
        *,
        capability: BusinessPartnerCapabilityCode | None = None,
        active: bool | None = None,
        qualification: BusinessPartnerQualificationStatus | None = None,
        preference: BusinessPartnerPreferenceTier | None = None,
        search: str | None = None,
        include_deleted: bool = False,
        cursor: str | None = None,
        limit: int = 50,
    ) -> tuple[list[BusinessPartner], str | None]:
        """Cursor page. Deterministic order: (legal_name ASC, id ASC).

        Returns ``(rows, next_cursor)`` where ``next_cursor`` is
        ``None`` when the caller has reached the last page.
        """
        base = select(BusinessPartner).where(BusinessPartner.organization_id == organization_id)
        if not include_deleted:
            base = base.where(BusinessPartner.deleted_at.is_(None))
        if active is not None:
            base = base.where(BusinessPartner.is_active.is_(active))
        if capability is not None:
            base = base.where(
                BusinessPartner.capabilities.any(BusinessPartnerCapability.capability == capability)
            )
        if qualification is not None or preference is not None:
            base = base.join(
                BusinessPartnerSupplierProfile,
                BusinessPartnerSupplierProfile.business_partner_id == BusinessPartner.id,
            )
            if qualification is not None:
                base = base.where(
                    BusinessPartnerSupplierProfile.qualification_status == qualification
                )
            if preference is not None:
                base = base.where(BusinessPartnerSupplierProfile.preference_tier == preference)
        if search:
            like = f"%{search.lower()}%"
            base = base.where(
                or_(
                    func.lower(BusinessPartner.code).like(like),
                    func.lower(BusinessPartner.legal_name).like(like),
                    func.lower(func.coalesce(BusinessPartner.trading_name, "")).like(like),
                )
            )
        if cursor:
            cur_name, cur_id = decode_partner_cursor(cursor)
            base = base.where(
                or_(
                    BusinessPartner.legal_name > cur_name,
                    and_(
                        BusinessPartner.legal_name == cur_name,
                        BusinessPartner.id > cur_id,
                    ),
                )
            )
        stmt = (
            base.order_by(BusinessPartner.legal_name.asc(), BusinessPartner.id.asc())
            .limit(limit + 1)
            .options(
                selectinload(BusinessPartner.capabilities),
                selectinload(BusinessPartner.supplier_profile),
                selectinload(BusinessPartner.contacts),
            )
        )
        rows = list((await self.session.execute(stmt)).scalars().unique())
        next_cursor: str | None = None
        if len(rows) > limit:
            rows = rows[:limit]
            tail = rows[-1]
            next_cursor = encode_partner_cursor(tail.legal_name, tail.id)
        return rows, next_cursor


# --------------------------------------------------------------------- #
# Capability + profile + contact repos — thin data-access wrappers.
# --------------------------------------------------------------------- #
class BusinessPartnerCapabilityRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_for_partner(self, partner_id: uuid.UUID) -> list[BusinessPartnerCapability]:
        stmt = (
            select(BusinessPartnerCapability)
            .where(BusinessPartnerCapability.business_partner_id == partner_id)
            .order_by(BusinessPartnerCapability.capability.asc())
        )
        return list((await self.session.execute(stmt)).scalars().unique())

    async def get(
        self, partner_id: uuid.UUID, capability: BusinessPartnerCapabilityCode
    ) -> BusinessPartnerCapability | None:
        stmt = select(BusinessPartnerCapability).where(
            BusinessPartnerCapability.business_partner_id == partner_id,
            BusinessPartnerCapability.capability == capability,
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def add(
        self, partner_id: uuid.UUID, capability: BusinessPartnerCapabilityCode
    ) -> BusinessPartnerCapability:
        row = BusinessPartnerCapability(business_partner_id=partner_id, capability=capability)
        self.session.add(row)
        await self.session.flush()
        return row

    async def delete(self, row: BusinessPartnerCapability) -> None:
        await self.session.delete(row)
        await self.session.flush()


class BusinessPartnerSupplierProfileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_for_partner(self, partner_id: uuid.UUID) -> BusinessPartnerSupplierProfile | None:
        stmt = select(BusinessPartnerSupplierProfile).where(
            BusinessPartnerSupplierProfile.business_partner_id == partner_id
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def create(self, **kwargs) -> BusinessPartnerSupplierProfile:
        row = BusinessPartnerSupplierProfile(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row


class BusinessPartnerContactRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, contact_id: uuid.UUID) -> BusinessPartnerContact | None:
        stmt = select(BusinessPartnerContact).where(BusinessPartnerContact.id == contact_id)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def create(self, **kwargs) -> BusinessPartnerContact:
        row = BusinessPartnerContact(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def list_active_primary_for_role(
        self,
        partner_id: uuid.UUID,
        role: BusinessPartnerContactRole,
    ) -> list[BusinessPartnerContact]:
        stmt = select(BusinessPartnerContact).where(
            BusinessPartnerContact.business_partner_id == partner_id,
            BusinessPartnerContact.contact_role == role,
            BusinessPartnerContact.is_primary.is_(True),
            BusinessPartnerContact.is_active.is_(True),
            BusinessPartnerContact.deleted_at.is_(None),
        )
        return list((await self.session.execute(stmt)).scalars().unique())

    async def list_page(
        self,
        partner_id: uuid.UUID,
        *,
        include_inactive: bool = False,
        cursor: str | None = None,
        limit: int = 50,
    ) -> tuple[list[BusinessPartnerContact], str | None]:
        base = select(BusinessPartnerContact).where(
            BusinessPartnerContact.business_partner_id == partner_id,
            BusinessPartnerContact.deleted_at.is_(None),
        )
        if not include_inactive:
            base = base.where(BusinessPartnerContact.is_active.is_(True))
        if cursor:
            cur_name, cur_id = decode_contact_cursor(cursor)
            base = base.where(
                or_(
                    BusinessPartnerContact.name > cur_name,
                    and_(
                        BusinessPartnerContact.name == cur_name,
                        BusinessPartnerContact.id > cur_id,
                    ),
                )
            )
        stmt = base.order_by(
            BusinessPartnerContact.name.asc(),
            BusinessPartnerContact.id.asc(),
        ).limit(limit + 1)
        rows = list((await self.session.execute(stmt)).scalars().unique())
        next_cursor: str | None = None
        if len(rows) > limit:
            rows = rows[:limit]
            tail = rows[-1]
            next_cursor = encode_contact_cursor(tail.name, tail.id)
        return rows, next_cursor


# Type annotations — surface the concrete list type for downstream
# services + endpoints without exposing raw ``Sequence``.
_ = cast(Sequence[BusinessPartner], [])


__all__ = [
    "BusinessPartnerCapabilityRepository",
    "BusinessPartnerContactRepository",
    "BusinessPartnerRepository",
    "BusinessPartnerSupplierProfileRepository",
    "decode_contact_cursor",
    "decode_partner_cursor",
    "encode_contact_cursor",
    "encode_partner_cursor",
]
