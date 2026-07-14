"""Deep health / readiness endpoints."""

from __future__ import annotations

from typing import Annotated

import redis.asyncio as redis
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db_session

router = APIRouter()


@router.get("/", summary="Liveness probe (v1)")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready", summary="Deep readiness probe")
async def readiness(
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    """Verify DB + Redis are reachable."""
    settings = get_settings()

    db_ok = False
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    redis_ok = False
    try:
        client = redis.from_url(settings.redis_url)
        pong = await client.ping()
        redis_ok = bool(pong)
        await client.close()
    except Exception:
        redis_ok = False

    ready = db_ok and redis_ok
    return {
        "status": "ready" if ready else "degraded",
        "checks": {"database": db_ok, "redis": redis_ok},
    }
