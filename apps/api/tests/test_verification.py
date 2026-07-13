"""Email-verification lifecycle + rate-limit tests."""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import create_token, hash_password
from app.models.user import User
from app.models.verification import EmailVerificationToken


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def _register(client: AsyncClient, email: str, password: str = "Sprint0ne!2026") -> None:
    r = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "full_name": "Ver Test"},
    )
    assert r.status_code == 201, r.text


async def _active_tokens_for(email: str) -> list[EmailVerificationToken]:
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == email.lower()))).scalar_one()
        rows = (
            await session.execute(
                select(EmailVerificationToken).where(
                    EmailVerificationToken.user_id == user.id,
                    EmailVerificationToken.is_used.is_(False),
                )
            )
        ).scalars().all()
        return list(rows)


@pytest.mark.asyncio
async def test_only_one_active_verification_token_per_user(client: AsyncClient) -> None:
    """Registering + two resends must leave exactly ONE active token."""
    email = f"one-{uuid4().hex[:8]}@agrovix.dev"
    await _register(client, email)
    assert len(await _active_tokens_for(email)) == 1

    # First resend
    r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
    assert r.status_code == 200
    assert len(await _active_tokens_for(email)) == 1

    # Second resend
    r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
    assert r.status_code == 200
    assert len(await _active_tokens_for(email)) == 1


@pytest.mark.asyncio
async def test_expired_verification_token_is_rejected(client: AsyncClient) -> None:
    email = f"exp-{uuid4().hex[:8]}@agrovix.dev"
    # Register a user directly and forge an already-expired token in the DB.
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = User(
            email=email.lower(),
            hashed_password=hash_password("Sprint0ne!2026"),
            full_name="Exp",
        )
        session.add(user)
        await session.commit()

        expired_token, _ = create_token(
            subject=user.id, token_type="verify",
            expires_delta=timedelta(seconds=-60),
        )
        session.add(
            EmailVerificationToken(
                user_id=user.id,
                token_hash=_hash(expired_token),
                expires_at=datetime.now(timezone.utc) - timedelta(seconds=60),
            )
        )
        await session.commit()

    r = await client.post("/api/v1/auth/verify", json={"token": expired_token})
    assert r.status_code == 400
    assert "expired" in r.json()["detail"].lower() or "invalid" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_verification_token_invalidated_after_successful_verify(client: AsyncClient) -> None:
    """The same verification token cannot be reused after it succeeds."""
    email = f"reuse-{uuid4().hex[:8]}@agrovix.dev"
    await _register(client, email)

    # Fabricate a token in DB with a known raw value so we can present it.
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == email.lower()))).scalar_one()
        # Invalidate any residual (should be exactly 1) and insert our own.
        await session.execute(
            select(EmailVerificationToken).where(EmailVerificationToken.user_id == user.id)
        )
        for row in (await session.execute(
            select(EmailVerificationToken).where(EmailVerificationToken.user_id == user.id)
        )).scalars().all():
            row.is_used = True
            session.add(row)
        raw_token, exp = create_token(subject=user.id, token_type="verify")
        session.add(
            EmailVerificationToken(
                user_id=user.id, token_hash=_hash(raw_token), expires_at=exp,
            )
        )
        await session.commit()

    r1 = await client.post("/api/v1/auth/verify", json={"token": raw_token})
    assert r1.status_code == 200, r1.text
    assert r1.json()["is_verified"] is True

    # Second use → 400
    r2 = await client.post("/api/v1/auth/verify", json={"token": raw_token})
    assert r2.status_code == 400

    # And any other (older) active tokens must also be gone.
    assert await _active_tokens_for(email) == []


@pytest.mark.asyncio
async def test_resend_verification_rate_limited(client: AsyncClient) -> None:
    """4th resend within the window returns 429 with a Retry-After header."""
    from app.core import rate_limit_factory
    from app.core.rate_limit import InMemoryRateLimiter

    # Isolated limiter so this test's state doesn't leak across the suite.
    fresh = InMemoryRateLimiter()
    original = rate_limit_factory.get_rate_limiter
    rate_limit_factory.get_rate_limiter = lambda: fresh  # type: ignore[assignment]
    try:
        email = f"rl-{uuid4().hex[:8]}@agrovix.dev"
        await _register(client, email)  # burns one email-verification issuance internally

        settings = get_settings()
        for _ in range(settings.resend_verification_max_per_email_hour):
            r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
            assert r.status_code == 200

        # One more → 429
        r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
        assert r.status_code == 429
        assert r.headers.get("Retry-After") is not None
        assert int(r.headers["Retry-After"]) >= 1
        # No new token issued while throttled.
        assert len(await _active_tokens_for(email)) == 1
    finally:
        rate_limit_factory.get_rate_limiter = original


@pytest.mark.asyncio
async def test_resend_for_unknown_email_is_silent_but_still_rate_limited(
    client: AsyncClient,
) -> None:
    """Enumeration protection: unknown emails receive the same 200 response."""
    from app.core import rate_limit_factory
    from app.core.rate_limit import InMemoryRateLimiter

    fresh = InMemoryRateLimiter()
    original = rate_limit_factory.get_rate_limiter
    rate_limit_factory.get_rate_limiter = lambda: fresh  # type: ignore[assignment]
    try:
        email = f"nobody-{uuid4().hex[:8]}@agrovix.dev"

        for _ in range(get_settings().resend_verification_max_per_email_hour):
            r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
            assert r.status_code == 200
            # Body wording never confirms existence.
            assert "if the account exists" in r.json()["message"].lower()

        r = await client.post("/api/v1/auth/resend-verification", json={"email": email})
        assert r.status_code == 429
    finally:
        rate_limit_factory.get_rate_limiter = original
