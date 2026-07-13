"""Farm endpoints (tenant-scoped)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import (
    CurrentFarm,
    CurrentOrganization,
    CurrentUser,
    DBSession,
    RequestCtx,
    get_farm_repository,
    get_farm_service,
    require_permission,
)
from app.repositories.org_repo import FarmRepository
from app.schemas.farm import FarmCreateRequest, FarmPublic, FarmUpdateRequest
from app.security.authorize import has_permission, resolve_permissions
from app.services.organization_service import FarmService

router = APIRouter()


@router.post(
    "/organizations/{organization_id}/farms",
    response_model=FarmPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("farm.create"))],
)
async def create_farm(
    payload: FarmCreateRequest,
    org: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[FarmService, Depends(get_farm_service)],
) -> FarmPublic:
    farm = await service.create(
        actor=user, organization_id=org.id, data=payload.model_dump(), request_ctx=request_ctx
    )
    return FarmPublic.model_validate(farm)


@router.get(
    "/organizations/{organization_id}/farms",
    response_model=list[FarmPublic],
)
async def list_farms(
    org: CurrentOrganization,
    user: CurrentUser,
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
) -> list[FarmPublic]:
    # ``list_for_org`` and ``list_accessible_for_user`` both filter out
    # ``deleted_at IS NOT NULL`` — deleted farms never leak into
    # normal collection queries.
    if user.is_superuser:
        farms = await farm_repo.list_for_org(org.id)
    else:
        farms = await farm_repo.list_accessible_for_user(user_id=user.id, org_id=org.id)
    return [FarmPublic.model_validate(f) for f in farms]


@router.get("/farms/{farm_id}", response_model=FarmPublic)
async def get_farm(farm: CurrentFarm) -> FarmPublic:
    # ``CurrentFarm`` uses ``get_by_id`` which filters deleted rows, so
    # a soft-deleted farm returns 404 here — matching cross-tenant leak
    # protection.
    return FarmPublic.model_validate(farm)


@router.patch(
    "/farms/{farm_id}",
    response_model=FarmPublic,
    dependencies=[Depends(require_permission("farm.update"))],
)
async def update_farm(
    farm_id: uuid.UUID,
    payload: FarmUpdateRequest,
    farm: CurrentFarm,
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
) -> FarmPublic:
    del farm_id
    changed = payload.model_dump(exclude_unset=True)
    for k, v in changed.items():
        setattr(farm, k, v)
    await farm_repo.session.flush()
    return FarmPublic.model_validate(farm)


@router.delete(
    "/farms/{farm_id}",
    response_model=FarmPublic,
    dependencies=[Depends(require_permission("farm.delete"))],
)
async def delete_farm(
    farm_id: uuid.UUID,
    farm: CurrentFarm,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[FarmService, Depends(get_farm_service)],
) -> FarmPublic:
    """Soft-delete a farm.

    Removes the farm from list/read queries and prevents new operational
    records or memberships from being attached (see
    :meth:`InvitationService.create` and :meth:`FarmService.ensure_active`).
    Restore is available via ``POST /farms/{farm_id}/restore``.
    """
    del farm_id
    await service.delete(actor=user, farm=farm, request_ctx=request_ctx)
    return FarmPublic.model_validate(farm)


@router.post(
    "/farms/{farm_id}/restore",
    response_model=FarmPublic,
)
async def restore_farm(
    farm_id: uuid.UUID,
    user: CurrentUser,
    request_ctx: RequestCtx,
    session: DBSession,
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
    service: Annotated[FarmService, Depends(get_farm_service)],
) -> FarmPublic:
    """Restore a soft-deleted farm.

    A dedicated ``get_by_id_including_deleted`` lookup is used because the
    normal :class:`FarmRepository.get_by_id` (and therefore the
    :data:`CurrentFarm` dep) filters out deleted rows — that filtering is
    precisely the invariant that restore has to bypass.

    Access control is scoped to the farm's parent organization: the
    caller must have ``farm.restore`` in that org (or be a superuser).
    """
    farm = await farm_repo.get_by_id_including_deleted(farm_id)
    if farm is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farm not found.")

    if not user.is_superuser:
        codes = await resolve_permissions(
            session, user, organization_id=farm.organization_id, farm_id=farm.id
        )
        if not has_permission(codes, "farm.restore"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Missing required permission: farm.restore",
            )

    await service.restore(actor=user, farm=farm, request_ctx=request_ctx)
    return FarmPublic.model_validate(farm)
