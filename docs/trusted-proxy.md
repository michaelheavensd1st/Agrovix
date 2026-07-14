# Trusted Proxy / Reverse Proxy Configuration

This document explains the **trusted-proxy policy** applied by the Agrovix
AgOS API to `X-Forwarded-For` (and equivalent forwarding headers). The
policy is required because a naive `X-Forwarded-For` read is a
well-known vector for IP spoofing — the header can be forged by any
HTTP client and, if trusted blindly, will poison the audit trail, rate
limits, and IP-scoped security decisions.

## The policy

1. **No trusted proxies configured** (default) → the API returns the
   direct socket peer address (`request.client.host`) and **ignores
   `X-Forwarded-For` completely**. This is the correct default when
   the API is exposed directly (dev, single-node preview, sidecars).
2. **Trusted proxies configured** → the header is consulted _only when
   the request's peer address itself is inside the trusted set_. That
   is, we only trust the header when we know the request just came out
   of our own reverse proxy tier.
3. **Header parsing** walks the chain right-to-left, skipping every
   address that is itself a trusted-proxy address. The first
   untrusted address is treated as the client. If every hop is
   internal, the peer address is used instead — we never surface an
   internal IP as "the client".

The implementation lives in
[`apps/api/app/core/trusted_proxy.py`](../apps/api/app/core/trusted_proxy.py)
and is applied by:

- `RequestContextMiddleware` for access-log `client_ip`
- `get_request_ctx` for audit trail
- `AuthService.login` / `resend_verification` / `refresh` for
  rate-limiter keys
- `InvitationService.accept` for rate-limiter keys

## Configuration

Two settings drive the behaviour. Both live in
[`app/core/config.py`](../apps/api/app/core/config.py) and are populated
from `.env` / process env.

| Env variable           | Default           | Purpose                                                               |
| ---------------------- | ----------------- | --------------------------------------------------------------------- |
| `TRUSTED_PROXIES`      | _(empty)_         | Comma-separated IPv4/IPv6 addresses or CIDRs. Empty = header IGNORED. |
| `TRUSTED_PROXY_HEADER` | `x-forwarded-for` | Case-insensitive header name the middleware reads.                    |

> **Never** set `TRUSTED_PROXIES=0.0.0.0/0`. That effectively re-enables
> the spoof vector by trusting every possible client.

## Production deployment reference

The reference topology is:

```
client (public) ── HTTPS ──▶ Edge LB / CDN ── HTTPS ──▶ nginx / Envoy ── HTTP ──▶ FastAPI (:8000)
                                                     └─ same VPC / pod network
```

### 1. Terminate TLS on the edge

TLS terminates on the CDN / LB / nginx tier — the FastAPI process
speaks plain HTTP inside the trusted network.

### 2. Preserve the client IP as it hops inward

Each proxy in the chain **appends its own address** to
`X-Forwarded-For`:

```
X-Forwarded-For: <original-client-ip>, <cdn-egress-ip>, <lb-internal-ip>
```

For nginx, this is:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP       $remote_addr;
```

For Envoy, set `use_remote_address: true` and rely on the
`x-forwarded-for` filter.

### 3. Set `TRUSTED_PROXIES` on the API

Set `TRUSTED_PROXIES` on the API pods to the CIDR(s) that its
immediate upstream proxies connect from — usually the internal pod
or VPC network:

```env
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
```

If you have a single L7 load balancer whose egress is fixed, prefer
listing the specific IPs instead of a broad CIDR.

### 4. Validate

After deploy, hit a health endpoint through the proxy and confirm the
access log reports the **public** client IP, not the proxy IP:

```bash
$ curl -H 'X-Forwarded-For: 203.0.113.7' https://api.example.com/health
# In the API access log:
# {"message":"http.request","client_ip":"203.0.113.7", ...}
```

Also confirm a **direct** (proxy-bypassing) request with a spoofed
header reports the raw socket peer:

```bash
$ curl -H 'X-Forwarded-For: 1.2.3.4' http://direct-api.internal/health
# {"message":"http.request","client_ip":"<direct-caller-ip>", ...}
```

If step 4 shows a spoofed IP, `TRUSTED_PROXIES` is too permissive.

## Testing

See [`tests/test_trusted_proxy.py`](../apps/api/tests/test_trusted_proxy.py)
for unit and integration coverage:

- header ignored when no trusted proxies configured
- header ignored when the socket peer is not a trusted proxy
- header parsed and multi-hop chain peeled when the peer is trusted
- all-hops-trusted falls back to socket peer
- missing / malformed headers fall back safely
- login rate limits are NOT bypassable via spoofed XFF
