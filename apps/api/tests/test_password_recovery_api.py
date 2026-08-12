"""Focused API and transactional tests for Sprint 5.2 recovery."""

from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.api.v1.endpoints import auth as auth_endpoints
from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.deps import get_email_sender_dep, get_rate_limiter_dep
from app.email.base import EmailMessage, EmailSender
from app.main import app
from app.models.audit import AuditEvent
from app.models.password_recovery import PasswordRecoveryToken
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.repositories.password_recovery import PasswordRecoveryTokenRepository
from app.repositories.user_repo import UserRepository
from app.services.password_recovery import PasswordRecoveryKernel

pytestmark = pytest.mark.asyncio


class RecordingSender(EmailSender):
    def __init__(self, *, fail: bool = False, gate: bool = False) -> None:
        self.messages: list[EmailMessage] = []
        self.fail = fail
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        if not gate:
            self.release.set()

    async def send(self, message: EmailMessage) -> None:
        self.messages.append(message)
        self.entered.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("injected delivery failure")


class RecordingLimiter:
    def __init__(self, *, blocked_ip: str | None = None, retry_after: int = 60) -> None:
        self.blocked_ip = blocked_ip
        self.retry_after = retry_after
        self.keys: list[str] = []
        self.counts: dict[str, int] = {}

    async def hit(self, *, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        self.keys.append(key)
        if self.blocked_ip is not None and key == f"password-recovery:ip:{self.blocked_ip}":
            return False, self.retry_after
        self.counts[key] = self.counts.get(key, 0) + 1
        return True, 0


async def _drain_recovery_deliveries() -> None:
    tasks = tuple(auth_endpoints._recovery_delivery_tasks)
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=3)


async def _create_user(password: str = "Original-Password!2026") -> User:
    from app.db import session as db

    async with db.AsyncSessionLocal() as session:
        user = User(
            email=f"recovery-api-{uuid4().hex}@example.com",
            hashed_password=hash_password(password),
            is_active=True,
            is_verified=True,
        )
        session.add(user)
        await session.commit()
        return user


async def _issue(user_id):
    from app.db import session as db

    async with db.AsyncSessionLocal() as session:
        result = await PasswordRecoveryKernel(
            user_repo=UserRepository(session),
            token_repo=PasswordRecoveryTokenRepository(session),
        ).issue(user_id=user_id)
        assert result is not None
        raw, row = result
        await session.commit()
        return raw, row.id


async def test_request_is_enumeration_safe_and_dispatches_after_persistence(
    client: AsyncClient,
) -> None:
    user = await _create_user()
    sender = RecordingSender()
    app.dependency_overrides[get_email_sender_dep] = lambda: sender

    known = await client.post(
        "/api/v1/auth/recovery/request", json={"email": f"  {user.email.upper()}  "}
    )
    unknown = await client.post(
        "/api/v1/auth/recovery/request",
        json={"email": f"missing-{uuid4().hex}@example.com"},
    )
    await _drain_recovery_deliveries()

    assert known.status_code == unknown.status_code == 202, (known.text, unknown.text)
    assert known.json() == unknown.json()
    assert len(sender.messages) == 1
    assert sender.messages[0].template == "auth.password_recovery"
    assert "token=" in sender.messages[0].text_body

    from app.db import session as db

    async with db.AsyncSessionLocal() as session:
        token = await session.scalar(
            select(PasswordRecoveryToken).where(PasswordRecoveryToken.user_id == user.id)
        )
        audit = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.entity_id == str(user.id),
                AuditEvent.action == "auth.recovery.request",
            )
        )
        assert token is not None
        assert audit is not None
        assert token.token_hash not in sender.messages[0].text_body


async def test_request_delivery_failure_is_generic_and_issuance_remains_committed(
    client: AsyncClient, caplog
) -> None:
    user = await _create_user()
    sender = RecordingSender(fail=True)
    app.dependency_overrides[get_email_sender_dep] = lambda: sender

    with caplog.at_level(logging.WARNING):
        response = await client.post("/api/v1/auth/recovery/request", json={"email": user.email})
        await _drain_recovery_deliveries()

    assert response.status_code == 202, response.text
    assert sender.messages
    assert user.email not in caplog.text
    assert sender.messages[0].text_body not in caplog.text
    assert sender.messages[0].context["reset_url"] not in caplog.text
    from app.db import session as db

    async with db.AsyncSessionLocal() as session:
        assert (
            await session.scalar(
                select(PasswordRecoveryToken).where(PasswordRecoveryToken.user_id == user.id)
            )
            is not None
        )


async def test_eligible_response_does_not_wait_for_provider_and_matches_ineligible(
    client: AsyncClient,
) -> None:
    user = await _create_user()
    sender = RecordingSender(gate=True)
    app.dependency_overrides[get_email_sender_dep] = lambda: sender

    eligible_task = asyncio.create_task(
        client.post("/api/v1/auth/recovery/request", json={"email": user.email})
    )
    await asyncio.wait_for(sender.entered.wait(), timeout=3)
    eligible = await asyncio.wait_for(eligible_task, timeout=3)
    assert not sender.release.is_set()

    ineligible = await client.post(
        "/api/v1/auth/recovery/request",
        json={"email": f"missing-{uuid4().hex}@example.com"},
    )
    assert eligible.status_code == ineligible.status_code == 202
    assert eligible.json() == ineligible.json()

    sender.release.set()
    await _drain_recovery_deliveries()


