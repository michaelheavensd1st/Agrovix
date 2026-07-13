"""Production Engine HTTP endpoints.

Kept in a single router module so the whole Sprint 2 bounded context
lives together. Sub-routers by resource keep the URL surface tidy:

    /api/v1/farms/{farm_id}/sites            POST | GET
    /api/v1/sites/{site_id}                  GET | PATCH | DELETE
    /api/v1/sites/{site_id}/restore          POST
    /api/v1/sites/{site_id}/units            POST | GET

    /api/v1/organizations/{org_id}/unit-types POST
    /api/v1/production-unit-types            GET

    /api/v1/units/{unit_id}                  GET | PATCH | DELETE
    /api/v1/units/{unit_id}/batches          POST | GET

    /api/v1/batches/{batch_id}               GET | PATCH
    /api/v1/batches/{batch_id}/transitions   POST | GET
    /api/v1/batches/{batch_id}/events        POST | GET

    /api/v1/production-events/catalog        GET (authenticated — reference data)
    /api/v1/events/{event_id}                GET
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import (
    CurrentFarm,
    CurrentUser,
    DBSession,
    RequestCtx,
    get_audit_repository,
    require_permission,
)
from app.models.production import (
    ProductionBatch,
    ProductionSite,
    ProductionUnit,
)
from app.production.event_catalog import CATALOG
from app.repositories.audit_repo import AuditRepository
from app.repositories.production import (
    ProductionBatchRepository,
    ProductionBatchTransitionRepository,
    ProductionEventRepository,
    ProductionSiteRepository,
    ProductionUnitRepository,
    ProductionUnitTypeRepository,
)
from app.schemas.production import (
    ProductionBatchCreate,
    ProductionBatchPublic,
    ProductionBatchTransitionPublic,
    ProductionBatchTransitionRequest,
    ProductionBatchUpdate,
    ProductionEventCatalogEntry,
    ProductionEventCatalogResponse,
    ProductionEventCreate,
    ProductionEventPage,
    ProductionEventPublic,
    ProductionSiteCreate,
    ProductionSitePublic,
    ProductionSiteUpdate,
    ProductionUnitCreate,
    ProductionUnitPublic,
    ProductionUnitTypeCreate,
    ProductionUnitTypePublic,
    ProductionUnitUpdate,
)
from app.services.production import (
    ProductionBatchService,
    ProductionEventService,
    ProductionSiteService,
    ProductionUnitService,
    ProductionUnitTypeService,
)

router = APIRouter()


# --------------------------------------------------------------------- #
# DI helpers (kept local so the deps module doesn't bloat)
# --------------------------------------------------------------------- #
def get_site_repo(session: DBSession) -> ProductionSiteRepository:
    return ProductionSiteRepository(session)


def get_unit_type_repo(session: DBSession) -> ProductionUnitTypeRepository:
    return ProductionUnitTypeRepository(session)


def get_unit_repo(session: DBSession) -> ProductionUnitRepository:
    return ProductionUnitRepository(session)


def get_batch_repo(session: DBSession) -> ProductionBatchRepository:
    return ProductionBatchRepository(session)


def get_transition_repo(session: DBSession) -> ProductionBatchTransitionRepository:
    return ProductionBatchTransitionRepository(session)


def get_event_repo(session: DBSession) -> ProductionEventRepository:
    return ProductionEventRepository(session)


def get_site_service(
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    unit_repo: Annotated[ProductionUnitRepository, Depends(get_unit_repo)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> ProductionSiteService:
    return ProductionSiteService(site_repo=site_repo, unit_repo=unit_repo, audit_repo=audit_repo)


def get_unit_type_service(
    unit_type_repo: Annotated[ProductionUnitTypeRepository, Depends(get_unit_type_repo)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> ProductionUnitTypeService:
    return ProductionUnitTypeService(unit_type_repo=unit_type_repo, audit_repo=audit_repo)


def get_unit_service(
    unit_repo: Annotated[ProductionUnitRepository, Depends(get_unit_repo)],
    unit_type_repo: Annotated[ProductionUnitTypeRepository, Depends(get_unit_type_repo)],
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> ProductionUnitService:
    return ProductionUnitService(
        unit_repo=unit_repo,
        unit_type_repo=unit_type_repo,
        site_repo=site_repo,
        audit_repo=audit_repo,
    )


def get_batch_service(
    batch_repo: Annotated[ProductionBatchRepository, Depends(get_batch_repo)],
    transition_repo: Annotated[ProductionBatchTransitionRepository, Depends(get_transition_repo)],
    unit_repo: Annotated[ProductionUnitRepository, Depends(get_unit_repo)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> ProductionBatchService:
    return ProductionBatchService(
        batch_repo=batch_repo,
        transition_repo=transition_repo,
        unit_repo=unit_repo,
        audit_repo=audit_repo,
    )


def get_event_service(
    event_repo: Annotated[ProductionEventRepository, Depends(get_event_repo)],
    batch_repo: Annotated[ProductionBatchRepository, Depends(get_batch_repo)],
    batch_service: Annotated[ProductionBatchService, Depends(get_batch_service)],
    unit_repo: Annotated[ProductionUnitRepository, Depends(get_unit_repo)],
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> ProductionEventService:
    return ProductionEventService(
        event_repo=event_repo,
        batch_repo=batch_repo,
        batch_service=batch_service,
        unit_repo=unit_repo,
        site_repo=site_repo,
        audit_repo=audit_repo,
    )


# --------------------------------------------------------------------- #
# Cross-tenant loaders that walk the hierarchy up to the Farm, then
# reuse ``CurrentFarm``'s tenancy check (membership + non-deleted).
# --------------------------------------------------------------------- #
async def _load_site_and_farm(
    site_id: uuid.UUID,
    user: CurrentUser,
    site_repo: ProductionSiteRepository,
    session: DBSession,
) -> tuple[ProductionSite, any]:
    from app.repositories.org_repo import (
        FarmMembershipRepository,
        FarmRepository,
        OrganizationMembershipRepository,
    )
    from app.repositories.role_repo import RoleAssignmentRepository

    site = await site_repo.get_by_id_including_deleted(site_id)
    if site is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found.")
    # Reuse the exact tenancy invariants that ``get_current_farm`` enforces.
    from app.deps import get_current_farm

    farm = await get_current_farm(
        farm_id=site.farm_id,
        user=user,
        farm_repo=FarmRepository(session),
        farm_mem_repo=FarmMembershipRepository(session),
        org_mem_repo=OrganizationMembershipRepository(session),
        role_assign_repo=RoleAssignmentRepository(session),
    )
    return site, farm


async def _load_unit(
    unit_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
) -> tuple[ProductionUnit, ProductionSite, any]:
    unit_repo = ProductionUnitRepository(session)
    site_repo = ProductionSiteRepository(session)
    unit = await unit_repo.get_by_id(unit_id)
    if unit is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Production unit not found.")
    site, farm = await _load_site_and_farm(unit.site_id, user, site_repo, session)
    return unit, site, farm


async def _load_batch(
    batch_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
) -> tuple[ProductionBatch, ProductionUnit, ProductionSite, any]:
    batch_repo = ProductionBatchRepository(session)
    batch = await batch_repo.get_by_id(batch_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Batch not found.")
    unit, site, farm = await _load_unit(batch.unit_id, user, session)
    return batch, unit, site, farm


# ===================================================================== #
# ProductionSite endpoints
# ===================================================================== #
@router.post(
    "/farms/{farm_id}/sites",
    response_model=ProductionSitePublic,
    status_code=status.HTTP_201_CREATED,
    tags=["production-sites"],
)
async def create_site(
    payload: ProductionSiteCreate,
    farm: CurrentFarm,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[ProductionSiteService, Depends(get_site_service)],
) -> ProductionSitePublic:
    site = await service.create(
        actor=user,
        farm=farm,
        data=payload.model_dump(exclude_unset=False),
        request_ctx=request_ctx,
    )
    return ProductionSitePublic.model_validate(site)


@router.get(
    "/farms/{farm_id}/sites", response_model=list[ProductionSitePublic], tags=["production-sites"]
)
async def list_sites(
    farm: CurrentFarm,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
) -> list[ProductionSitePublic]:
    rows = await site_repo.list_for_farm(farm.id)
    return [ProductionSitePublic.model_validate(r) for r in rows]


@router.get("/sites/{site_id}", response_model=ProductionSitePublic, tags=["production-sites"])
async def get_site(
    site_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
) -> ProductionSitePublic:
    site = await site_repo.get_by_id(site_id)
    if site is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found.")
    # Tenancy check via farm dep.
    await _load_site_and_farm(site.id, user, site_repo, session)
    return ProductionSitePublic.model_validate(site)


@router.patch("/sites/{site_id}", response_model=ProductionSitePublic, tags=["production-sites"])
async def update_site(
    site_id: uuid.UUID,
    payload: ProductionSiteUpdate,
    user: CurrentUser,
    session: DBSession,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
) -> ProductionSitePublic:
    site, _farm = await _load_site_and_farm(site_id, user, site_repo, session)
    if site.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found.")
    changed = payload.model_dump(exclude_unset=True)
    # Defence-in-depth: tenancy-critical fields cannot be reassigned via
    # PATCH regardless of what the update schema might grow to accept.
    for reserved in ("farm_id", "is_default", "deleted_at"):
        changed.pop(reserved, None)
    for k, v in changed.items():
        setattr(site, k, v)
    await session.flush()
    return ProductionSitePublic.model_validate(site)


@router.delete("/sites/{site_id}", response_model=ProductionSitePublic, tags=["production-sites"])
async def delete_site(
    site_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    service: Annotated[ProductionSiteService, Depends(get_site_service)],
) -> ProductionSitePublic:
    site, farm = await _load_site_and_farm(site_id, user, site_repo, session)
    if site.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found.")
    await service.soft_delete(actor=user, site=site, farm=farm, request_ctx=request_ctx)
    return ProductionSitePublic.model_validate(site)


@router.post(
    "/sites/{site_id}/restore", response_model=ProductionSitePublic, tags=["production-sites"]
)
async def restore_site(
    site_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    service: Annotated[ProductionSiteService, Depends(get_site_service)],
) -> ProductionSitePublic:
    site, farm = await _load_site_and_farm(site_id, user, site_repo, session)
    await service.restore(actor=user, site=site, farm=farm, request_ctx=request_ctx)
    return ProductionSitePublic.model_validate(site)


# ===================================================================== #
# ProductionUnitType endpoints
# ===================================================================== #
@router.get(
    "/production-unit-types",
    response_model=list[ProductionUnitTypePublic],
    tags=["production-unit-types"],
)
async def list_unit_types(
    user: CurrentUser,
    session: DBSession,
    organization_id: uuid.UUID | None = Query(
        default=None, description="Include this org's custom types too."
    ),
    unit_type_repo: Annotated[ProductionUnitTypeRepository, Depends(get_unit_type_repo)] = None,  # type: ignore
) -> list[ProductionUnitTypePublic]:
    if organization_id is not None and not user.is_superuser:
        from app.repositories.org_repo import OrganizationMembershipRepository

        mem = await OrganizationMembershipRepository(session).get(user.id, organization_id)
        if mem is None or not mem.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found.")
    rows = await unit_type_repo.list_visible(organization_id=organization_id)
    return [ProductionUnitTypePublic.model_validate(r) for r in rows]


@router.post(
    "/organizations/{organization_id}/production-unit-types",
    response_model=ProductionUnitTypePublic,
    status_code=status.HTTP_201_CREATED,
    tags=["production-unit-types"],
)
async def create_custom_unit_type(
    organization_id: uuid.UUID,
    payload: ProductionUnitTypeCreate,
    user: CurrentUser,
    request_ctx: RequestCtx,
    _authorized: Annotated[object, Depends(require_permission("production_unit_type.create"))],
    service: Annotated[ProductionUnitTypeService, Depends(get_unit_type_service)],
) -> ProductionUnitTypePublic:
    row = await service.create_custom(
        actor=user,
        organization_id=organization_id,
        data=payload.model_dump(),
        request_ctx=request_ctx,
    )
    return ProductionUnitTypePublic.model_validate(row)


@router.delete(
    "/production-unit-types/{type_id}",
    response_model=ProductionUnitTypePublic,
    tags=["production-unit-types"],
)
async def delete_custom_unit_type(
    type_id: uuid.UUID,
    user: CurrentUser,
    request_ctx: RequestCtx,
    session: DBSession,
    unit_type_repo: Annotated[ProductionUnitTypeRepository, Depends(get_unit_type_repo)],
    service: Annotated[ProductionUnitTypeService, Depends(get_unit_type_service)],
) -> ProductionUnitTypePublic:
    row = await unit_type_repo.get_by_id(type_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unit type not found.")
    if row.is_system:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "System unit types cannot be deleted.")
    # Only owners of the parent org can delete their custom types.
    from app.repositories.org_repo import OrganizationMembershipRepository

    if not user.is_superuser:
        mem = await OrganizationMembershipRepository(session).get(user.id, row.organization_id)
        if mem is None or not mem.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unit type not found.")
    await service.delete_custom(actor=user, row=row, request_ctx=request_ctx)
    return ProductionUnitTypePublic.model_validate(row)


# ===================================================================== #
# ProductionUnit endpoints
# ===================================================================== #
@router.post(
    "/sites/{site_id}/units",
    response_model=ProductionUnitPublic,
    status_code=status.HTTP_201_CREATED,
    tags=["production-units"],
)
async def create_unit(
    site_id: uuid.UUID,
    payload: ProductionUnitCreate,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    service: Annotated[ProductionUnitService, Depends(get_unit_service)],
) -> ProductionUnitPublic:
    site, farm = await _load_site_and_farm(site_id, user, site_repo, session)
    unit = await service.create(
        actor=user,
        site=site,
        farm=farm,
        data=payload.model_dump(),
        request_ctx=request_ctx,
    )
    return ProductionUnitPublic.model_validate(unit)


@router.get(
    "/sites/{site_id}/units", response_model=list[ProductionUnitPublic], tags=["production-units"]
)
async def list_units(
    site_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    site_repo: Annotated[ProductionSiteRepository, Depends(get_site_repo)],
    unit_repo: Annotated[ProductionUnitRepository, Depends(get_unit_repo)],
) -> list[ProductionUnitPublic]:
    site, _ = await _load_site_and_farm(site_id, user, site_repo, session)
    if site.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found.")
    rows = await unit_repo.list_for_site(site.id)
    return [ProductionUnitPublic.model_validate(r) for r in rows]


@router.get("/units/{unit_id}", response_model=ProductionUnitPublic, tags=["production-units"])
async def get_unit(
    unit_id: uuid.UUID, user: CurrentUser, session: DBSession
) -> ProductionUnitPublic:
    unit, _, _ = await _load_unit(unit_id, user, session)
    return ProductionUnitPublic.model_validate(unit)


@router.patch("/units/{unit_id}", response_model=ProductionUnitPublic, tags=["production-units"])
async def update_unit(
    unit_id: uuid.UUID,
    payload: ProductionUnitUpdate,
    user: CurrentUser,
    session: DBSession,
) -> ProductionUnitPublic:
    unit, _, _ = await _load_unit(unit_id, user, session)
    changed = payload.model_dump(exclude_unset=True)
    # Defence-in-depth: never allow a PATCH to relocate a unit across
    # sites or change its type — those are lifecycle events, not
    # updates.
    for reserved in ("site_id", "unit_type_id", "deleted_at"):
        changed.pop(reserved, None)
    for k, v in changed.items():
        setattr(unit, k, v)
    await session.flush()
    return ProductionUnitPublic.model_validate(unit)


@router.delete("/units/{unit_id}", response_model=ProductionUnitPublic, tags=["production-units"])
async def delete_unit(
    unit_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: Annotated[ProductionUnitService, Depends(get_unit_service)],
) -> ProductionUnitPublic:
    unit, _, farm = await _load_unit(unit_id, user, session)
    await service.soft_delete(actor=user, unit=unit, farm=farm, request_ctx=request_ctx)
    return ProductionUnitPublic.model_validate(unit)


# ===================================================================== #
# ProductionBatch endpoints
# ===================================================================== #
@router.post(
    "/units/{unit_id}/batches",
    response_model=ProductionBatchPublic,
    status_code=status.HTTP_201_CREATED,
    tags=["production-batches"],
)
async def create_batch(
    unit_id: uuid.UUID,
    payload: ProductionBatchCreate,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: Annotated[ProductionBatchService, Depends(get_batch_service)],
) -> ProductionBatchPublic:
    unit, _, farm = await _load_unit(unit_id, user, session)
    batch = await service.create(
        actor=user,
        unit=unit,
        farm=farm,
        data=payload.model_dump(),
        request_ctx=request_ctx,
    )
    return ProductionBatchPublic.model_validate(batch)


@router.get(
    "/units/{unit_id}/batches",
    response_model=list[ProductionBatchPublic],
    tags=["production-batches"],
)
async def list_batches(
    unit_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    batch_repo: Annotated[ProductionBatchRepository, Depends(get_batch_repo)],
) -> list[ProductionBatchPublic]:
    unit, _, _ = await _load_unit(unit_id, user, session)
    rows = await batch_repo.list_for_unit(unit.id)
    return [ProductionBatchPublic.model_validate(b) for b in rows]


@router.get(
    "/batches/{batch_id}", response_model=ProductionBatchPublic, tags=["production-batches"]
)
async def get_batch(
    batch_id: uuid.UUID, user: CurrentUser, session: DBSession
) -> ProductionBatchPublic:
    batch, _, _, _ = await _load_batch(batch_id, user, session)
    return ProductionBatchPublic.model_validate(batch)


@router.patch(
    "/batches/{batch_id}", response_model=ProductionBatchPublic, tags=["production-batches"]
)
async def update_batch(
    batch_id: uuid.UUID,
    payload: ProductionBatchUpdate,
    user: CurrentUser,
    session: DBSession,
) -> ProductionBatchPublic:
    batch, _, _, _ = await _load_batch(batch_id, user, session)
    changed = payload.model_dump(exclude_unset=True)
    # Defence-in-depth: state changes MUST go through /transitions —
    # never allow a PATCH to touch state / lifecycle timestamps even if
    # the schema is misconfigured in a future PR (see Sprint 2 code
    # review action item).
    for reserved in ("state", "stocked_at", "harvested_at", "closed_at"):
        changed.pop(reserved, None)
    for k, v in changed.items():
        setattr(batch, k, v)
    await session.flush()
    return ProductionBatchPublic.model_validate(batch)


@router.post(
    "/batches/{batch_id}/transitions",
    response_model=ProductionBatchTransitionPublic,
    tags=["production-batches"],
)
async def transition_batch(
    batch_id: uuid.UUID,
    payload: ProductionBatchTransitionRequest,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: Annotated[ProductionBatchService, Depends(get_batch_service)],
    transition_repo: Annotated[ProductionBatchTransitionRepository, Depends(get_transition_repo)],
) -> ProductionBatchTransitionPublic:
    batch, _, _, farm = await _load_batch(batch_id, user, session)
    await service.transition(
        actor=user,
        batch=batch,
        farm=farm,
        target_state=payload.target_state,
        reason=payload.reason,
        request_ctx=request_ctx,
        metadata=payload.metadata_json,
    )
    # Return the most recent transition row.
    rows = await transition_repo.list_for_batch(batch.id)
    return ProductionBatchTransitionPublic.model_validate(rows[-1])


@router.get(
    "/batches/{batch_id}/transitions",
    response_model=list[ProductionBatchTransitionPublic],
    tags=["production-batches"],
)
async def list_batch_transitions(
    batch_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    transition_repo: Annotated[ProductionBatchTransitionRepository, Depends(get_transition_repo)],
) -> list[ProductionBatchTransitionPublic]:
    batch, _, _, _ = await _load_batch(batch_id, user, session)
    rows = await transition_repo.list_for_batch(batch.id)
    return [ProductionBatchTransitionPublic.model_validate(r) for r in rows]


# ===================================================================== #
# ProductionEvent endpoints
# ===================================================================== #
@router.get(
    "/production-events/catalog",
    response_model=ProductionEventCatalogResponse,
    tags=["production-events"],
)
async def get_event_catalog(user: CurrentUser) -> ProductionEventCatalogResponse:
    del user  # authentication only — catalog is not tenant-specific.
    return ProductionEventCatalogResponse(
        entries=[
            ProductionEventCatalogEntry.model_validate(e) for e in CATALOG.as_openapi_catalog()
        ],
    )


@router.post(
    "/batches/{batch_id}/events",
    response_model=ProductionEventPublic,
    status_code=status.HTTP_201_CREATED,
    tags=["production-events"],
)
async def create_event(
    batch_id: uuid.UUID,
    payload: ProductionEventCreate,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: Annotated[ProductionEventService, Depends(get_event_service)],
) -> ProductionEventPublic:
    batch, unit, site, farm = await _load_batch(batch_id, user, session)
    event = await service.create(
        actor=user,
        batch=batch,
        unit=unit,
        site=site,
        farm=farm,
        payload=payload.model_dump(exclude_unset=False),
        request_ctx=request_ctx,
    )
    return ProductionEventPublic.model_validate(event)


@router.get(
    "/batches/{batch_id}/events",
    response_model=ProductionEventPage,
    tags=["production-events"],
)
async def list_events(
    batch_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    limit: int = Query(default=50, ge=1, le=500),
    cursor: str | None = Query(default=None),
    event_type: str | None = Query(default=None),
    service: Annotated[ProductionEventService, Depends(get_event_service)] = None,  # type: ignore
) -> ProductionEventPage:
    batch, _, _, _ = await _load_batch(batch_id, user, session)
    rows, next_cursor = await service.list_for_batch(
        batch,
        limit=limit,
        cursor=cursor,
        event_type=event_type,
    )
    return ProductionEventPage(
        items=[ProductionEventPublic.model_validate(r) for r in rows],
        next_cursor=next_cursor,
        limit=limit,
    )


@router.get("/events/{event_id}", response_model=ProductionEventPublic, tags=["production-events"])
async def get_event(
    event_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    event_repo: Annotated[ProductionEventRepository, Depends(get_event_repo)],
) -> ProductionEventPublic:
    event = await event_repo.get_by_id(event_id)
    if event is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Event not found.")
    # Tenant check via the parent batch.
    await _load_batch(event.batch_id, user, session)
    return ProductionEventPublic.model_validate(event)
