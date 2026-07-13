"""Role-assignment endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.deps import (
    CurrentOrganization,
    CurrentUser,
    RequestCtx,
    get_role_assignment_repository,
    get_role_assignment_service,
    get_user_repository,
    require_permission,
)
from app.repositories.role_repo import RoleAssignmentRepository
from app.repositories.user_repo import UserRepository
from app.schemas.common import MessageResponse
from app.schemas.role_assignment import RoleAssignmentPublic, RoleAssignmentRequest
from app.services.invitation_service import RoleAssignmentService

router = APIRouter()


@router.post(
    "/organizations/{organization_id}/role-assignments",
    response_model=RoleAssignmentPublic,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("organization.role.assign"))],
)
async def assign_role(
    payload: RoleAssignmentRequest,
    org: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    user_repo: Annotated[UserRepository, Depends(get_user_repository)],
    service: Annotated[RoleAssignmentService, Depends(get_role_assignment_service)],
) -> RoleAssignmentPublic:
    target = await user_repo.get_by_id(payload.user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Target user not found.")
    assignment = await service.assign(
        actor=user, organization_id=org.id, target_user=target,
        role_name=payload.role_name, farm_id=payload.farm_id, request_ctx=request_ctx,
    )
    return RoleAssignmentPublic.model_validate(assignment)


@router.delete(
    "/role-assignments/{assignment_id}",
    response_model=MessageResponse,
)
async def revoke_role(
    assignment_id: uuid.UUID,
    user: CurrentUser,
    request_ctx: RequestCtx,
    role_assign_repo: Annotated[RoleAssignmentRepository, Depends(get_role_assignment_repository)],
    service: Annotated[RoleAssignmentService, Depends(get_role_assignment_service)],
) -> MessageResponse:
    assignment = await role_assign_repo.get_by_id(assignment_id)
    if assignment is None or assignment.revoked_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Role assignment not found.")
    from app.security.authorize import has_permission, resolve_permissions
    codes = await resolve_permissions(
        role_assign_repo.session, user, organization_id=assignment.organization_id
    )
    if not has_permission(codes, "organization.role.assign"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Missing required permission: organization.role.assign"
        )
    await service.revoke(actor=user, assignment=assignment, request_ctx=request_ctx)
    return MessageResponse(message="Role revoked")
