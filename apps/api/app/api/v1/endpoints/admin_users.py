"""Platform user-administration endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from app.deps import RequestCtx, get_admin_user_service, require_permission
from app.models.user import User
from app.schemas.user import (
    AdminUserMutationRequest,
    AdminUserPublic,
    AdminUserSessionsRevokeResponse,
)
from app.services.admin_user_service import AdminUserService

router = APIRouter()

PlatformAdmin = Annotated[User, Depends(require_permission("platform.admin"))]
ServiceDep = Annotated[AdminUserService, Depends(get_admin_user_service)]


@router.get("/{user_id}", response_model=AdminUserPublic)
async def inspect_user(
    user_id: uuid.UUID,
    _admin: PlatformAdmin,
    service: ServiceDep,
) -> AdminUserPublic:
    return AdminUserPublic.model_validate(await service.inspect(target_id=user_id))


@router.post("/{user_id}/disable", response_model=AdminUserPublic)
async def disable_user(
    user_id: uuid.UUID,
    payload: AdminUserMutationRequest,
    admin: PlatformAdmin,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> AdminUserPublic:
    target = await service.disable(
        actor=admin,
        target_id=user_id,
        reason=payload.reason,
        request_ctx=request_ctx,
    )
    return AdminUserPublic.model_validate(target)


@router.post("/{user_id}/enable", response_model=AdminUserPublic)
async def enable_user(
    user_id: uuid.UUID,
    payload: AdminUserMutationRequest,
    admin: PlatformAdmin,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> AdminUserPublic:
    target = await service.enable(
        actor=admin,
        target_id=user_id,
        reason=payload.reason,
        request_ctx=request_ctx,
    )
    return AdminUserPublic.model_validate(target)


@router.post("/{user_id}/sessions/revoke", response_model=AdminUserSessionsRevokeResponse)
async def revoke_user_sessions(
    user_id: uuid.UUID,
    payload: AdminUserMutationRequest,
    admin: PlatformAdmin,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> AdminUserSessionsRevokeResponse:
    target, revoked_sessions = await service.revoke_sessions(
        actor=admin,
        target_id=user_id,
        reason=payload.reason,
        request_ctx=request_ctx,
    )
    return AdminUserSessionsRevokeResponse(
        user=AdminUserPublic.model_validate(target),
        revoked_sessions=revoked_sessions,
    )
