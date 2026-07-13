"""FastAPI dependency-injection helpers.

The dependency graph is intentionally shallow — every request-scoped
collaborator is a function that takes a DB session (or another dep) and
returns a repository / service.
"""

from __future__ import annotations

import uuid
from typing import Annotated
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import organization_id_var, user_id_var
from app.core.rate_limit import RateLimiter
from app.core.rate_limit_factory import get_rate_limiter
from app.core.security import TokenExpiredError, TokenInvalidError, decode_token
from app.db.session import get_db_session
from app.email.base import EmailSender
from app.email.factory import get_email_sender
from app.models.farm import Farm
from app.models.organization import Organization
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.invitation_repo import InvitationRepository
from app.repositories.org_repo import (
    FarmMembershipRepository,
    FarmRepository,
    OrganizationMembershipRepository,
    OrganizationRepository,
)
from app.repositories.refresh_token_repo import RefreshTokenRepository
from app.repositories.role_repo import (
    PermissionRepository,
    RoleAssignmentRepository,
    RoleRepository,
)
from app.repositories.user_repo import UserRepository
from app.repositories.verification_repo import VerificationTokenRepository
from app.security.authorize import has_permission, resolve_permissions
from app.services.auth_service import AuthService
from app.services.invitation_service import InvitationService, RoleAssignmentService
from app.services.organization_service import FarmService, OrganizationService

_settings = get_settings()

# Auth-scheme (bearer OR cookie — the extractor below tries both).
_bearer = HTTPBearer(auto_error=False)

DBSession = Annotated[AsyncSession, Depends(get_db_session)]


# --------------------------------------------------------------------- #
# Repositories
# --------------------------------------------------------------------- #
def get_user_repository(session: DBSession) -> UserRepository:
    return UserRepository(session)


def get_refresh_token_repository(session: DBSession) -> RefreshTokenRepository:
    return RefreshTokenRepository(session)


def get_verification_repository(session: DBSession) -> VerificationTokenRepository:
    return VerificationTokenRepository(session)


def get_role_repository(session: DBSession) -> RoleRepository:
    return RoleRepository(session)


def get_role_assignment_repository(session: DBSession) -> RoleAssignmentRepository:
    return RoleAssignmentRepository(session)


def get_permission_repository(session: DBSession) -> PermissionRepository:
    return PermissionRepository(session)


def get_organization_repository(session: DBSession) -> OrganizationRepository:
    return OrganizationRepository(session)


def get_organization_membership_repository(session: DBSession) -> OrganizationMembershipRepository:
    return OrganizationMembershipRepository(session)


def get_farm_repository(session: DBSession) -> FarmRepository:
    return FarmRepository(session)


def get_farm_membership_repository(session: DBSession) -> FarmMembershipRepository:
    return FarmMembershipRepository(session)


def get_invitation_repository(session: DBSession) -> InvitationRepository:
    return InvitationRepository(session)


def get_audit_repository(session: DBSession) -> AuditRepository:
    return AuditRepository(session)


def get_email_sender_dep() -> EmailSender:
    return get_email_sender()


def get_rate_limiter_dep() -> RateLimiter:
    return get_rate_limiter()


# --------------------------------------------------------------------- #
# Services
# --------------------------------------------------------------------- #
def get_auth_service(
    user_repo: Annotated[UserRepository, Depends(get_user_repository)],
    refresh_repo: Annotated[RefreshTokenRepository, Depends(get_refresh_token_repository)],
    verification_repo: Annotated[VerificationTokenRepository, Depends(get_verification_repository)],
    email_sender: Annotated[EmailSender, Depends(get_email_sender_dep)],
    rate_limiter: Annotated[RateLimiter, Depends(get_rate_limiter_dep)],
) -> AuthService:
    return AuthService(
        user_repo=user_repo,
        refresh_repo=refresh_repo,
        verification_repo=verification_repo,
        email_sender=email_sender,
        rate_limiter=rate_limiter,
    )


