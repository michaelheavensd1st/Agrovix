"""Sprint 1 — tenancy, invitations, role assignment, permission enforcement."""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import hash_password
from app.models.invitation import Invitation
from app.models.user import User


async def _create_verified_user(email: str, password: str = "Sprint0ne!2026") -> User:
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = User(
            email=email.lower(),
            hashed_password=hash_password(password),
            full_name="Tenant User",
            is_active=True,
            is_verified=True,
        )
        session.add(user)
        await session.commit()
        return user


async def _login(client: AsyncClient, email: str, password: str = "Sprint0ne!2026") -> dict[str, str]:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {get_settings().cookie_access_name: r.cookies.get(get_settings().cookie_access_name)}


@pytest.mark.asyncio
async def test_full_onboarding_workflow_with_isolation(client: AsyncClient) -> None:
    settings = get_settings()

    # --- alice creates org + farm --------------------------------------
    alice_email = f"alice-{uuid4().hex[:8]}@agrovix.dev"
    bob_email = f"bob-{uuid4().hex[:8]}@agrovix.dev"
    eve_email = f"eve-{uuid4().hex[:8]}@agrovix.dev"  # external — should never see anything
    await _create_verified_user(alice_email)
    await _create_verified_user(bob_email)
    await _create_verified_user(eve_email)

    alice_cookies = await _login(client, alice_email)
    client.cookies.update(alice_cookies)

    org_slug = f"tenant-{uuid4().hex[:6]}"
    r = await client.post(
        "/api/v1/organizations",
        json={"name": "Tenant Co", "slug": org_slug},
    )
    assert r.status_code == 201, r.text
    org_id = r.json()["id"]

    r = await client.post(
        f"/api/v1/organizations/{org_id}/farms",
        json={"name": "Hatchery One", "code": "HATCH-01"},
    )
    assert r.status_code == 201, r.text
    farm_id = r.json()["id"]

    # --- alice invites bob as farm_manager ------------------------------
    r = await client.post(
        f"/api/v1/organizations/{org_id}/invitations",
        json={"email": bob_email, "role_name": "farm_manager", "farm_id": farm_id},
    )
    assert r.status_code == 201, r.text
    invitation_id = uuid4().__class__(r.json()["id"])

    # Pull the token from the DB (dev EmailSender only logs it — the token
    # is never returned in the API response by design).
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        inv = (await session.execute(select(Invitation).where(Invitation.id == invitation_id))).scalar_one()

    # We can't derive the raw token from the hash — so instead accept the
    # invitation by hitting the service via the token_hash-aware admin
    # path. The public endpoint requires the raw token; for the QA path
    # we insert a well-known token and re-hash.
    from app.core.security import create_token
    import hashlib
    raw_token, _ = create_token(
        subject=uuid4(), token_type="invite",
        extra_claims={"org_id": org_id, "email": bob_email.lower()},
    )
    inv.token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with _db.AsyncSessionLocal() as session:
        session.add(inv)
        await session.commit()

    # --- bob accepts --------------------------------------------------
    client.cookies.clear()
    bob_cookies = await _login(client, bob_email)
    client.cookies.update(bob_cookies)

    r = await client.post("/api/v1/invitations/accept", json={"token": raw_token})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"

    # Bob can now read the farm (farm-scoped role).
    r = await client.get(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 200

    # --- ISOLATION: eve, an unrelated user, cannot see the org or farm --
    client.cookies.clear()
    eve_cookies = await _login(client, eve_email)
    client.cookies.update(eve_cookies)

    r = await client.get(f"/api/v1/organizations/{org_id}")
    assert r.status_code == 404  # tenant leak → not found
    r = await client.get(f"/api/v1/farms/{farm_id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_permission_denied_when_role_lacks_permission(client: AsyncClient) -> None:
    """A worker cannot invite users (missing invitation.create)."""
    settings = get_settings()
    owner_email = f"owner-{uuid4().hex[:8]}@agrovix.dev"
    worker_email = f"worker-{uuid4().hex[:8]}@agrovix.dev"
    await _create_verified_user(owner_email)
    await _create_verified_user(worker_email)

    # owner sets up org
    client.cookies.update(await _login(client, owner_email))
    slug = f"perm-{uuid4().hex[:6]}"
    r = await client.post("/api/v1/organizations", json={"name": "Perm Co", "slug": slug})
    org_id = r.json()["id"]
    r = await client.post(
        f"/api/v1/organizations/{org_id}/farms",
        json={"name": "Farm", "code": "F1"},
    )
    farm_id = r.json()["id"]

    # Find worker.user_id via API
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        worker = (await session.execute(select(User).where(User.email == worker_email.lower()))).scalar_one()

    # assign worker (permission-driven — must go through the API to also record audit)
    r = await client.post(
        f"/api/v1/organizations/{org_id}/role-assignments",
        json={"user_id": str(worker.id), "role_name": "worker", "farm_id": farm_id},
    )
    assert r.status_code == 201, r.text

    # worker logs in and tries to invite → 403
    client.cookies.clear()
    client.cookies.update(await _login(client, worker_email))
    r = await client.post(
        f"/api/v1/organizations/{org_id}/invitations",
        json={"email": "someone@else.com", "role_name": "worker", "farm_id": farm_id},
    )
    assert r.status_code == 403
    assert "invitation.create" in r.json()["detail"]


@pytest.mark.asyncio
async def test_cannot_orphan_organization_ownership(client: AsyncClient) -> None:
    owner_email = f"solo-{uuid4().hex[:8]}@agrovix.dev"
    await _create_verified_user(owner_email)
    client.cookies.update(await _login(client, owner_email))
    r = await client.post(
        "/api/v1/organizations",
        json={"name": "Solo Co", "slug": f"solo-{uuid4().hex[:6]}"},
    )
    org_id = r.json()["id"]

    # The user's own owner assignment is the only one — deletion is blocked.
    r = await client.delete(f"/api/v1/organizations/{org_id}")
    assert r.status_code == 409
    assert "owner" in r.json()["detail"].lower()
