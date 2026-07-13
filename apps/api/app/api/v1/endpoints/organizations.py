"""Organization endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import (
    CurrentOrganization,
    CurrentUser,
    DBSession,
    RequestCtx,
    get_organization_repository,
    get_organization_service,
    require_permission,
)
from app.repositories.org_repo import OrganizationRepository
from app.schemas.organization import (
    OrganizationCreateRequest,
    OrganizationPublic,
    OrganizationUpdateRequest,
)
from app.services.organization_service import OrganizationService

router = APIRouter()


@router.post("", response_model=OrganizationPublic, status_code=status.HTTP_201_CREATED)
async def create_organization(
    payload: OrganizationCreateRequest,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[OrganizationService, Depends(get_organization_service)],
) -> OrganizationPublic:
    org = await service.create(actor=user, data=payload.model_dump(), request_ctx=request_ctx)
    return OrganizationPublic.model_validate(org)


@router.get("", response_model=list[OrganizationPublic])
async def list_organizations(
    user: CurrentUser,
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
) -> list[OrganizationPublic]:
    orgs = await org_repo.list_for_user(user.id)
    return [OrganizationPublic.model_validate(o) for o in orgs]


@router.get("/{organization_id}", response_model=OrganizationPublic)
async def get_organization(org: CurrentOrganization) -> OrganizationPublic:
    return OrganizationPublic.model_validate(org)


@router.patch(
    "/{organization_id}",
    response_model=OrganizationPublic,
    dependencies=[Depends(require_permission("organization.update"))],
)
async def update_organization(
    organization_id: uuid.UUID,
    payload: OrganizationUpdateRequest,
    org: CurrentOrganization,
    session: DBSession,
) -> OrganizationPublic:
    del organization_id  # path param — org already resolved by dependency
    changed = payload.model_dump(exclude_unset=True)
    for k, v in changed.items():
        setattr(org, k, v)
    session.add(org)
    await session.flush()
    return OrganizationPublic.model_validate(org)


@router.delete(
    "/{organization_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=None,
    dependencies=[Depends(require_permission("organization.delete"))],
)
async def delete_organization(
    org: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    service: Annotated[OrganizationService, Depends(get_organization_service)],
):
    del org_repo  # kept for symmetry
    # Prevent orphaning ownership.
    if not user.is_superuser:
        remaining = await service.org_repo.count_owners(org.id)
        if remaining <= 1:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This organization has only one active owner. Promote another owner before deleting.",
            )
    await service.delete(actor=user, org=org, request_ctx=request_ctx)
