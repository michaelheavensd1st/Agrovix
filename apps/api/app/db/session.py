"""Async SQLAlchemy engine + session factory."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_settings = get_settings()

_engine_kwargs: dict = {
    "echo": _settings.database_echo,
    "pool_pre_ping": True,
    "future": True,
}
# Pool sizing options are meaningless for SQLite (single-threaded) and
# will error out. We keep the async engine sqlite-compatible for local
# test fixtures.
if not _settings.database_url.startswith("sqlite"):
    _engine_kwargs["pool_size"] = _settings.database_pool_size
    _engine_kwargs["max_overflow"] = _settings.database_max_overflow

engine = create_async_engine(_settings.database_url, **_engine_kwargs)

AsyncSessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    class_=AsyncSession,
)


async def get_db_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    await engine.dispose()
