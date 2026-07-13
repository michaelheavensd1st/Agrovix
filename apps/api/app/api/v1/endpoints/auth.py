"""Authentication endpoints — cookie-first with body-token fallback."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response, status
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.cookies import clear_auth_cookies, set_auth_cookies
from app.deps import CurrentUser, get_auth_service
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    ResendVerificationRequest,
    VerifyEmailRequest,
)
from app.schemas.common import MessageResponse
from app.schemas.user import UserPublic
from app.services.auth_service import AuthService

router = APIRouter()
_settings = get_settings()


def _to_public(user: User, permissions: list[str] | None = None) -> UserPublic:
    return UserPublic.model_validate(
        {
            "id": user.id, "email": user.email, "full_name": user.full_name,
            "is_active": user.is_active, "is_verified": user.is_verified,
            "is_superuser": user.is_superuser,
            "created_at": user.created_at, "updated_at": user.updated_at,
            "permissions": permissions or [],
        }
    )


@router.post("/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterRequest,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> UserPublic:
    user = await service.register(email=payload.email, password=payload.password, full_name=payload.full_name)
    return _to_public(user)


@router.post("/verify", response_model=UserPublic)
async def verify(
    payload: VerifyEmailRequest,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> UserPublic:
    user = await service.verify_email(token=payload.token)
    return _to_public(user)


@router.post("/resend-verification", response_model=MessageResponse)
async def resend_verification(
    payload: ResendVerificationRequest,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> MessageResponse:
    await service.resend_verification(email=payload.email)
    # Always OK to avoid leaking account existence.
    return MessageResponse(message="If the account exists, a verification email was sent.")


@router.post("/login")
async def login(
    payload: LoginRequest,
    request: Request,
    service: Annotated[AuthService, Depends(get_auth_service)],
) -> JSONResponse:
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    _, tokens = await service.login(email=payload.email, password=payload.password, user_agent=ua, ip_address=ip)

    access_life, refresh_life = service.token_lifetimes()
    response = JSONResponse(
        {"token_type": "bearer", "expires_in": tokens.expires_in}
    )
    set_auth_cookies(
        response,
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        access_max_age_s=int(access_life.total_seconds()),
        refresh_max_age_s=int(refresh_life.total_seconds()),
    )
    return response


@router.post("/refresh")
async def refresh(
    payload: RefreshRequest,
    request: Request,
    service: Annotated[AuthService, Depends(get_auth_service)],
    cookie_refresh: Annotated[str | None, Cookie(alias=_settings.cookie_refresh_name)] = None,
) -> JSONResponse:
    refresh_token = payload.refresh_token or cookie_refresh
    if not refresh_token:
        return JSONResponse({"detail": "Missing refresh token."}, status_code=401)
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    tokens = await service.refresh(refresh_token=refresh_token, user_agent=ua, ip_address=ip)

    access_life, refresh_life = service.token_lifetimes()
    response = JSONResponse({"token_type": "bearer", "expires_in": tokens.expires_in})
    set_auth_cookies(
        response,
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        access_max_age_s=int(access_life.total_seconds()),
        refresh_max_age_s=int(refresh_life.total_seconds()),
    )
    return response


@router.post("/logout", response_model=MessageResponse)
async def logout(
    payload: LogoutRequest,
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    cookie_refresh: Annotated[str | None, Cookie(alias=_settings.cookie_refresh_name)] = None,
) -> MessageResponse:
    refresh_token = payload.refresh_token or cookie_refresh
    if refresh_token:
        await service.logout(refresh_token=refresh_token)
    clear_auth_cookies(response)
    return MessageResponse(message="Logged out")


@router.get("/me", response_model=UserPublic)
async def me(user: CurrentUser) -> UserPublic:
    return _to_public(user)
