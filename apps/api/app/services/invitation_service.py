"""Invitation + role-assignment services."""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status

from app.core.config import get_settings
from app.core.security import create_token
from app.email.base import EmailMessage, EmailSender
from app.models.invitation import Invitation, InvitationStatus
from app.models.role import RoleScope
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.invitation_repo import InvitationRepository
from app.repositories.org_repo import (
    FarmMembershipRepository,
    FarmRepository,
    OrganizationMembershipRepository,
    OrganizationRepository,
)
from app.repositories.role_repo import RoleAssignmentRepository, RoleRepository
from app.repositories.user_repo import UserRepository


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class InvitationService:
    def __init__(
        self,
        *,
        invitation_repo: InvitationRepository,
        role_repo: RoleRepository,
        role_assign_repo: RoleAssignmentRepository,
        user_repo: UserRepository,
        org_repo: OrganizationRepository,
        org_mem_repo: OrganizationMembershipRepository,
        farm_repo: FarmRepository,
        farm_mem_repo: FarmMembershipRepository,
        audit_repo: AuditRepository,
        email_sender: EmailSender,
    ) -> None:
        self.invitation_repo = invitation_repo
        self.role_repo = role_repo
        self.role_assign_repo = role_assign_repo
        self.user_repo = user_repo
        self.org_repo = org_repo
        self.org_mem_repo = org_mem_repo
        self.farm_repo = farm_repo
        self.farm_mem_repo = farm_mem_repo
        self.audit_repo = audit_repo
        self.email_sender = email_sender
        self.settings = get_settings()

    async def create(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        email: str,
        role_name: str,
        farm_id: uuid.UUID | None,
        request_ctx: dict,
    ) -> Invitation:
        org = await self.org_repo.get_by_id(organization_id)
        if org is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found.")

        role = await self.role_repo.get_by_name(role_name)
        if role is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown role: {role_name!r}")

        if role.scope == RoleScope.FARM and farm_id is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Role {role.name!r} is farm-scoped; farm_id is required.",
            )
        if role.scope == RoleScope.ORGANIZATION and farm_id is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Role {role.name!r} is organization-scoped; farm_id must be null.",
            )
        if role.scope == RoleScope.PLATFORM:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Platform-scoped roles cannot be granted via invitation.",
            )

        if farm_id is not None:
            farm = await self.farm_repo.get_by_id(farm_id)
            if farm is None or farm.organization_id != organization_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Farm does not belong to this organization.")

        token, expires_at = create_token(
            subject=uuid.uuid4(),  # opaque — the token itself is not tied to a user yet
            token_type="invite",
            extra_claims={"org_id": str(organization_id), "email": email.lower()},
        )
        invitation = await self.invitation_repo.create(
            organization_id=organization_id,
            farm_id=farm_id,
            role_id=role.id,
            invited_by_id=actor.id,
            email=email.lower(),
            token_hash=_hash_token(token),
            status=InvitationStatus.PENDING,
            expires_at=expires_at,
        )

        accept_url = f"{self.settings.web_app_url.rstrip('/')}/accept-invite?token={token}"
        await self.email_sender.send(
            EmailMessage(
                to=invitation.email,
                subject=f"You have been invited to {org.name} on Agrovix AgOS",
                text_body=(
                    f"{actor.full_name or actor.email} invited you to join {org.name}.\n\n"
                    f"Accept your invitation:\n{accept_url}\n\n"
                    f"This link expires on {expires_at.isoformat()}\n"
                ),
                template="invitation.create",
                context={
                    "accept_url": accept_url,
                    "organization": org.name,
                    "role": role.name,
                },
            )
        )

        await self.audit_repo.record(
            actor_id=actor.id, action="invitation.create",
            entity_type="invitation", entity_id=str(invitation.id),
            organization_id=organization_id, farm_id=farm_id,
            metadata={"email": invitation.email, "role": role.name},
            **request_ctx,
        )
        return invitation

    async def revoke(self, *, actor: User, invitation: Invitation, request_ctx: dict) -> None:
        if invitation.status != InvitationStatus.PENDING:
            raise HTTPException(status.HTTP_409_CONFLICT, "Invitation is not pending.")
        await self.invitation_repo.mark_revoked(invitation)
        await self.audit_repo.record(
            actor_id=actor.id, action="invitation.revoke",
            entity_type="invitation", entity_id=str(invitation.id),
            organization_id=invitation.organization_id, farm_id=invitation.farm_id,
            **request_ctx,
        )

    async def accept(self, *, actor: User, token: str, request_ctx: dict) -> Invitation:
        token_hash = _hash_token(token)
        invitation = await self.invitation_repo.get_by_token_hash(token_hash)
        if invitation is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid invitation token.")
        invitation = await self.invitation_repo.expire_if_needed(invitation)
        if invitation.status != InvitationStatus.PENDING:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invitation is {invitation.status.value}.")
        if invitation.email.lower() != actor.email.lower():
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This invitation is for a different email address.")

        # Wire memberships + role assignment
        await self.org_mem_repo.upsert_active(
            user_id=actor.id,
            org_id=invitation.organization_id,
            invited_by_id=invitation.invited_by_id,
        )
        if invitation.farm_id is not None:
            await self.farm_mem_repo.upsert_active(user_id=actor.id, farm_id=invitation.farm_id)
        await self.role_assign_repo.create(
            user_id=actor.id,
            role_id=invitation.role_id,
            organization_id=invitation.organization_id,
            farm_id=invitation.farm_id,
            granted_by_id=invitation.invited_by_id,
        )

        await self.invitation_repo.mark_accepted(invitation)
        await self.audit_repo.record(
            actor_id=actor.id, action="invitation.accept",
            entity_type="invitation", entity_id=str(invitation.id),
            organization_id=invitation.organization_id, farm_id=invitation.farm_id,
            **request_ctx,
        )
        return invitation


