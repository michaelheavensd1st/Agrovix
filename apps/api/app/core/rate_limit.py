"""Rate-limiting primitives.

Provides a stable :class:`RateLimiter` protocol and two implementations:

* :class:`RedisRateLimiter`  — Redis-backed, safe across multiple API
  workers. Uses a per-key ``INCR + EXPIRE`` window.
* :class:`InMemoryRateLimiter` — fallback used when Redis is unavailable
  (development, unit tests). Not safe across processes.

Business code depends only on the protocol.
"""

from __future__ import annotations

import asyncio
import time
from typing import Protocol

import redis.asyncio as redis


class RateLimiter(Protocol):
    async def hit(self, key: str, *, limit: int, window_seconds: int) -> tuple[bool, int]:
        """Register a hit for ``key`` and return ``(allowed, retry_after_seconds)``.

        * ``allowed`` — ``True`` when the caller is under the limit.
        * ``retry_after_seconds`` — hint for a ``Retry-After`` header on
          rejection (``0`` when allowed).
        """
        ...


# --------------------------------------------------------------------- #
# In-memory
# --------------------------------------------------------------------- #
class InMemoryRateLimiter:
    """Per-process rate limiter. Suitable for tests and single-worker dev."""

    def __init__(self) -> None:
        self._counters: dict[str, tuple[int, float]] = {}
        self._lock = asyncio.Lock()

    async def hit(self, key: str, *, limit: int, window_seconds: int) -> tuple[bool, int]:
        now = time.monotonic()
        async with self._lock:
            count, reset_at = self._counters.get(key, (0, now + window_seconds))
            if now >= reset_at:
                count, reset_at = 0, now + window_seconds
            count += 1
            self._counters[key] = (count, reset_at)
            if count > limit:
                return False, max(int(reset_at - now), 1)
            return True, 0


# --------------------------------------------------------------------- #
# Redis
# --------------------------------------------------------------------- #
class RedisRateLimiter:
    def __init__(self, client: redis.Redis, *, prefix: str = "agrovix:rl") -> None:
        self._client = client
        self._prefix = prefix

    async def hit(self, key: str, *, limit: int, window_seconds: int) -> tuple[bool, int]:
        full_key = f"{self._prefix}:{key}"
        pipe = self._client.pipeline()
        pipe.incr(full_key, 1)
        pipe.ttl(full_key)
        count, ttl = await pipe.execute()
        if int(count) == 1 or int(ttl) < 0:
            await self._client.expire(full_key, window_seconds)
            ttl = window_seconds
        if int(count) > limit:
            return False, max(int(ttl), 1)
        return True, 0
