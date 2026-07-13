"""FastAPI dependency-injection helpers."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import decode_token
from app.db.session import get_db_session
from app.models.user import User
from app.repositories.refresh_token_repo import RefreshTokenRepository
from app.repositories.user_repo import UserRepository
from app.services.auth_service import AuthService

_settings = get_settings()

oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl=f"{_settings.api_v1_prefix}/auth/login",
    auto_error=False,
)

DBSession = Annotated[AsyncSession, Depends(get_db_session)]


def get_user_repository(session: DBSession) -> UserRepository:
    return UserRepository(session)


def get_refresh_token_repository(session: DBSession) -> RefreshTokenRepository:
    return RefreshTokenRepository(session)


def get_auth_service(
    user_repo: Annotated[UserRepository, Depends(get_user_repository)],
    refresh_repo: Annotated[RefreshTokenRepository, Depends(get_refresh_token_repository)],
) -> AuthService:
    return AuthService(user_repo=user_repo, refresh_repo=refresh_repo)


async def get_current_user(
    token: Annotated[str | None, Depends(oauth2_scheme)],
    user_repo: Annotated[UserRepository, Depends(get_user_repository)],
) -> User:
    """Resolve the authenticated user from an access token."""
    if not token:
        raise _unauthorized()

    try:
        payload = decode_token(token, expected_type="access")
        user_id = UUID(payload["sub"])
    except (JWTError, KeyError, ValueError) as exc:
        raise _unauthorized() from exc

    user = await user_repo.get_by_id(user_id)
    if user is None or not user.is_active:
        raise _unauthorized()

    return user


def require_roles(*required: str):
    """Dependency factory that requires the user to have *any* of the given roles."""

    async def _dep(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.is_superuser:
            return user
        role_names = {r.name for r in user.roles}
        if not role_names.intersection(required):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient role privileges.",
            )
        return user

    return _dep


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )
