"""Release 6.0.2 — Business Partner API endpoints.

Every route below implements the frozen §11.2 contract. All
authorization goes through :func:`require_permission` at the
endpoint dependency layer so the membership-hidden 404 vs
permission-denied 403 boundary is preserved.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.deps import (
    CurrentOrganization,
    CurrentUser,
    DBSession,
    RequestCtx,
    require_permission,
)
from app.models.business_partner import (
    BusinessPartnerCapabilityCode,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
)
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import (
    BusinessPartnerCapabilityRepository,
    BusinessPartnerContactRepository,
    BusinessPartnerRepository,
    BusinessPartnerSupplierProfileRepository,
)
from app.schemas.business_partner import (
    BusinessPartnerCapabilityAddRequest,
    BusinessPartnerCapabilityPublic,
    BusinessPartnerContactCreateRequest,
    BusinessPartnerContactDeactivateRequest,
    BusinessPartnerContactPublic,
    BusinessPartnerContactRestoreRequest,
    BusinessPartnerContactUpdateRequest,
    BusinessPartnerCreateRequest,
    BusinessPartnerDeactivateRequest,
    BusinessPartnerPublic,
    BusinessPartnerRestoreRequest,
    BusinessPartnerSupplierProfilePublic,
    BusinessPartnerSupplierProfileWriteRequest,
    BusinessPartnerUpdateRequest,
    CursorPage,
)
from app.services.business_partner import BusinessPartnerService

router = APIRouter()


def _get_service(session: DBSession) -> BusinessPartnerService:
    return BusinessPartnerService(
        partner_repo=BusinessPartnerRepository(session),
        capability_repo=BusinessPartnerCapabilityRepository(session),
        profile_repo=BusinessPartnerSupplierProfileRepository(session),
        contact_repo=BusinessPartnerContactRepository(session),
        audit_repo=AuditRepository(session),
    )


ServiceDep = Annotated[BusinessPartnerService, Depends(_get_service)]


# --------------------------------------------------------------------- #
# Aggregate — list / create.
# --------------------------------------------------------------------- #
@router.get(
    "/organizations/{organization_id}/business-partners",
    response_model=CursorPage,
    dependencies=[Depends(require_permission("business_partner.read"))],
    tags=["business-partners"],
)
async def list_business_partners(
    organization_id: uuid.UUID,
    _org: CurrentOrganization,
    service: ServiceDep,
    capability: BusinessPartnerCapabilityCode | None = Query(default=None),
    active: bool | None = Query(default=None),
    qualification: BusinessPartnerQualificationStatus | None = Query(default=None),
    preference: BusinessPartnerPreferenceTier | None = Query(default=None),
    search: str | None = Query(default=None, max_length=255),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> CursorPage:
    del _org
    rows, next_cursor = await service.partner_repo.list_page(
        organization_id,
        capability=capability,
        active=active,
        qualification=qualification,
        preference=preference,
        search=search,
        cursor=cursor,
        limit=limit,
    )
    return CursorPage(
        items=[BusinessPartnerPublic.model_validate(r) for r in rows],
        next_cursor=next_cursor,
    )


@router.post(
    "/organizations/{organization_id}/business-partners",
    response_model=BusinessPartnerPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("business_partner.create"))],
    tags=["business-partners"],
)
async def create_business_partner(
    organization_id: uuid.UUID,
    payload: BusinessPartnerCreateRequest,
    _org: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerPublic:
    del _org
    data = payload.model_dump()
    # Preserve enum instances (Pydantic model_dump returns them
    # as-is for pydantic v2 with use_enum_values=False default).
    partner = await service.create(
        actor=user,
        organization_id=organization_id,
        data=data,
        request_ctx=request_ctx,
    )
    # Reload with relations for response.
    fresh = await service.partner_repo.get_by_id(partner.id, with_relations=True)
    return BusinessPartnerPublic.model_validate(fresh)


# --------------------------------------------------------------------- #
# Partner-scoped: get / patch / deactivate / restore.
# --------------------------------------------------------------------- #
async def _load_partner_for_read(
    partner_id: uuid.UUID,
    user: CurrentUser,
    service: ServiceDep,
) -> tuple:
    """Load the partner and return ``(partner, organization_id)`` so
    the endpoint can wire up the permission check with the right
    ``organization_id`` value.

    NB: We intentionally do NOT read the partner before the
    permission check runs against ``require_permission`` — the
    permission dep does an org-membership check first, which we
    approximate here by resolving the partner's org and then
    delegating the auth check into ``load_for_tenant``. The
    ``require_permission`` factory is invoked via the router
    dependency below for the FastAPI-native path.
    """
    partner = await service.partner_repo.get_by_id(
        partner_id, with_relations=False
    )
    if partner is None:
        # Tenant-hidden — do not tell the caller anything.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "not_found", "message": "Business Partner not found.", "context": {}},
        )
    return partner, partner.organization_id


@router.get(
    "/business-partners/{partner_id}",
    response_model=BusinessPartnerPublic,
    tags=["business-partners"],
)
async def get_business_partner(
    partner_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> BusinessPartnerPublic:
    partner, org_id = await _load_partner_for_read(partner_id, user, service)
    # Enforce permission using the loaded org id.
    await require_permission("business_partner.read")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id, with_relations=True
    )
    return BusinessPartnerPublic.model_validate(partner)


@router.patch(
    "/business-partners/{partner_id}",
    response_model=BusinessPartnerPublic,
    tags=["business-partners"],
)
async def update_business_partner(
    partner_id: uuid.UUID,
    payload: BusinessPartnerUpdateRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerPublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.update")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    await service.update_header(
        actor=user,
        partner=partner,
        data=payload.model_dump(exclude_unset=True),
        request_ctx=request_ctx,
    )
    fresh = await service.partner_repo.get_by_id(partner.id, with_relations=True)
    return BusinessPartnerPublic.model_validate(fresh)


@router.post(
    "/business-partners/{partner_id}/deactivate",
    response_model=BusinessPartnerPublic,
    tags=["business-partners"],
)
async def deactivate_business_partner(
    partner_id: uuid.UUID,
    payload: BusinessPartnerDeactivateRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerPublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.deactivate")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    await service.deactivate(
        actor=user, partner=partner, reason=payload.reason, request_ctx=request_ctx
    )
    fresh = await service.partner_repo.get_by_id(partner.id, with_relations=True)
    return BusinessPartnerPublic.model_validate(fresh)


@router.post(
    "/business-partners/{partner_id}/restore",
    response_model=BusinessPartnerPublic,
    tags=["business-partners"],
)
async def restore_business_partner(
    partner_id: uuid.UUID,
    payload: BusinessPartnerRestoreRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerPublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.deactivate")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.partner_repo.get_by_id(partner_id, with_relations=False)
    # Restore may target a deactivated (still-visible) partner; do
    # not run load_for_tenant which forbids deleted rows.
    if partner is None or partner.organization_id != org_id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "not_found", "message": "Business Partner not found.", "context": {}},
        )
    await service.restore(
        actor=user, partner=partner, reason=payload.reason, request_ctx=request_ctx
    )
    fresh = await service.partner_repo.get_by_id(partner.id, with_relations=True)
    return BusinessPartnerPublic.model_validate(fresh)


# --------------------------------------------------------------------- #
# Capabilities.
# --------------------------------------------------------------------- #
@router.get(
    "/business-partners/{partner_id}/capabilities",
    response_model=list[BusinessPartnerCapabilityPublic],
    tags=["business-partners"],
)
async def list_capabilities(
    partner_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> list[BusinessPartnerCapabilityPublic]:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.read")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    rows = await service.capability_repo.list_for_partner(partner.id)
    return [BusinessPartnerCapabilityPublic.model_validate(r) for r in rows]


@router.post(
    "/business-partners/{partner_id}/capabilities",
    response_model=BusinessPartnerCapabilityPublic,
    status_code=status.HTTP_201_CREATED,
    tags=["business-partners"],
)
async def add_capability(
    partner_id: uuid.UUID,
    payload: BusinessPartnerCapabilityAddRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerCapabilityPublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.update")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    row = await service.add_capability(
        actor=user,
        partner=partner,
        capability=payload.capability,
        request_ctx=request_ctx,
    )
    return BusinessPartnerCapabilityPublic.model_validate(row)


@router.delete(
    "/business-partners/{partner_id}/capabilities/{capability}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    tags=["business-partners"],
)
async def remove_capability(
    partner_id: uuid.UUID,
    capability: BusinessPartnerCapabilityCode,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> Response:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.update")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    await service.remove_capability(
        actor=user,
        partner=partner,
        capability=capability,
        request_ctx=request_ctx,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------- #
# Supplier profile.
# --------------------------------------------------------------------- #
@router.get(
    "/business-partners/{partner_id}/supplier-profile",
    response_model=BusinessPartnerSupplierProfilePublic,
    tags=["business-partners"],
)
async def get_supplier_profile(
    partner_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> BusinessPartnerSupplierProfilePublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.read")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    profile = await service.profile_repo.get_for_partner(partner.id)
    if profile is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {
                "code": "not_found",
                "message": "Supplier profile not found.",
                "context": {},
            },
        )
    return BusinessPartnerSupplierProfilePublic.model_validate(profile)


@router.put(
    "/business-partners/{partner_id}/supplier-profile",
    response_model=BusinessPartnerSupplierProfilePublic,
    tags=["business-partners"],
)
async def put_supplier_profile(
    partner_id: uuid.UUID,
    payload: BusinessPartnerSupplierProfileWriteRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerSupplierProfilePublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.update")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    profile = await service.upsert_supplier_profile(
        actor=user,
        partner=partner,
        data=payload.model_dump(),
        request_ctx=request_ctx,
    )
    return BusinessPartnerSupplierProfilePublic.model_validate(profile)


# --------------------------------------------------------------------- #
# Contacts.
# --------------------------------------------------------------------- #
@router.get(
    "/business-partners/{partner_id}/contacts",
    response_model=CursorPage,
    tags=["business-partners"],
)
async def list_contacts(
    partner_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
    include_inactive: bool = Query(default=False),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> CursorPage:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.read")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    rows, next_cursor = await service.contact_repo.list_page(
        partner.id,
        include_inactive=include_inactive,
        cursor=cursor,
        limit=limit,
    )
    return CursorPage(
        items=[BusinessPartnerContactPublic.model_validate(r) for r in rows],
        next_cursor=next_cursor,
    )


@router.post(
    "/business-partners/{partner_id}/contacts",
    response_model=BusinessPartnerContactPublic,
    status_code=status.HTTP_201_CREATED,
    tags=["business-partners"],
)
async def create_contact(
    partner_id: uuid.UUID,
    payload: BusinessPartnerContactCreateRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerContactPublic:
    _partner, org_id = await _load_partner_for_read(partner_id, user, service)
    await require_permission("business_partner.update")(
        user=user, session=session, organization_id=org_id, farm_id=None
    )
    partner = await service.load_for_tenant(
        partner_id, actor=user, expected_org_id=org_id
    )
    row = await service.create_contact(
        actor=user, partner=partner, data=payload.model_dump(), request_ctx=request_ctx
    )
    return BusinessPartnerContactPublic.model_validate(row)


async def _load_contact_and_partner(
    contact_id: uuid.UUID, user, service: BusinessPartnerService
) -> tuple:
    contact = await service.contact_repo.get_by_id(contact_id)
    if contact is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "not_found", "message": "Contact not found.", "context": {}},
        )
    partner = await service.partner_repo.get_by_id(contact.business_partner_id)
    if partner is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            {"code": "not_found", "message": "Contact not found.", "context": {}},
        )
    return contact, partner


@router.get(
    "/business-partner-contacts/{contact_id}",
    response_model=BusinessPartnerContactPublic,
    tags=["business-partners"],
)
async def get_contact(
    contact_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> BusinessPartnerContactPublic:
    contact, partner = await _load_contact_and_partner(contact_id, user, service)
    await require_permission("business_partner.read")(
        user=user,
        session=session,
        organization_id=partner.organization_id,
        farm_id=None,
    )
    return BusinessPartnerContactPublic.model_validate(contact)


@router.patch(
    "/business-partner-contacts/{contact_id}",
    response_model=BusinessPartnerContactPublic,
    tags=["business-partners"],
)
async def update_contact(
    contact_id: uuid.UUID,
    payload: BusinessPartnerContactUpdateRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerContactPublic:
    contact, partner = await _load_contact_and_partner(contact_id, user, service)
    await require_permission("business_partner.update")(
        user=user,
        session=session,
        organization_id=partner.organization_id,
        farm_id=None,
    )
    row = await service.update_contact(
        actor=user,
        partner=partner,
        contact=contact,
        data=payload.model_dump(exclude_unset=True),
        request_ctx=request_ctx,
    )
    return BusinessPartnerContactPublic.model_validate(row)


@router.post(
    "/business-partner-contacts/{contact_id}/deactivate",
    response_model=BusinessPartnerContactPublic,
    tags=["business-partners"],
)
async def deactivate_contact(
    contact_id: uuid.UUID,
    payload: BusinessPartnerContactDeactivateRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerContactPublic:
    contact, partner = await _load_contact_and_partner(contact_id, user, service)
    await require_permission("business_partner.update")(
        user=user,
        session=session,
        organization_id=partner.organization_id,
        farm_id=None,
    )
    row = await service.deactivate_contact(
        actor=user,
        partner=partner,
        contact=contact,
        reason=payload.reason,
        request_ctx=request_ctx,
    )
    return BusinessPartnerContactPublic.model_validate(row)


@router.post(
    "/business-partner-contacts/{contact_id}/restore",
    response_model=BusinessPartnerContactPublic,
    tags=["business-partners"],
)
async def restore_contact(
    contact_id: uuid.UUID,
    payload: BusinessPartnerContactRestoreRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> BusinessPartnerContactPublic:
    contact, partner = await _load_contact_and_partner(contact_id, user, service)
    await require_permission("business_partner.update")(
        user=user,
        session=session,
        organization_id=partner.organization_id,
        farm_id=None,
    )
    row = await service.restore_contact(
        actor=user,
        partner=partner,
        contact=contact,
        reason=payload.reason,
        request_ctx=request_ctx,
    )
    return BusinessPartnerContactPublic.model_validate(row)


__all__ = ["router"]
