"""Authentication endpoints.

All handlers are thin — they merely translate HTTP concerns into calls
against the :class:`AuthService`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status

from app.deps import get_auth_service, get_current_user
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
)
from app.schemas.common import MessageResponse
from app.schemas.user import UserPublic
from app.services.auth_service import AuthService

router = APIRouter()


def _client_info(request: Request) -> tuple[str | None, str | None]:
    return (
        request.headers.get("user-agent"),
        request.client.host if request.client else None,
    )


@router.post(
    "/register",
    response_model=UserPublic,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user",
)
async def register(
    payload: RegisterRequest,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> UserPublic:
    user = await service.register(
        email=payload.email,
        password=payload.password,
        full_name=payload.full_name,
    )
    return UserPublic.model_validate(
        {
            **{c.name: getattr(user, c.name) for c in user.__table__.columns},
            "roles": [r.name for r in user.roles],
        }
    )


@router.post(
    "/login",
    response_model=TokenPair,
    summary="Issue an access + refresh token pair",
)
async def login(
    payload: LoginRequest,
    request: Request,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> TokenPair:
    ua, ip = _client_info(request)
    _, tokens = await service.login(
        email=payload.email,
        password=payload.password,
        user_agent=ua,
        ip_address=ip,
    )
    return tokens


@router.post(
    "/refresh",
    response_model=TokenPair,
    summary="Rotate an access token using a valid refresh token",
)
async def refresh(
    payload: RefreshRequest,
    request: Request,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> TokenPair:
    ua, ip = _client_info(request)
    return await service.refresh(
        refresh_token=payload.refresh_token,
        user_agent=ua,
        ip_address=ip,
    )


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Revoke the given refresh token",
)
async def logout(
    payload: LogoutRequest,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> MessageResponse:
    await service.logout(refresh_token=payload.refresh_token)
    return MessageResponse(message="Logged out")


@router.get(
    "/me",
    response_model=UserPublic,
    summary="Return the currently authenticated user",
)
async def me(
    user: Annotated[User, Depends(get_current_user)],
) -> UserPublic:
    return UserPublic.model_validate(
        {
            **{c.name: getattr(user, c.name) for c in user.__table__.columns},
            "roles": [r.name for r in user.roles],
        }
    )
