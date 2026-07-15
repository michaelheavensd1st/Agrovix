"""Shared pytest fixtures — SQLite-backed for hermetic unit tests.

The canonical Postgres path is exercised in CI via the `api-quality` job
(see `.github/workflows/ci.yml`). These fixtures keep the local test
loop hermetic and fast — no Postgres or Redis process required.

They use SQLite through SQLAlchemy's Async engine with the
``check_same_thread=False`` pragma; the JSONB column is transparently
mapped to plain JSON, and the Postgres enums degrade to Python enums.
"""

from __future__ import annotations

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

# --------------------------------------------------------------------- #
# Event-loop management — pytest-asyncio 0.24-compatible.
#
# CI pins pytest-asyncio == 0.24.0 (see requirements-dev.txt).  In 0.24:
#   * ``asyncio_default_fixture_loop_scope`` is supported as an ini
#     option, so session-scoped async **fixtures** share one loop.
#   * ``asyncio_default_test_loop_scope`` DID NOT exist yet — that
#     option only landed in pytest-asyncio 0.26. Setting it in
#     pyproject.toml on 0.24 is either ignored (best case) or errors
#     under ``--strict-config``, leaving async **tests** on
#     per-function loops that don't match the session-scoped
#     ``_engine`` / ``AsyncSessionLocal`` — the exact "Future
#     attached to a different loop" pattern reported by GitHub
#     Actions.
#
# Fix that works on BOTH 0.24 and 1.x:
#   1. Keep ``asyncio_default_fixture_loop_scope = "session"`` in
#      pyproject.toml (works on every version ≥ 0.24).
#   2. Drop ``asyncio_default_test_loop_scope`` from pyproject.toml
#      (it's 0.26+ only and hides the bug locally when installed).
#   3. Register ``pytest.mark.asyncio(loop_scope="session")`` on
#      every collected async test in the ``pytest_collection_modifyitems``
#      hook below — the ``loop_scope`` keyword argument to the
#      ``asyncio`` mark was added in 0.24, so this is the correct
#      0.24-native way to opt every test onto the session loop.
#   4. Add explicit ``loop_scope="session"`` to every
#      ``@pytest_asyncio.fixture`` decorator, so function-scoped
#      fixtures also stay bound to the session loop.
#
# Do NOT re-introduce a custom ``event_loop`` fixture — it's
# deprecated in pytest-asyncio 1.x and reintroduces the same loop
# mismatch we're guarding against.
# --------------------------------------------------------------------- #
import inspect  # noqa: E402

from app.db import session as db_session_module  # noqa: E402
from app.deps import get_db_session  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402
from app.seed import seed_permissions_and_roles  # noqa: E402


def pytest_collection_modifyitems(config, items):
    """Force every async test onto the session-scoped event loop.

    pytest-asyncio 0.24 does NOT ship an ini option for the default
    test loop scope (that was added in 0.26). Applying the mark
    programmatically at collection time is the 0.24-native fix and
    is a no-op on newer pytest-asyncio versions.
    """
    session_loop_marker = pytest.mark.asyncio(loop_scope="session")
    for item in items:
        func = getattr(item, "function", None)
        if func is not None and inspect.iscoroutinefunction(func):
            item.add_marker(session_loop_marker)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
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


@pytest_asyncio.fixture(loop_scope="session")
async def db_session(_engine) -> AsyncSession:
    async with db_session_module.AsyncSessionLocal() as session:
        yield session


@pytest_asyncio.fixture(loop_scope="session")
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
