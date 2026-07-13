"""Shared helpers for tenancy/farm/audit test suites.

Keeping the setup boilerplate in one place makes the individual tests
easier to read and prevents drift between test files.
"""

from __future__ import annotations

import hashlib
from uuid import UUID, uuid4

from httpx import AsyncClient
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import create_token, hash_password
from app.models.invitation import Invitation
from app.models.user import User


DEFAULT_PW = "Sprint0ne!2026"


async def create_verified_user(email: str, password: str = DEFAULT_PW) -> User:
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = User(
            email=email.lower(),
            hashed_password=hash_password(password),
            full_name="Test User",
            is_active=True,
            is_verified=True,
        )
        session.add(user)
        await session.commit()
        return user


async def login(client: AsyncClient, email: str, password: str = DEFAULT_PW) -> dict[str, str]:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    settings = get_settings()
    return {
        settings.cookie_access_name: r.cookies.get(settings.cookie_access_name),
        settings.cookie_refresh_name: r.cookies.get(settings.cookie_refresh_name),
    }


async def switch_user(client: AsyncClient, email: str) -> None:
    client.cookies.clear()
    client.cookies.update(await login(client, email))


async def create_org(client: AsyncClient, name: str = "Tenant Co", slug: str | None = None) -> str:
    slug = slug or f"org-{uuid4().hex[:8]}"
    r = await client.post("/api/v1/organizations", json={"name": name, "slug": slug})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def create_farm(client: AsyncClient, org_id: str, name: str = "Farm A", code: str | None = None) -> str:
    code = code or f"F-{uuid4().hex[:6]}"
    r = await client.post(
        f"/api/v1/organizations/{org_id}/farms",
        json={"name": name, "code": code},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def invite_and_accept(
    client: AsyncClient,
    *,
    inviter_email: str,
    invitee_email: str,
    org_id: str,
    role_name: str,
    farm_id: str | None = None,
) -> None:
    """Full invite → mint synthetic token → accept flow.

    The dev EmailSender only logs the raw token, so tests rewrite the
    stored token_hash to a value they own (this is the same trick used
    by ``test_tenancy.py``).
    """
    # Inviter creates invitation
    await switch_user(client, inviter_email)
    r = await client.post(
        f"/api/v1/organizations/{org_id}/invitations",
        json={
            "email": invitee_email,
            "role_name": role_name,
            **({"farm_id": farm_id} if farm_id else {}),
        },
    )
    assert r.status_code == 201, r.text
    invitation_id = UUID(r.json()["id"])

    # Rewrite the stored token to a known raw token.
    from app.db import session as _db
    raw_token, _ = create_token(
        subject=uuid4(), token_type="invite",
        extra_claims={"org_id": org_id, "email": invitee_email.lower()},
    )
    async with _db.AsyncSessionLocal() as session:
        inv = (await session.execute(select(Invitation).where(Invitation.id == invitation_id))).scalar_one()
        inv.token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        session.add(inv)
        await session.commit()

    # Invitee accepts
    await switch_user(client, invitee_email)
    r = await client.post("/api/v1/invitations/accept", json={"token": raw_token})
    assert r.status_code == 200, r.text