class RoleAssignmentService:
    def __init__(
        self,
        *,
        role_repo: RoleRepository,
        role_assign_repo: RoleAssignmentRepository,
        farm_mem_repo: FarmMembershipRepository,
        org_mem_repo: OrganizationMembershipRepository,
        org_repo: OrganizationRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.role_repo = role_repo
        self.role_assign_repo = role_assign_repo
        self.farm_mem_repo = farm_mem_repo
        self.org_mem_repo = org_mem_repo
        self.org_repo = org_repo
        self.audit_repo = audit_repo

    async def assign(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        target_user: User,
        role_name: str,
        farm_id: uuid.UUID | None,
        request_ctx: dict,
    ):
        role = await self.role_repo.get_by_name(role_name)
        if role is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown role: {role_name!r}")
        if role.scope == RoleScope.PLATFORM:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Platform roles cannot be assigned via API.")
        if role.scope == RoleScope.FARM and farm_id is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "farm_id is required for farm-scoped roles.")
        if role.scope == RoleScope.ORGANIZATION and farm_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "farm_id must be null for organization-scoped roles.")

        assignment = await self.role_assign_repo.create(
            user_id=target_user.id, role_id=role.id,
            organization_id=organization_id, farm_id=farm_id,
            granted_by_id=actor.id,
        )
        await self.org_mem_repo.upsert_active(user_id=target_user.id, org_id=organization_id)
        if farm_id is not None:
            await self.farm_mem_repo.upsert_active(user_id=target_user.id, farm_id=farm_id)

        await self.audit_repo.record(
            actor_id=actor.id, action="role.assign",
            entity_type="role_assignment", entity_id=str(assignment.id),
            organization_id=organization_id, farm_id=farm_id,
            metadata={"role": role.name, "target_user_id": str(target_user.id)},
            **request_ctx,
        )
        return assignment

    async def revoke(self, *, actor: User, assignment, request_ctx: dict) -> None:
        # Prevent orphaning organization ownership.
        role = await self.role_repo.get_by_id(assignment.role_id)
        if role and role.name == "organization_owner":
            remaining = await self.org_repo.count_owners(assignment.organization_id)
            if remaining <= 1:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Cannot revoke the last organization owner — promote another owner first.",
                )
        await self.role_assign_repo.revoke(assignment)
        await self.audit_repo.record(
            actor_id=actor.id, action="role.revoke",
            entity_type="role_assignment", entity_id=str(assignment.id),
            organization_id=assignment.organization_id, farm_id=assignment.farm_id,
            **request_ctx,
        )
