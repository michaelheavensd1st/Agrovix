"""Rate-limiter factory / DI helper."""

from __future__ import annotations

from functools import lru_cache

import redis.asyncio as redis

from app.core.config import get_settings
from app.core.rate_limit import InMemoryRateLimiter, RateLimiter, RedisRateLimiter


@lru_cache(maxsize=1)
def get_rate_limiter() -> RateLimiter:
    """Return a process-wide :class:`RateLimiter`.

    Prefers Redis when :envvar:`REDIS_URL` is configured and reachable at
    startup; otherwise falls back to the in-memory implementation. The
    fallback keeps unit tests hermetic and lets ``python -m app.main``
    boot without Redis running locally.
    """
    settings = get_settings()
    if not settings.redis_url:
        return InMemoryRateLimiter()
    try:
        client = redis.from_url(settings.redis_url, decode_responses=True)
    except Exception:  # noqa: BLE001
        return InMemoryRateLimiter()
    return RedisRateLimiter(client)
