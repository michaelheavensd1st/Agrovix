"""Farm endpoints (tenant-scoped)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.deps import (
    CurrentFarm,
    CurrentOrganization,
    CurrentUser,
    RequestCtx,
    get_farm_repository,
    get_farm_service,
    require_permission,
)
from app.repositories.org_repo import FarmRepository
from app.schemas.farm import FarmCreateRequest, FarmPublic, FarmUpdateRequest
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
    if user.is_superuser:
        farms = await farm_repo.list_for_org(org.id)
    else:
        farms = await farm_repo.list_accessible_for_user(user_id=user.id, org_id=org.id)
    return [FarmPublic.model_validate(f) for f in farms]


@router.get("/farms/{farm_id}", response_model=FarmPublic)
async def get_farm(farm: CurrentFarm) -> FarmPublic:
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
