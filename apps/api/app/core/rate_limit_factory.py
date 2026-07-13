"""Rate-limiter factory / DI helper.

Selects the process-wide :class:`RateLimiter` implementation based on
environment. The default preference order is:

1. **Redis** — when ``REDIS_URL`` is configured. Required in production so
   that limits are shared across API workers.
2. **In-memory** — used only when explicitly allowed (dev, tests, or by
   opting-in with ``RATE_LIMIT_ALLOW_INMEMORY=true``).

In production, if Redis is required but the URL is missing (or the client
cannot even be constructed), the factory raises
:class:`RateLimiterUnavailableError` so that startup fails fast rather
than silently degrading to a per-process limiter — that would be a
security regression.

Reachability of Redis (an actual ``PING``) is verified separately by
:func:`check_rate_limiter_health`, which the ``/health`` endpoint calls
during startup and liveness probes.
"""

from __future__ import annotations

import logging
from functools import lru_cache

import redis.asyncio as redis

from app.core.config import get_settings
from app.core.rate_limit import InMemoryRateLimiter, RateLimiter, RedisRateLimiter

logger = logging.getLogger("app.rate_limit")


class RateLimiterUnavailableError(RuntimeError):
    """Raised when a required rate-limiter backend is not available."""


@lru_cache(maxsize=1)
def get_rate_limiter() -> RateLimiter:
    """Return the process-wide :class:`RateLimiter`.

    Behaviour:

    * ``REDIS_URL`` set and the async client is constructable →
      :class:`RedisRateLimiter`.
    * ``REDIS_URL`` unset **and** production **and** in-memory not
      explicitly allowed → :class:`RateLimiterUnavailableError`.
    * Otherwise → :class:`InMemoryRateLimiter` (dev, tests, or explicit
      opt-in via ``RATE_LIMIT_ALLOW_INMEMORY``).

    Client reachability (``PING``) is validated separately by
    :func:`check_rate_limiter_health` so that the DI factory stays
    synchronous and does not perform network I/O.
    """
    settings = get_settings()

    if not settings.redis_url:
        if settings.is_production and not settings.rate_limit_allow_inmemory:
            raise RateLimiterUnavailableError(
                "REDIS_URL is required for rate limiting in production. "
                "Set RATE_LIMIT_ALLOW_INMEMORY=true to explicitly opt in to "
                "in-memory (single-process) rate limiting.",
            )
        logger.warning(
            "rate_limit.inmemory_fallback",
            extra={"reason": "redis_url_unset", "env": settings.app_env},
        )
        return InMemoryRateLimiter()

    try:
        client = redis.from_url(settings.redis_url, decode_responses=True)
    except Exception as exc:  # noqa: BLE001
        if settings.is_production and not settings.rate_limit_allow_inmemory:
            raise RateLimiterUnavailableError(
                f"Failed to construct Redis client from REDIS_URL: {exc}. "
                "Set RATE_LIMIT_ALLOW_INMEMORY=true to opt into in-memory fallback.",
            ) from exc
        logger.warning(
            "rate_limit.inmemory_fallback",
            extra={"reason": f"redis_construct_failed: {exc}", "env": settings.app_env},
        )
        return InMemoryRateLimiter()

    return RedisRateLimiter(client)


async def check_rate_limiter_health() -> tuple[bool, str]:
    """Ping the underlying limiter backend.

    Returns ``(healthy, backend_label)``. ``in-memory`` limiter is always
    healthy — it lives inside this process.
    """
    settings = get_settings()
    try:
        limiter = get_rate_limiter()
    except RateLimiterUnavailableError as exc:
        return False, f"unavailable: {exc}"

    if isinstance(limiter, InMemoryRateLimiter):
        # In production this means someone opted-in explicitly; surface a
        # non-fatal warning label so probes can flag it if desired.
        if settings.is_production:
            return True, "in-memory (opted-in)"
        return True, "in-memory"

    try:
        pong = await limiter._client.ping()  # type: ignore[attr-defined]
        return bool(pong), "redis"
    except Exception as exc:  # noqa: BLE001
        return False, f"redis-error: {exc}"
