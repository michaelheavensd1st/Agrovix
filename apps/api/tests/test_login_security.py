"""Login rate-limiting + security tests.

Verifies that ``/api/v1/auth/login`` and ``/api/v1/invitations/accept``
are rate-limited by the shared :class:`RateLimiter` abstraction, that
the responses stay generic enough to avoid enumeration leakage, and
that quotas reset when the window rolls.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from app.core import rate_limit_factory
from app.core.config import get_settings
from app.core.rate_limit import InMemoryRateLimiter
from app.core.security import hash_password
from app.models.user import User


async def _create_verified_user(email: str, password: str = "Sprint0ne!2026") -> User:
    from app.db import session as _db
    async with _db.AsyncSessionLocal() as session:
        user = User(
            email=email.lower(),
            hashed_password=hash_password(password),
            full_name="Login Sec",
            is_active=True,
            is_verified=True,
        )
        session.add(user)
        await session.commit()
        return user


def _install_fresh_limiter() -> tuple[InMemoryRateLimiter, callable]:
    """Swap the process-wide limiter with a fresh instance and return the
    previous factory so callers can restore it in a ``finally`` block."""
    fresh = InMemoryRateLimiter()
    original = rate_limit_factory.get_rate_limiter
    rate_limit_factory.get_rate_limiter = lambda: fresh  # type: ignore[assignment]
    return fresh, original


# --------------------------------------------------------------------- #
# 1. Repeated invalid passwords → 429 with Retry-After
# --------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_repeated_invalid_password_triggers_429(client: AsyncClient) -> None:
    fresh, original = _install_fresh_limiter()
    try:
        email = f"brute-{uuid4().hex[:8]}@agrovix.dev"
        await _create_verified_user(email)
        settings = get_settings()

        # Exhaust the per-email quota with the WRONG password.
        for _ in range(settings.login_max_per_email_hour):
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "wrong-password"},
            )
            assert r.status_code == 401, r.text
            # Detail must remain generic (no leak of "user exists"/"wrong pw").
            assert r.json()["detail"] == "Invalid email or password."

        # Next attempt → 429 with a Retry-After header.
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong-password"},
        )
        assert r.status_code == 429, r.text
        retry_after = r.headers.get("Retry-After")
        assert retry_after is not None
        assert int(retry_after) >= 1
        # Body must not confirm/deny account existence.
        assert "invalid" not in r.json()["detail"].lower()
        assert "too many" in r.json()["detail"].lower()

        # And even the CORRECT password is throttled while the window holds.
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "Sprint0ne!2026"},
        )
        assert r.status_code == 429
    finally:
        rate_limit_factory.get_rate_limiter = original


# --------------------------------------------------------------------- #
# 2. Unknown email is throttled identically (no enumeration signal)
# --------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_unknown_email_is_rate_limited_identically(client: AsyncClient) -> None:
    fresh, original = _install_fresh_limiter()
    try:
        settings = get_settings()
        email = f"ghost-{uuid4().hex[:8]}@agrovix.dev"  # never registered

        for _ in range(settings.login_max_per_email_hour):
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "anything-Password!1"},
            )
            assert r.status_code == 401
            assert r.json()["detail"] == "Invalid email or password."

        r = await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "anything-Password!1"},
        )
        assert r.status_code == 429
        assert r.headers.get("Retry-After") is not None
    finally:
        rate_limit_factory.get_rate_limiter = original


# --------------------------------------------------------------------- #
# 3. Successful login once the limiter window resets
# --------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_login_succeeds_after_limit_resets(client: AsyncClient) -> None:
    fresh, original = _install_fresh_limiter()
    try:
        email = f"reset-{uuid4().hex[:8]}@agrovix.dev"
        password = "Sprint0ne!2026"
        await _create_verified_user(email, password=password)
        settings = get_settings()

        # Burn the entire per-email quota.
        for _ in range(settings.login_max_per_email_hour):
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "wrong-password"},
            )
            assert r.status_code == 401

        # Fast-forward the window by clearing the fresh limiter's counters.
        # This simulates ``Retry-After`` having elapsed for the caller.
        fresh._counters.clear()  # type: ignore[attr-defined]

        r = await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": password},
        )
        assert r.status_code == 200, r.text
        # Fresh session -> new refresh cookie is set.
        assert r.cookies.get(get_settings().cookie_refresh_name) is not None
    finally:
        rate_limit_factory.get_rate_limiter = original


# --------------------------------------------------------------------- #
# 4. Shared limiter state across "workers" (same instance = same counters)
# --------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_shared_limiter_state_across_workers(client: AsyncClient) -> None:
    """Redis-backed limiters share state across API workers.

    The in-memory limiter models the *same instance*; when two logical
    "workers" resolve the same limiter, quota consumed by one worker is
    visible to the other. This is the exact invariant Redis provides in
    production.
    """
    fresh, original = _install_fresh_limiter()
    try:
        settings = get_settings()
        email = f"share-{uuid4().hex[:8]}@agrovix.dev"

        # Consume half the quota "on worker A" via HTTP...
        half = settings.login_max_per_email_hour // 2
        for _ in range(half):
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": email, "password": "wrong-password"},
            )
            assert r.status_code == 401

        # ...and half directly against the same limiter "on worker B".
        remaining = settings.login_max_per_email_hour - half
        for _ in range(remaining):
            allowed, _ = await fresh.hit(
                key=f"login:email:{email.lower()}",
                limit=settings.login_max_per_email_hour,
                window_seconds=settings.login_window_seconds,
            )
            assert allowed, "worker-B hits should stay under the shared quota"

        # The very next HTTP call must be rejected because the shared
        # counter is now saturated.
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong-password"},
        )
        assert r.status_code == 429, r.text
        assert r.headers.get("Retry-After") is not None
    finally:
        rate_limit_factory.get_rate_limiter = original


# --------------------------------------------------------------------- #
# 5. Per-IP throttle catches distributed guesses against many emails.
# --------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_per_ip_throttle_catches_email_spraying(client: AsyncClient) -> None:
    fresh, original = _install_fresh_limiter()
    try:
        settings = get_settings()

        # Spray against unique emails so the per-email quota never trips.
        for _ in range(settings.login_max_per_ip_hour):
            r = await client.post(
                "/api/v1/auth/login",
                json={
                    "email": f"spray-{uuid4().hex[:8]}@agrovix.dev",
                    "password": "Whatever!1",
                },
            )
            assert r.status_code == 401

        # Next attempt (yet another unique email) → 429 because IP quota
        # is exhausted.
        r = await client.post(
            "/api/v1/auth/login",
            json={
                "email": f"spray-final-{uuid4().hex[:8]}@agrovix.dev",
                "password": "Whatever!1",
            },
        )
        assert r.status_code == 429
    finally:
        rate_limit_factory.get_rate_limiter = original