def get_organization_service(
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    org_mem_repo: Annotated[OrganizationMembershipRepository, Depends(get_organization_membership_repository)],
    role_repo: Annotated[RoleRepository, Depends(get_role_repository)],
    role_assign_repo: Annotated[RoleAssignmentRepository, Depends(get_role_assignment_repository)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> OrganizationService:
    return OrganizationService(
        org_repo=org_repo, org_mem_repo=org_mem_repo,
        role_repo=role_repo, role_assign_repo=role_assign_repo, audit_repo=audit_repo,
    )


def get_farm_service(
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
    farm_mem_repo: Annotated[FarmMembershipRepository, Depends(get_farm_membership_repository)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> FarmService:
    return FarmService(farm_repo=farm_repo, farm_mem_repo=farm_mem_repo, audit_repo=audit_repo)


def get_invitation_service(
    invitation_repo: Annotated[InvitationRepository, Depends(get_invitation_repository)],
    role_repo: Annotated[RoleRepository, Depends(get_role_repository)],
    role_assign_repo: Annotated[RoleAssignmentRepository, Depends(get_role_assignment_repository)],
    user_repo: Annotated[UserRepository, Depends(get_user_repository)],
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    org_mem_repo: Annotated[OrganizationMembershipRepository, Depends(get_organization_membership_repository)],
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
    farm_mem_repo: Annotated[FarmMembershipRepository, Depends(get_farm_membership_repository)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
    email_sender: Annotated[EmailSender, Depends(get_email_sender_dep)],
) -> InvitationService:
    return InvitationService(
        invitation_repo=invitation_repo, role_repo=role_repo, role_assign_repo=role_assign_repo,
        user_repo=user_repo, org_repo=org_repo, org_mem_repo=org_mem_repo,
        farm_repo=farm_repo, farm_mem_repo=farm_mem_repo,
        audit_repo=audit_repo, email_sender=email_sender,
    )


def get_role_assignment_service(
    role_repo: Annotated[RoleRepository, Depends(get_role_repository)],
    role_assign_repo: Annotated[RoleAssignmentRepository, Depends(get_role_assignment_repository)],
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    org_mem_repo: Annotated[OrganizationMembershipRepository, Depends(get_organization_membership_repository)],
    farm_mem_repo: Annotated[FarmMembershipRepository, Depends(get_farm_membership_repository)],
    audit_repo: Annotated[AuditRepository, Depends(get_audit_repository)],
) -> RoleAssignmentService:
    return RoleAssignmentService(
        role_repo=role_repo, role_assign_repo=role_assign_repo,
        farm_mem_repo=farm_mem_repo, org_mem_repo=org_mem_repo,
        org_repo=org_repo, audit_repo=audit_repo,
    )


# --------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------- #
def _extract_access_token(
    creds: HTTPAuthorizationCredentials | None,
    cookie_token: str | None,
) -> str | None:
    if creds and creds.scheme.lower() == "bearer" and creds.credentials:
        return creds.credentials
    return cookie_token


async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    cookie_token: Annotated[str | None, Cookie(alias=_settings.cookie_access_name)] = None,
    user_repo: UserRepository = Depends(get_user_repository),
) -> User:
    token = _extract_access_token(creds, cookie_token)
    if not token:
        raise _unauthorized()
    try:
        payload = decode_token(token, expected_type="access")
        user_id = UUID(payload["sub"])
    except TokenExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Access token has expired.",
            headers={"WWW-Authenticate": 'Bearer error="invalid_token", error_description="expired"'},
        ) from exc
    except (TokenInvalidError, KeyError, ValueError) as exc:
        raise _unauthorized() from exc

    user = await user_repo.get_by_id(user_id)
    if user is None or not user.is_active or user.deleted_at is not None:
        raise _unauthorized()
    user_id_var.set(str(user.id))
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


# --------------------------------------------------------------------- #
# Tenancy — org / farm loaders that enforce membership.
# --------------------------------------------------------------------- #
async def get_current_organization(
    organization_id: uuid.UUID,
    user: CurrentUser,
    org_repo: Annotated[OrganizationRepository, Depends(get_organization_repository)],
    org_mem_repo: Annotated[OrganizationMembershipRepository, Depends(get_organization_membership_repository)],
) -> Organization:
    org = await org_repo.get_by_id(organization_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found.")
    if not user.is_superuser:
        membership = await org_mem_repo.get(user.id, org.id)
        if membership is None or not membership.is_active:
            # Do not leak existence — return 404 rather than 403.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found.")
    organization_id_var.set(str(org.id))
    return org


CurrentOrganization = Annotated[Organization, Depends(get_current_organization)]


async def get_current_farm(
    farm_id: uuid.UUID,
    user: CurrentUser,
    farm_repo: Annotated[FarmRepository, Depends(get_farm_repository)],
    farm_mem_repo: Annotated[FarmMembershipRepository, Depends(get_farm_membership_repository)],
    org_mem_repo: Annotated[OrganizationMembershipRepository, Depends(get_organization_membership_repository)],
    role_assign_repo: Annotated[RoleAssignmentRepository, Depends(get_role_assignment_repository)],
) -> Farm:
    farm = await farm_repo.get_by_id(farm_id)
    if farm is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farm not found.")
    if user.is_superuser:
        organization_id_var.set(str(farm.organization_id))
        return farm

    # Must be a member of the parent org
    org_mem = await org_mem_repo.get(user.id, farm.organization_id)
    if org_mem is None or not org_mem.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farm not found.")

    # Must have either an org-scoped role assignment OR explicit farm membership
    org_scoped = [
        a for a in await role_assign_repo.list_for_user(user.id)
        if a.organization_id == farm.organization_id and a.farm_id is None
    ]
    if not org_scoped:
        if not await farm_mem_repo.user_has_farm(user_id=user.id, farm_id=farm.id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Farm not found.")

    organization_id_var.set(str(farm.organization_id))
    return farm


CurrentFarm = Annotated[Farm, Depends(get_current_farm)]


# --------------------------------------------------------------------- #
# Permission dependencies (permission-driven, never role-name based)
# --------------------------------------------------------------------- #
def require_permission(code: str):
    async def _dep(
        user: CurrentUser,
        session: DBSession,
        organization_id: uuid.UUID | None = None,
        farm_id: uuid.UUID | None = None,
    ) -> User:
        codes = await resolve_permissions(
            session, user, organization_id=organization_id, farm_id=farm_id
        )
        if not has_permission(codes, code):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required permission: {code}",
            )
        return user

    return _dep


# --------------------------------------------------------------------- #
# Request context (for services + audit trail)
# --------------------------------------------------------------------- #
def get_request_ctx(request: Request) -> dict:
    from app.core.logging import request_id_var
    return {
        "ip_address": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent"),
        "request_id": request_id_var.get(),
    }


RequestCtx = Annotated[dict, Depends(get_request_ctx)]


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )
