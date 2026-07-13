"""Trusted-proxy aware client-IP resolution.

Never blindly trust ``X-Forwarded-For`` — a client can set that header
directly and forge any IP they want, which would poison our rate
limits, audit trail and IP-scoped security checks. The safe policy is:

1. If **no** trusted proxies are configured, return the direct socket
   peer address (``request.client.host``) and completely ignore the
   ``X-Forwarded-For`` header. This is the correct default when the
   API is exposed directly (dev, non-HA, sidecars).

2. If trusted proxies **are** configured (comma-separated IPs or CIDR
   ranges via ``TRUSTED_PROXIES``), the header is consulted **only
   when the request's peer address itself is inside the trusted set**
   — i.e. we know it just came from our own reverse proxy. Otherwise
   the header is ignored.

3. When trusted, the header is parsed right-to-left, skipping any
   address that is itself in the trusted-proxy set. The first
   untrusted address (the one your CDN or LB inserted) is treated as
   the true client. If none of the addresses are untrusted, we fall
   back to the socket address.

Configuration:
* ``TRUSTED_PROXIES`` — comma-separated IPv4/IPv6 addresses or CIDRs
  (e.g. ``10.0.0.0/8,127.0.0.1``). Empty (default) disables header
  parsing entirely.
* ``TRUSTED_PROXY_HEADER`` — header to read (default
  ``x-forwarded-for``). Also accepts non-standard values such as
  ``true-client-ip`` or ``x-real-ip`` — but ``X-Real-IP`` is always
  a single address, so parsing degrades gracefully.

Production deployment guidance (see ``docs/deployment.md``):

* Terminate TLS on a reverse proxy (nginx, Envoy, CloudFront, ALB).
* Configure that proxy to set ``X-Forwarded-For`` with the client's IP
  and append its own address as it forwards.
* Set ``TRUSTED_PROXIES`` on the API to the subnet(s) that the proxy
  connects from — typically the internal pod/VPC CIDR.
* NEVER set ``TRUSTED_PROXIES`` to ``0.0.0.0/0`` — that opens
  IP-spoofing to anyone.
"""

from __future__ import annotations

import ipaddress
import logging
from dataclasses import dataclass
from functools import lru_cache

from starlette.requests import Request

from app.core.config import Settings, get_settings

logger = logging.getLogger("app.trusted_proxy")


@dataclass(frozen=True)
class TrustedProxyPolicy:
    """Parsed representation of the ``TRUSTED_PROXIES`` setting."""

    networks: tuple[ipaddress._BaseNetwork, ...]
    header: str

    def contains(self, ip: str) -> bool:
        if not ip:
            return False
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(addr in net for net in self.networks)


def _parse_networks(spec: str) -> tuple[ipaddress._BaseNetwork, ...]:
    nets: list[ipaddress._BaseNetwork] = []
    for chunk in spec.split(","):
        entry = chunk.strip()
        if not entry:
            continue
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            logger.warning(
                "trusted_proxy.invalid_entry",
                extra={"entry": entry, "action": "ignored"},
            )
    return tuple(nets)


@lru_cache(maxsize=1)
def _cached_policy_for(spec: str, header: str) -> TrustedProxyPolicy:
    return TrustedProxyPolicy(networks=_parse_networks(spec), header=header.lower())


def get_trusted_proxy_policy(settings: Settings | None = None) -> TrustedProxyPolicy:
    settings = settings or get_settings()
    return _cached_policy_for(settings.trusted_proxies, settings.trusted_proxy_header)


def _peer_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def get_client_ip(request: Request, *, settings: Settings | None = None) -> str | None:
    """Return the caller's true client IP.

    See module docstring for the full policy. In short: the socket peer
    is the source of truth unless the request came from a
    ``TRUSTED_PROXIES`` address, in which case the configured
    forwarding header is parsed right-to-left.
    """
    settings = settings or get_settings()
    policy = get_trusted_proxy_policy(settings)
    peer = _peer_ip(request)

    if not policy.networks:
        # No trusted-proxy allow-list → NEVER trust the header.
        return peer

    if peer is None or not policy.contains(peer):
        # Request did not come through our trusted edge → header is
        # attacker-controlled and MUST be ignored.
        return peer

    # Peer is a trusted proxy → walk the forwarding chain.
    raw = request.headers.get(policy.header)
    if not raw:
        return peer

    for candidate in reversed([token.strip() for token in raw.split(",") if token.strip()]):
        # Strip brackets that some clients wrap IPv6 addresses in.
        candidate = candidate.strip("[]")
        # Optional ``ip:port`` suffix — take the address portion.
        if candidate.count(":") == 1 and "." in candidate:
            candidate = candidate.split(":", 1)[0]
        if policy.contains(candidate):
            # This hop is another trusted proxy — keep peeling.
            continue
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            # Malformed entry — abandon header parsing safely.
            return peer
        return candidate

    # Every entry in the chain was itself a trusted proxy.
    return peer


__all__ = ["TrustedProxyPolicy", "get_client_ip", "get_trusted_proxy_policy"]