async def test_ip_limiter_precedes_email_and_blocked_ip_does_not_charge_victim(
    client: AsyncClient,
) -> None:
    blocked_ip = "127.0.0.1"
    victim = f"victim-{uuid4().hex}@example.com"
    limiter = RecordingLimiter(blocked_ip=blocked_ip, retry_after=10**9)
    app.dependency_overrides[get_rate_limiter_dep] = lambda: limiter

    blocked = await client.post("/api/v1/auth/recovery/request", json={"email": victim})

    ip_key = f"password-recovery:ip:{blocked_ip}"
    email_key = f"password-recovery:email:{victim}"
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "Too many recovery requests. Please try again later."}
    assert (
        int(blocked.headers["retry-after"])
        == get_settings().password_recovery_request_window_seconds
    )
    assert limiter.keys == [ip_key]
    assert limiter.counts.get(email_key, 0) == 0


async def test_accepted_request_consumes_ip_then_email_before_lookup(client: AsyncClient) -> None:
    email = f"accepted-{uuid4().hex}@example.com"
    limiter = RecordingLimiter()
    app.dependency_overrides[get_rate_limiter_dep] = lambda: limiter

    response = await client.post("/api/v1/auth/recovery/request", json={"email": email})

    assert response.status_code == 202
    assert limiter.keys == [
        "password-recovery:ip:127.0.0.1",
        f"password-recovery:email:{email}",
    ]


async def test_request_rate_limits_email_and_sets_retry_after(client: AsyncClient) -> None:
    email = f"rate-{uuid4().hex}@example.com"
    for _ in range(get_settings().password_recovery_request_max_per_email_hour):
        assert (
            await client.post("/api/v1/auth/recovery/request", json={"email": email})
        ).status_code == 202

    blocked = await client.post("/api/v1/auth/recovery/request", json={"email": email.upper()})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1


async def test_request_rate_limits_trusted_ip_across_distinct_emails(client: AsyncClient) -> None:
    limit = get_settings().password_recovery_request_max_per_ip_hour
    for _ in range(limit):
        response = await client.post(
            "/api/v1/auth/recovery/request",
            json={"email": f"ip-rate-{uuid4().hex}@example.com"},
        )
        assert response.status_code == 202
    blocked = await client.post(
        "/api/v1/auth/recovery/request",
        json={"email": f"ip-rate-{uuid4().hex}@example.com"},
    )
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1


async def test_reset_changes_password_consumes_token_revokes_sessions_and_audits(
    client: AsyncClient,
) -> None:
    old_password = "Original-Password!2026"
    new_password = "Replacement-Password!2026"
    user = await _create_user(old_password)
    login = await client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": old_password}
    )
    assert login.status_code == 200, login.text
    raw_token, token_id = await _issue(user.id)

    response = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": raw_token, "new_password": new_password},
    )

    assert response.status_code == 200, response.text
    set_cookie = response.headers.get_list("set-cookie")
    assert any(
        get_settings().cookie_access_name in value and "Max-Age=0" in value for value in set_cookie
    )
    assert any(
        get_settings().cookie_refresh_name in value and "Max-Age=0" in value for value in set_cookie
    )

    from app.db import session as db

    async with db.AsyncSessionLocal() as session:
        persisted_user = await session.get(User, user.id)
        token = await session.get(PasswordRecoveryToken, token_id)
        refresh_rows = list(
            (await session.execute(select(RefreshToken).where(RefreshToken.user_id == user.id)))
            .scalars()
            .all()
        )
        actions = set(
            (
                await session.execute(
                    select(AuditEvent.action).where(AuditEvent.entity_id == str(user.id))
                )
            )
            .scalars()
            .all()
        )
        assert persisted_user is not None
        assert verify_password(new_password, persisted_user.hashed_password)
        assert token is not None and token.consumed_at is not None
        assert refresh_rows and all(row.is_revoked for row in refresh_rows)
        assert {
            "auth.recovery.complete",
            "auth.password.change",
            "auth.sessions.revoke",
        }.issubset(actions)


async def test_reset_rejects_replay_and_password_reuse(client: AsyncClient) -> None:
    password = "Original-Password!2026"
    user = await _create_user(password)
    reused_token, _ = await _issue(user.id)
    reuse = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": reused_token, "new_password": password},
    )
    assert reuse.status_code == 422

    response = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": reused_token, "new_password": "Replacement-Password!2026"},
    )
    assert response.status_code == 200
    replay = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": reused_token, "new_password": "Third-Password!2026"},
    )
    assert replay.status_code == 400
    assert replay.json()["detail"] == "Invalid or expired recovery token."


async def test_reset_failure_envelope_is_bounded(client: AsyncClient) -> None:
    malformed = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": "short", "new_password": "Replacement-Password!2026"},
    )
    unknown = await client.post(
        "/api/v1/auth/recovery/reset",
        json={"token": "x" * 43, "new_password": "Replacement-Password!2026"},
    )
    assert malformed.status_code == 422
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "Invalid or expired recovery token."
