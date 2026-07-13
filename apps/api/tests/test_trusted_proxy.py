"""Trusted-proxy / X-Forwarded-For handling tests.

Verifies that:
* When ``TRUSTED_PROXIES`` is empty (default), ``X-Forwarded-For`` is
  IGNORED — the socket peer is authoritative.
* When ``TRUSTED_PROXIES`` is set, only requests from those addresses
  can influence the resolved client IP.
* Requests from an untrusted peer that spoof ``X-Forwarded-For`` fall
  back to the peer address (spoof is ineffective).
* Multi-hop chains skip additional trusted-proxy hops.

The client-IP resolution lives in :mod:`app.core.trusted_proxy`; these
tests exercise it via a lightweight Starlette ``Request`` stub so we do
not have to spin up a proxy chain.
"""

from __future__ import annotations

import pytest
from starlette.requests import Request

from app.core.config import Settings, get_settings
from app.core import trusted_proxy


def _make_request(*, peer: str, headers: dict[str, str] | None = None) -> Request:
    """Build a minimal ASGI scope so ``Request(scope)`` behaves like a
    real inbound request (client tuple + headers)."""
    hdrs = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": hdrs,
        "client": (peer, 12345),
        "query_string": b"",
        "raw_path": b"/",
    }
    return Request(scope)


def _settings_with(trusted: str) -> Settings:
    # Bypass BaseSettings caching so tests can flip the policy freely.
    get_settings.cache_clear()
    s = get_settings()
    return s.model_copy(update={"trusted_proxies": trusted})


def _reset_policy_cache() -> None:
    # Clear the lru_cache inside trusted_proxy so each test sees a fresh
    # ``TrustedProxyPolicy``.
    trusted_proxy._cached_policy_for.cache_clear()  # type: ignore[attr-defined]


def test_ignores_xff_when_no_trusted_proxies_configured() -> None:
    _reset_policy_cache()
    s = _settings_with("")
    req = _make_request(
        peer="203.0.113.7",
        headers={"X-Forwarded-For": "1.2.3.4"},  # spoofed by client
    )
    assert trusted_proxy.get_client_ip(req, settings=s) == "203.0.113.7"


def test_untrusted_peer_cannot_spoof_via_xff() -> None:
    _reset_policy_cache()
    s = _settings_with("10.0.0.0/8")  # only trust our internal 10/8 proxy
    req = _make_request(
        peer="203.0.113.7",  # public IP; NOT in trusted range
        headers={"X-Forwarded-For": "1.2.3.4, 10.0.0.5"},
    )
    # Header is ignored because the peer isn't a trusted proxy.
    assert trusted_proxy.get_client_ip(req, settings=s) == "203.0.113.7"


def test_trusted_proxy_reveals_true_client_ip() -> None:
    _reset_policy_cache()
    s = _settings_with("10.0.0.0/8")
    req = _make_request(
        peer="10.0.0.5",
        headers={"X-Forwarded-For": "198.51.100.42"},
    )
    assert trusted_proxy.get_client_ip(req, settings=s) == "198.51.100.42"


def test_multi_hop_trusted_chain_is_peeled_back() -> None:
    _reset_policy_cache()
    # Trust the LB tier (10/8) and the CDN tier (172.16/12).
    s = _settings_with("10.0.0.0/8, 172.16.0.0/12")
    req = _make_request(
        peer="10.0.0.5",  # our nginx
        headers={"X-Forwarded-For": "198.51.100.42, 172.16.7.7, 10.0.0.5"},
    )
    # Walk right-to-left: 10.0.0.5 trusted → skip, 172.16.7.7 trusted → skip,
    # 198.51.100.42 untrusted → that is the client.
    assert trusted_proxy.get_client_ip(req, settings=s) == "198.51.100.42"


def test_all_hops_trusted_falls_back_to_peer() -> None:
    _reset_policy_cache()
    s = _settings_with("10.0.0.0/8")
    req = _make_request(
        peer="10.0.0.5",
        headers={"X-Forwarded-For": "10.0.0.6, 10.0.0.7"},
    )
    # Every hop was internal; fall back to the socket peer so we never
    # accidentally return an internal address as "client".
    assert trusted_proxy.get_client_ip(req, settings=s) == "10.0.0.5"


def test_missing_header_falls_back_to_peer_when_trusted() -> None:
    _reset_policy_cache()
    s = _settings_with("10.0.0.0/8")
    req = _make_request(peer="10.0.0.5")  # no XFF
    assert trusted_proxy.get_client_ip(req, settings=s) == "10.0.0.5"


def test_malformed_xff_falls_back_safely() -> None:
    _reset_policy_cache()
    s = _settings_with("10.0.0.0/8")
    req = _make_request(
        peer="10.0.0.5",
        headers={"X-Forwarded-For": "not-an-ip, definitely-not"},
    )
    assert trusted_proxy.get_client_ip(req, settings=s) == "10.0.0.5"


def test_invalid_trusted_proxy_entries_are_ignored_not_fatal() -> None:
    _reset_policy_cache()
    s = _settings_with("garbage, 10.0.0.0/8, also-bad")
    req = _make_request(
        peer="10.0.0.5",
        headers={"X-Forwarded-For": "198.51.100.42"},
    )
    # The valid entry (10/8) still trusts our proxy → client is revealed.
    assert trusted_proxy.get_client_ip(req, settings=s) == "198.51.100.42"


@pytest.mark.asyncio
async def test_login_uses_trusted_client_ip_end_to_end(client) -> None:
    """Integration: the login endpoint should key its rate limiter with the
    resolved client IP, not the raw socket peer, when trusted proxies are
    configured. We simulate a spoofed XFF from an untrusted peer and
    confirm the limiter treats the SPOOFED IP as ineffective — the same
    rate-limit bucket is applied per socket peer.
    """
    from uuid import uuid4
    from app.core import rate_limit_factory
    from app.core.rate_limit import InMemoryRateLimiter

    fresh = InMemoryRateLimiter()
    original = rate_limit_factory.get_rate_limiter
    rate_limit_factory.get_rate_limiter = lambda: fresh  # type: ignore[assignment]
    try:
        settings = get_settings()
        # Spray against UNIQUE emails so the per-email quota (10) never
        # fires; if the header were trusted, each iteration would key on
        # a different "9.9.9.i" IP and none of them would be throttled.
        # Because the header is ignored (no trusted proxies configured),
        # every hit lands on the same real-socket bucket and the per-IP
        # quota (30/hr) kicks in on the 31st call.
        for i in range(settings.login_max_per_ip_hour):
            r = await client.post(
                "/api/v1/auth/login",
                json={"email": f"proxy-{uuid4().hex[:6]}-{i}@agrovix.dev", "password": "wrong"},
                headers={"X-Forwarded-For": f"9.9.9.{i % 250 + 1}"},
            )
            assert r.status_code == 401, (i, r.status_code, r.text)
        r = await client.post(
            "/api/v1/auth/login",
            json={"email": f"proxy-final-{uuid4().hex[:6]}@agrovix.dev", "password": "wrong"},
            headers={"X-Forwarded-For": "9.9.9.99"},
        )
        assert r.status_code == 429, r.text
    finally:
        rate_limit_factory.get_rate_limiter = original
