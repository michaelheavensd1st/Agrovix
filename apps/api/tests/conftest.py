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
import os
import sys

# Deterministic + safe defaults BEFORE any app imports.
os.environ["JWT_SECRET_KEY"] = "unit-test-secret"
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["COOKIE_SAMESITE"] = "lax"
os.environ["ALLOW_UNVERIFIED_LOGIN"] = "true"  # verify flow tested explicitly
os.environ["EMAIL_PROVIDER"] = "log"
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["DATABASE_URL_SYNC"] = "sqlite:///:memory:"

import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import event  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

# Reset cached settings so env overrides take effect.
from app.core.config import get_settings  # noqa: E402
get_settings.cache_clear()

# Force the process-wide rate limiter to be in-memory during tests —
# Redis is not available in the hermetic suite.
from app.core.rate_limit import InMemoryRateLimiter  # noqa: E402
from app.core import rate_limit_factory  # noqa: E402
rate_limit_factory.get_rate_limiter.cache_clear()
_test_rate_limiter = InMemoryRateLimiter()
rate_limit_factory.get_rate_limiter = lambda: _test_rate_limiter  # type: ignore[assignment]

# Patch the JSONB column used in AuditEvent → JSON on SQLite.
from sqlalchemy import JSON  # noqa: E402
from sqlalchemy.dialects.postgresql import JSONB  # noqa: E402
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
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )

    # Enable FK enforcement for SQLite (off by default).
    @event.listens_for(engine.sync_engine, "connect")
    def _fk_pragma_on_connect(dbapi_conn, _):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
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
