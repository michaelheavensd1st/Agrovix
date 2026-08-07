"""Release 6.0.2 — Business Partner service.

All business rules from §4 / §11.2 / §13 of the canonical
architecture live here. Repositories are pure data access; the
endpoint layer is a thin request/response shell. Every mutation
runs inside the FastAPI-provided session transaction — services
NEVER commit independently.

Frozen invariants enforced here:

* organization ownership + tenant-hidden 404
* uppercase code, non-empty legal_name, per-org unique
* capability duplicate prevention
* supplier profile requires ``supplier`` capability
* qualification / preference are separate concepts
* qualified_by_id + qualified_at are server-controlled
* at-most-one-active-primary-contact per (partner, role)
* history-safe deactivate / restore (soft-lifecycle only)
* bounded audit metadata — never full payloads or secrets
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError as SAIntegrityError

from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapability,
    BusinessPartnerCapabilityCode,
    BusinessPartnerContact,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
    BusinessPartnerSupplierProfile,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import (
    BusinessPartnerCapabilityRepository,
    BusinessPartnerContactRepository,
    BusinessPartnerRepository,
    BusinessPartnerSupplierProfileRepository,
)

_ = SAIntegrityError  # re-exported alias for clarity


# Map DB unique-constraint / index names to stable 409 envelope codes.
# Only KNOWN constraints are translated — anything else surfaces as
# an unclassified 500 via the normal internal-error path.
_INTEGRITY_CONSTRAINT_MAP: dict[str, tuple[str, str]] = {
    # Postgres named constraints.
    "uq_business_partner_org_code": (
        "business_partner_code_conflict",
        "A partner with this code already exists in this organization.",
    ),
    "uq_business_partner_capability": (
        "business_partner_capability_conflict",
        "Capability already exists on this partner.",
    ),
    "uq_business_partner_supplier_profile_partner": (
        "supplier_profile_conflict",
        "Supplier profile already exists for this partner.",
    ),
    "uq_business_partner_supplier_profile": (
        "supplier_profile_conflict",
        "Supplier profile already exists for this partner.",
    ),
    "uq_business_partner_contact_primary_per_role": (
        "business_partner_contact_primary_conflict",
        "Another primary contact already exists for this role.",
    ),
    "uq_business_partner_active_primary_contact": (
        "business_partner_contact_primary_conflict",
        "Another primary contact already exists for this role.",
    ),
    # SQLite constraint-failed strings (column-list based).
    "business_partners.organization_id, business_partners.code": (
        "business_partner_code_conflict",
        "A partner with this code already exists in this organization.",
    ),
    "business_partner_capabilities.business_partner_id, business_partner_capabilities.capability": (
        "business_partner_capability_conflict",
        "Capability already exists on this partner.",
    ),
    "business_partner_supplier_profiles.business_partner_id": (
        "supplier_profile_conflict",
        "Supplier profile already exists for this partner.",
    ),
    "ix_business_partner_contact_active_primary_per_role": (
        "business_partner_contact_primary_conflict",
        "Another primary contact already exists for this role.",
    ),
}


def _translate_integrity(exc: SAIntegrityError) -> HTTPException | None:
    """Translate a narrowly-identified IntegrityError into a 409 envelope.

    Returns ``None`` for unknown constraint hits so they surface as an
    internal error rather than being misclassified as a client conflict.
    Does NOT include SQL text, constraint internals, or tenant data
    in the response.
    """
    payload = str(exc.orig) if exc.orig is not None else str(exc)
    for constraint, (code, message) in _INTEGRITY_CONSTRAINT_MAP.items():
        if constraint in payload:
            return HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": code, "message": message, "context": {}},
            )
    return None


def _translate_integrity_errors(fn):
    """Decorator: translate known IntegrityError races into 409 envelopes.

    Race-safety net that runs AFTER the service's pre-checks. If a
    concurrent writer wins the race and the DB raises IntegrityError
    on flush, we surface a stable 409 rather than a 500. Unknown
    constraints are re-raised so they surface as internal errors.
    """
    import functools

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except SAIntegrityError as exc:
            translated = _translate_integrity(exc)
            if translated is not None:
                raise translated from exc
            raise

    return wrapper


def _now() -> datetime:
    return datetime.now(UTC)


def _error(code: str, message: str, *, context: dict | None = None) -> HTTPException:
    """Frozen error envelope — §11.1."""
    return HTTPException(
        status.HTTP_409_CONFLICT,
        {"code": code, "message": message, "context": context or {}},
    )


def _tenant_hidden(entity: str = "Business Partner") -> HTTPException:
    """Frozen tenant-hidden 404 shape.

    Deliberately generic — never reveals foreign-org existence.
    """
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {
            "code": "not_found",
            "message": f"{entity} not found.",
            "context": {},
        },
    )


class BusinessPartnerService:
    def __init__(
        self,
        *,
        partner_repo: BusinessPartnerRepository,
        capability_repo: BusinessPartnerCapabilityRepository,
        profile_repo: BusinessPartnerSupplierProfileRepository,
        contact_repo: BusinessPartnerContactRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.partner_repo = partner_repo
        self.capability_repo = capability_repo
        self.profile_repo = profile_repo
        self.contact_repo = contact_repo
        self.audit_repo = audit_repo

    # ------------------------------------------------------------- #
    # Tenancy helper — every write and every read anchor on partner
    # id goes through this. Returns the loaded partner or raises
    # the tenant-hidden 404 shape.
    # ------------------------------------------------------------- #
    async def load_for_tenant(
        self,
        partner_id: uuid.UUID,
        *,
        actor: User,
        expected_org_id: uuid.UUID,
        with_relations: bool = False,
    ) -> BusinessPartner:
        partner = await self.partner_repo.get_by_id(partner_id, with_relations=with_relations)
        if partner is None or partner.organization_id != expected_org_id:
            raise _tenant_hidden()
        if partner.deleted_at is not None and not actor.is_superuser:
            # Soft-deleted rows behave as tenant-hidden except to
            # platform admins. Historical references still resolve
            # via internal service calls that bypass this method.
            raise _tenant_hidden()
        return partner

    # ------------------------------------------------------------- #
    # Create (atomic — nested capabilities / profile / contacts).
    # ------------------------------------------------------------- #
    @_translate_integrity_errors
    async def create(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        data: dict,
        request_ctx: dict,
    ) -> BusinessPartner:
        code = data["code"]  # already normalised by schema

        # Per-org code uniqueness — deterministic pre-check produces
        # the frozen error envelope; the UNIQUE constraint at the DB
        # is the ultimate authority against a race.
        existing = await self.partner_repo.get_by_org_and_code(organization_id, code)
        if existing is not None:
            raise _error(
                "business_partner_code_conflict",
                "A partner with this code already exists in this organization.",
                context={"code": code},
            )

        header_fields = {
            k: data.get(k)
            for k in (
                "code",
                "legal_name",
                "trading_name",
                "primary_address",
                "email",
                "phone",
                "country_code",
                "tax_identifier",
                "notes",
            )
        }
        # `metadata` in the request maps to the ORM's `metadata_json`
        # column (SQLAlchemy Declarative reserves the `metadata` name).
        if "metadata" in data:
            header_fields["metadata_json"] = data.get("metadata")
        partner = await self.partner_repo.create(organization_id=organization_id, **header_fields)

        capabilities: list[BusinessPartnerCapabilityCode] = list(data.get("capabilities") or [])
        # Deduplicate; deterministic ordering.
        capabilities = sorted(set(capabilities), key=lambda c: c.value)
        for cap in capabilities:
            await self.capability_repo.add(partner.id, cap)

        profile_input = data.get("supplier_profile")
        if profile_input is not None:
            if BusinessPartnerCapabilityCode.SUPPLIER not in capabilities:
                raise _error(
                    "supplier_profile_requires_supplier_capability",
                    "supplier_profile requires the supplier capability.",
                )
            new_qual = profile_input["qualification_status"]
            new_pref = profile_input["preference_tier"]
            await self.profile_repo.create(
                business_partner_id=partner.id,
                qualification_status=new_qual,
                qualification_note=profile_input.get("qualification_note"),
                preference_tier=new_pref,
                qualified_by_id=(
                    actor.id if new_qual != BusinessPartnerQualificationStatus.UNQUALIFIED else None
                ),
                qualified_at=(
                    _now() if new_qual != BusinessPartnerQualificationStatus.UNQUALIFIED else None
                ),
            )
            # Explicit governance event whenever the initial state is
            # NOT the default "unqualified". Preference tier is always
            # captured as an initial-state before/after for consistency
            # with the update path.
            if new_qual != BusinessPartnerQualificationStatus.UNQUALIFIED:
                await self._audit(
                    actor=actor,
                    action="business_partner.qualification.update",
                    partner=partner,
                    request_ctx=request_ctx,
                    metadata={
                        "old_qualification_status": (
                            BusinessPartnerQualificationStatus.UNQUALIFIED.value
                        ),
                        "new_qualification_status": new_qual.value,
                        "old_preference_tier": None,
                        "new_preference_tier": new_pref.value,
                        "changed_fields": ["qualification_status", "preference_tier"],
                    },
                )

        for contact_input in data.get("contacts") or []:
            await self._create_contact_inner(
                partner=partner,
                data=contact_input,
                actor=actor,
                request_ctx=request_ctx,
                audit=True,  # per §4.5 each contact creation is its own event
            )

        await self._audit(
            actor=actor,
            action="business_partner.create",
            partner=partner,
            request_ctx=request_ctx,
            metadata={
                "code": partner.code,
                "capabilities": [c.value for c in capabilities],
                "has_supplier_profile": profile_input is not None,
                "contact_count": len(data.get("contacts") or []),
            },
        )
        return partner

    # ------------------------------------------------------------- #
    # PATCH — partner-header fields only.
    # ------------------------------------------------------------- #
    @_translate_integrity_errors
    async def update_header(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        data: dict,
        request_ctx: dict,
    ) -> BusinessPartner:
        changed_fields = {}
        _field_map = {
            "legal_name": "legal_name",
            "trading_name": "trading_name",
            "primary_address": "primary_address",
            "email": "email",
            "phone": "phone",
            "country_code": "country_code",
            "tax_identifier": "tax_identifier",
            "notes": "notes",
            "metadata": "metadata_json",  # public → ORM name
        }
        for request_field, orm_field in _field_map.items():
            if request_field in data:
                new_value = data[request_field]
                if new_value != getattr(partner, orm_field):
                    changed_fields[request_field] = new_value
                    setattr(partner, orm_field, new_value)
        if not changed_fields:
            return partner
        # Non-empty invariant on legal_name — schema already stripped
        # blanks, but PATCH may pass an all-whitespace value.
        if "legal_name" in changed_fields and not ((data["legal_name"] or "").strip()):
            raise _error(
                "business_partner_legal_name_blank",
                "legal_name must not be blank.",
            )
        self.partner_repo.session.add(partner)
        await self.partner_repo.session.flush()
        await self._audit(
            actor=actor,
            action="business_partner.update",
            partner=partner,
            request_ctx=request_ctx,
            metadata={"fields": sorted(changed_fields.keys())},
        )
        return partner

    # ------------------------------------------------------------- #
    # Deactivate / restore (idempotent on same-state).
    # ------------------------------------------------------------- #
    @_translate_integrity_errors
    async def deactivate(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        reason: str,
        request_ctx: dict,
    ) -> BusinessPartner:
        if not partner.is_active:
            return partner  # idempotent
        partner.is_active = False
        partner.deactivated_at = _now()
        partner.deactivation_reason = reason
        self.partner_repo.session.add(partner)
        await self.partner_repo.session.flush()
        await self._audit(
            actor=actor,
            action="business_partner.deactivate",
            partner=partner,
            request_ctx=request_ctx,
            metadata={"reason": reason[:500]},
        )
        return partner

    @_translate_integrity_errors
    async def restore(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        reason: str,
        request_ctx: dict,
    ) -> BusinessPartner:
        if partner.is_active:
            return partner  # idempotent
        partner.is_active = True
        partner.deactivated_at = None
        partner.deactivation_reason = None
        self.partner_repo.session.add(partner)
        await self.partner_repo.session.flush()
        await self._audit(
            actor=actor,
            action="business_partner.restore",
            partner=partner,
            request_ctx=request_ctx,
            metadata={"reason": reason[:500]},
        )
        return partner

    # ------------------------------------------------------------- #
    # Capabilities.
    # ------------------------------------------------------------- #
    @_translate_integrity_errors
    async def add_capability(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        capability: BusinessPartnerCapabilityCode,
        request_ctx: dict,
    ) -> BusinessPartnerCapability:
        existing = await self.capability_repo.get(partner.id, capability)
        if existing is not None:
            # Idempotent — return the existing row.
            return existing
        row = await self.capability_repo.add(partner.id, capability)
        await self._audit(
            actor=actor,
            action="business_partner.capability.add",
            partner=partner,
            request_ctx=request_ctx,
            metadata={"capability": capability.value},
        )
        return row

    @_translate_integrity_errors
    async def remove_capability(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        capability: BusinessPartnerCapabilityCode,
        request_ctx: dict,
    ) -> None:
        row = await self.capability_repo.get(partner.id, capability)
        if row is None:
            raise _tenant_hidden("Capability")
        # §4.3 — supplier capability removal must preserve the
        # dependency rule with active non-terminal documents. In
        # 6.0.2 no PO / Receipt tables exist yet, but keep the
        # extension point explicit so 6.0.3 wires the check in.
        if capability == BusinessPartnerCapabilityCode.SUPPLIER:
            # §2 (Release 6.0.3) — removing the supplier capability is
            # rejected while any non-terminal Purchase Order for this
            # partner still depends on it. Bounded dependency context;
            # never leaks foreign-tenant IDs or PO payloads.
            from app.repositories.purchase_order import (
                count_non_terminal_purchase_orders_for_partner,
            )

            dependent = await count_non_terminal_purchase_orders_for_partner(
                self.partner_repo.session, partner.id
            )
            if dependent > 0:
                raise _error(
                    "business_partner_supplier_capability_in_use",
                    "The supplier capability cannot be removed while a "
                    "non-terminal Purchase Order depends on it.",
                    context={"dependent_purchase_order_count": dependent},
                )
            # No dependent POs — remove the supplier profile alongside
            # the capability so a follow-on qualification query returns
            # a consistent state.
            profile = await self.profile_repo.get_for_partner(partner.id)
            if profile is not None:
                await self.profile_repo.session.delete(profile)
                await self.profile_repo.session.flush()
        await self.capability_repo.delete(row)
        await self._audit(
            actor=actor,
            action="business_partner.capability.remove",
            partner=partner,
            request_ctx=request_ctx,
            metadata={"capability": capability.value},
        )

    # ------------------------------------------------------------- #
    # Supplier profile.
    # ------------------------------------------------------------- #
    @_translate_integrity_errors
    async def upsert_supplier_profile(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        data: dict,
        request_ctx: dict,
    ) -> BusinessPartnerSupplierProfile:
        supplier_cap = await self.capability_repo.get(
            partner.id, BusinessPartnerCapabilityCode.SUPPLIER
        )
        if supplier_cap is None:
            raise _error(
                "supplier_profile_requires_supplier_capability",
                "supplier_profile requires the supplier capability.",
            )
        profile = await self.profile_repo.get_for_partner(partner.id)
        new_qual = data.get("qualification_status", BusinessPartnerQualificationStatus.UNQUALIFIED)
        new_pref = data.get("preference_tier", BusinessPartnerPreferenceTier.STANDARD)
        new_note = data.get("qualification_note")

        qualification_changed = profile is None or profile.qualification_status != new_qual
        old_qual_value: str | None = None
        old_pref_value: str | None = None
        if profile is None:
            old_qual_value = BusinessPartnerQualificationStatus.UNQUALIFIED.value
            old_pref_value = None
            profile = await self.profile_repo.create(
                business_partner_id=partner.id,
                qualification_status=new_qual,
                qualification_note=new_note,
                preference_tier=new_pref,
                qualified_by_id=(
                    actor.id if new_qual != BusinessPartnerQualificationStatus.UNQUALIFIED else None
                ),
                qualified_at=(
                    _now() if new_qual != BusinessPartnerQualificationStatus.UNQUALIFIED else None
                ),
            )
        else:
            old_qual_value = profile.qualification_status.value
            old_pref_value = profile.preference_tier.value
            profile.qualification_status = new_qual
            profile.qualification_note = new_note
            profile.preference_tier = new_pref
            if qualification_changed:
                if new_qual == BusinessPartnerQualificationStatus.UNQUALIFIED:
                    profile.qualified_by_id = None
                    profile.qualified_at = None
                else:
                    profile.qualified_by_id = actor.id
                    profile.qualified_at = _now()
            self.profile_repo.session.add(profile)
            await self.profile_repo.session.flush()
            await self.profile_repo.session.refresh(profile)

        if qualification_changed:
            changed = ["qualification_status"]
            if old_pref_value != new_pref.value:
                changed.append("preference_tier")
            await self._audit(
                actor=actor,
                action="business_partner.qualification.update",
                partner=partner,
                request_ctx=request_ctx,
                metadata={
                    "old_qualification_status": old_qual_value,
                    "new_qualification_status": new_qual.value,
                    "old_preference_tier": old_pref_value,
                    "new_preference_tier": new_pref.value,
                    "changed_fields": changed,
                },
            )
        elif old_pref_value != new_pref.value:
            # Preference-only change (qualification unchanged).
            await self._audit(
                actor=actor,
                action="business_partner.update",
                partner=partner,
                request_ctx=request_ctx,
                metadata={
                    "supplier_profile": True,
                    "old_preference_tier": old_pref_value,
                    "new_preference_tier": new_pref.value,
                    "changed_fields": ["preference_tier"],
                },
            )
        # No-op same-state upsert emits no audit (idempotent).
        return profile

    # ------------------------------------------------------------- #
    # Contacts.
    # ------------------------------------------------------------- #
    async def _create_contact_inner(
        self,
        *,
        partner: BusinessPartner,
        data: dict,
        actor: User,
        request_ctx: dict,
        audit: bool = True,
    ) -> BusinessPartnerContact:
        if data.get("is_primary"):
            existing = await self.contact_repo.list_active_primary_for_role(
                partner.id, data["contact_role"]
            )
            if existing:
                raise _error(
                    "business_partner_contact_primary_conflict",
                    "Another primary contact already exists for this role.",
                    context={"contact_role": data["contact_role"].value},
                )
        row = await self.contact_repo.create(
            business_partner_id=partner.id,
            name=data["name"],
            job_title=data.get("job_title"),
            email=data.get("email"),
            phone=data.get("phone"),
            contact_role=data["contact_role"],
            is_primary=data.get("is_primary", False),
            notes=data.get("notes"),
        )
        if audit:
            await self._audit(
                actor=actor,
                action="business_partner.contact.create",
                partner=partner,
                request_ctx=request_ctx,
                metadata={
                    "contact_id": str(row.id),
                    "contact_role": row.contact_role.value,
                    "is_primary": row.is_primary,
                },
            )
        return row

    @_translate_integrity_errors
    async def create_contact(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        data: dict,
        request_ctx: dict,
    ) -> BusinessPartnerContact:
        return await self._create_contact_inner(
            partner=partner,
            data=data,
            actor=actor,
            request_ctx=request_ctx,
            audit=True,
        )

    @_translate_integrity_errors
    async def update_contact(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        contact: BusinessPartnerContact,
        data: dict,
        request_ctx: dict,
    ) -> BusinessPartnerContact:
        if contact.business_partner_id != partner.id:
            raise _tenant_hidden("Contact")
        changed: dict = {}
        # If is_primary is being turned on, check the invariant.
        target_role = data.get("contact_role", contact.contact_role)
        target_primary = data.get("is_primary", contact.is_primary)
        if target_primary and (not contact.is_primary or target_role != contact.contact_role):
            existing = await self.contact_repo.list_active_primary_for_role(partner.id, target_role)
            existing = [e for e in existing if e.id != contact.id]
            if existing:
                raise _error(
                    "business_partner_contact_primary_conflict",
                    "Another primary contact already exists for this role.",
                    context={"contact_role": target_role.value},
                )
        for field in (
            "name",
            "job_title",
            "email",
            "phone",
            "contact_role",
            "is_primary",
            "notes",
        ):
            # Per §4.1 partial-update convention: `field in data` means
            # the caller explicitly sent it (because the endpoint uses
            # ``model_dump(exclude_unset=True)``). We MUST accept an
            # explicit ``null`` for nullable fields as a "clear" intent
            # rather than silently ignoring it. The schema rejects null
            # for the three required fields, so we don't need a runtime
            # guard here.
            if field in data and getattr(contact, field) != data[field]:
                changed[field] = data[field]
                setattr(contact, field, data[field])
        if not changed:
            return contact
        self.contact_repo.session.add(contact)
        await self.contact_repo.session.flush()
        await self.contact_repo.session.refresh(contact)
        await self._audit(
            actor=actor,
            action="business_partner.contact.update",
            partner=partner,
            request_ctx=request_ctx,
            metadata={
                "contact_id": str(contact.id),
                "fields": sorted(changed.keys()),
            },
        )
        return contact

    @_translate_integrity_errors
    async def deactivate_contact(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        contact: BusinessPartnerContact,
        reason: str,
        request_ctx: dict,
    ) -> BusinessPartnerContact:
        if contact.business_partner_id != partner.id:
            raise _tenant_hidden("Contact")
        if not contact.is_active:
            return contact  # idempotent
        contact.is_active = False
        contact.deactivated_at = _now()
        contact.deactivation_reason = reason
        self.contact_repo.session.add(contact)
        await self.contact_repo.session.flush()
        await self.contact_repo.session.refresh(contact)
        await self._audit(
            actor=actor,
            action="business_partner.contact.deactivate",
            partner=partner,
            request_ctx=request_ctx,
            metadata={
                "contact_id": str(contact.id),
                "reason": reason[:500],
            },
        )
        return contact

    @_translate_integrity_errors
    async def restore_contact(
        self,
        *,
        actor: User,
        partner: BusinessPartner,
        contact: BusinessPartnerContact,
        reason: str,
        request_ctx: dict,
    ) -> BusinessPartnerContact:
        if contact.business_partner_id != partner.id:
            raise _tenant_hidden("Contact")
        if contact.is_active:
            return contact
        # If primary, verify no other active primary contact exists
        # for this role at the moment of restore.
        if contact.is_primary:
            existing = await self.contact_repo.list_active_primary_for_role(
                partner.id, contact.contact_role
            )
            existing = [e for e in existing if e.id != contact.id]
            if existing:
                raise _error(
                    "business_partner_contact_primary_conflict",
                    "Another primary contact already exists for this role.",
                    context={"contact_role": contact.contact_role.value},
                )
        contact.is_active = True
        contact.deactivated_at = None
        contact.deactivation_reason = None
        self.contact_repo.session.add(contact)
        await self.contact_repo.session.flush()
        await self.contact_repo.session.refresh(contact)
        await self._audit(
            actor=actor,
            action="business_partner.contact.restore",
            partner=partner,
            request_ctx=request_ctx,
            metadata={
                "contact_id": str(contact.id),
                "reason": reason[:500],
            },
        )
        return contact

    # ------------------------------------------------------------- #
    # Audit helper — bounded metadata only.
    # ------------------------------------------------------------- #
    async def _audit(
        self,
        *,
        actor: User,
        action: str,
        partner: BusinessPartner,
        request_ctx: dict,
        metadata: dict,
    ) -> None:
        await self.audit_repo.record(
            actor_id=actor.id,
            organization_id=partner.organization_id,
            farm_id=None,
            action=action,
            entity_type="business_partner",
            entity_id=str(partner.id),
            ip_address=request_ctx.get("ip_address"),
            user_agent=request_ctx.get("user_agent"),
            request_id=request_ctx.get("request_id"),
            metadata=metadata,
        )


__all__ = ["BusinessPartnerService"]
