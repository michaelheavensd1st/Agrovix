"""Shared pytest fixtures — SQLite-backed for hermetic unit tests.

The canonical Postgres path is exercised in CI via the `api-quality` job
(see `.github/workflows/ci.yml`). These fixtures keep the local test
loop hermetic and fast — no Postgres or Redis process required.

They use SQLite through SQLAlchemy's Async engine with the
``check_same_thread=False`` pragma; the JSONB column is transparently
mapped to plain JSON, and the Postgres enums degrade to Python enums.
"""

from __future__ import annotations

import asyncio
import contextlib
import os

# Deterministic + safe defaults BEFORE any app imports. External
# environment variables (e.g. from the CI Postgres integration job)
# take precedence — `setdefault` never overwrites an existing value.
os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret")
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("COOKIE_SAMESITE", "lax")
os.environ.setdefault("ALLOW_UNVERIFIED_LOGIN", "true")  # verify flow tested explicitly
os.environ.setdefault("EMAIL_PROVIDER", "log")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("DATABASE_URL_SYNC", "sqlite:///:memory:")

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

# Reset cached settings so env overrides take effect.
from app.core.config import get_settings

get_settings.cache_clear()

# Force the process-wide rate limiter to be in-memory during tests —
# Redis is not available in the hermetic suite.
from app.core import rate_limit_factory  # noqa: E402
from app.core.rate_limit import InMemoryRateLimiter  # noqa: E402

rate_limit_factory.get_rate_limiter.cache_clear()
_test_rate_limiter = InMemoryRateLimiter()
rate_limit_factory.get_rate_limiter = lambda: _test_rate_limiter  # type: ignore[assignment]


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_shared_rate_limiter():
    """Reset the shared in-memory limiter between tests.

    Individual tests that need cumulative rate-limit behavior install
    their own fresh limiter (see ``test_verification.py`` and
    ``test_login_security.py``). This fixture keeps other tests hermetic
    so that ``login``/``refresh``/``logout`` don't burn cross-test quota
    and flake randomly.
    """
    with contextlib.suppress(AttributeError):
        _test_rate_limiter._counters.clear()  # type: ignore[attr-defined]
    yield


# Patch the JSONB column used in AuditEvent → JSON when running against
# SQLite (unit-test default). When DATABASE_URL points at Postgres this
# patch is a no-op so real JSONB behaviour is exercised.
if os.environ["DATABASE_URL"].startswith("sqlite"):
    from sqlalchemy import JSON
    from sqlalchemy.dialects.postgresql import JSONB

    JSONB.impl = JSON  # type: ignore[attr-defined]

from app.db import session as db_session_module  # noqa: E402
from app.deps import get_db_session  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402
from app.seed import seed_permissions_and_roles  # noqa: E402


@pytest_asyncio.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def _engine():
    database_url = os.environ["DATABASE_URL"]
    is_sqlite = database_url.startswith("sqlite")

    engine_kwargs: dict = {"future": True}
    if is_sqlite:
        engine_kwargs["connect_args"] = {"check_same_thread": False}
        engine_kwargs["poolclass"] = StaticPool

    engine = create_async_engine(database_url, **engine_kwargs)

    if is_sqlite:
        # Enable FK enforcement for SQLite (off by default).
        @event.listens_for(engine.sync_engine, "connect")
        def _fk_pragma_on_connect(dbapi_conn, _):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async with engine.begin() as conn:
        if not is_sqlite:
            # Fresh state per test session against the real Postgres.
            await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    # Swap in our engine + session factory
    db_session_module.engine = engine
    db_session_module.AsyncSessionLocal = async_sessionmaker(
        bind=engine, expire_on_commit=False, class_=AsyncSession
    )

    await seed_permissions_and_roles()

    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(_engine) -> AsyncSession:
    async with db_session_module.AsyncSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def client(_engine) -> AsyncClient:
    # Route the app's DB dep through our shared engine.
    async def _override_get_db_session():
        async with db_session_module.AsyncSessionLocal() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db_session] = _override_get_db_session
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
