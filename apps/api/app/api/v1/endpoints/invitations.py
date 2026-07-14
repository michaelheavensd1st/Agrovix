"""Invitation endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import (
    CurrentOrganization,
    CurrentUser,
    RequestCtx,
    get_invitation_repository,
    get_invitation_service,
    require_permission,
)
from app.repositories.invitation_repo import InvitationRepository
from app.schemas.common import MessageResponse
from app.schemas.invitation import (
    AcceptInvitationRequest,
    InvitationCreateRequest,
    InvitationPublic,
)
from app.services.invitation_service import InvitationService

router = APIRouter()


@router.post(
    "/organizations/{organization_id}/invitations",
    response_model=InvitationPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("invitation.create"))],
)
async def create_invitation(
    payload: InvitationCreateRequest,
    org: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[InvitationService, Depends(get_invitation_service)],
) -> InvitationPublic:
    invitation = await service.create(
        actor=user,
        organization_id=org.id,
        email=payload.email,
        role_name=payload.role_name,
        farm_id=payload.farm_id,
        request_ctx=request_ctx,
    )
    return InvitationPublic.model_validate(invitation)


@router.get(
    "/organizations/{organization_id}/invitations",
    response_model=list[InvitationPublic],
    dependencies=[Depends(require_permission("invitation.list"))],
)
async def list_invitations(
    org: CurrentOrganization,
    invitation_repo: Annotated[InvitationRepository, Depends(get_invitation_repository)],
) -> list[InvitationPublic]:
    rows = await invitation_repo.list_for_org(org.id)
    return [InvitationPublic.model_validate(r) for r in rows]


@router.post("/invitations/accept", response_model=InvitationPublic)
async def accept_invitation(
    payload: AcceptInvitationRequest,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: Annotated[InvitationService, Depends(get_invitation_service)],
) -> InvitationPublic:
    invitation = await service.accept(actor=user, token=payload.token, request_ctx=request_ctx)
    return InvitationPublic.model_validate(invitation)


@router.post("/invitations/{invitation_id}/revoke", response_model=MessageResponse)
async def revoke_invitation(
    invitation_id: uuid.UUID,
    user: CurrentUser,
    request_ctx: RequestCtx,
    invitation_repo: Annotated[InvitationRepository, Depends(get_invitation_repository)],
    service: Annotated[InvitationService, Depends(get_invitation_service)],
) -> MessageResponse:
    invitation = await invitation_repo.get_by_id(invitation_id)
    if invitation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invitation not found.")
    # Manually re-check permission scoped to invitation.organization_id
    from app.security.authorize import has_permission, resolve_permissions

    codes = await resolve_permissions(
        invitation_repo.session, user, organization_id=invitation.organization_id
    )
    if not has_permission(codes, "invitation.revoke"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Missing required permission: invitation.revoke"
        )
    await service.revoke(actor=user, invitation=invitation, request_ctx=request_ctx)
    return MessageResponse(message="Invitation revoked")
