# PRD — Agrovix AgOS

## Original Problem Statement
Enterprise-grade Agricultural Operating System (aquaculture / fish-hatchery
first). Monorepo: Next.js web + Expo mobile + FastAPI + PostgreSQL + Redis.

## Sprint 0 — Foundation (accepted 2026-02)
Full monorepo scaffolding, JWT auth scaffold, Alembic-managed Postgres,
Turborepo + pnpm, GitHub Actions CI, Docker Compose.

## Sprint 1 — Identity, Tenancy, RBAC (this delta)

### Foundation corrections
- ✅ Replaced React Navigation with **Expo Router** (typed routes, file-based).
- ✅ Web auth = **httpOnly, Secure, SameSite cookies** (never localStorage).
- ✅ Mobile auth = **Expo SecureStore** (Keychain / EncryptedSharedPreferences).
- ✅ Structured **JSON logging** — request_id, user_id, organization_id, endpoint, status_code, duration_ms per request.
- ✅ **OpenTelemetry-ready Tracer interface** (no-op impl; swap-in ready).
- ✅ **Automated tests**: expired access, refresh rotation, revoked refresh, duplicate email, invalid credentials, unauthorized protected route, permission denial, ownership-orphan guard.
- ✅ No default superuser. `python -m app.cli create_admin` (interactive) creates the first platform administrator.
- ✅ CRA/Mongo preview clearly marked. `/app/PREVIEW_SHIM.md` documents policy; production code MongoDB-free (`scripts/verify-no-mongo.sh` in CI).
- ✅ Verified only "Agrovix" (no "Agrova" occurrences).

### Domain models (apps/api)
- User (extended: `is_verified`, `verified_at`, `deleted_at`)
- Role (permission-driven; adds `scope`, `is_system`)
- Permission
- RoleAssignment (user × role × org? × farm?; revocable; unique-per-scope)
- Organization (slug, soft delete, active flag)
- OrganizationMembership (user × org, invited_by, join meta, soft delete)
- Farm (org_id + code unique, soft delete)
- FarmMembership (user × farm, soft delete)
- Invitation (email + hashed token, status enum, expires_at, revoked_at, accepted_at)
- AuditEvent (actor / org / farm / action / entity / ip / ua / request_id / metadata JSON)
- EmailVerificationToken (hashed, single-use, expiring)

### Services (permission-driven)
- AuthService — register, verify_email, resend_verification, login (with cookies), refresh (rotate + revoke), logout
- OrganizationService — create (auto-owner assignment), delete (ownership guard)
- FarmService — create/update/delete (audited)
- InvitationService — create/accept/revoke (scope-aware; audited)
- RoleAssignmentService — assign/revoke (blocks last-owner revoke; audited)

### API endpoints (`/api/v1`)
Auth: register, verify, resend-verification, login, refresh, logout, me
Orgs: create/list/get/patch/delete
Farms: create-under-org, list-in-org, get, patch
Invitations: create, list, accept, revoke
Role assignments: create, revoke
Audit: list-in-org

### Web (apps/web)
- New pages: `/verify`, `/onboarding`, `/organizations/[id]`, `/organizations/[id]/farms/new`, `/organizations/[id]/invitations/new`, `/accept-invite`.
- API client uses `credentials: 'include'`. No token storage in JS.

### Mobile (apps/mobile)
- Expo Router shell: `app/_layout.tsx`, `app/index.tsx`, `app/login.tsx`, `app/register.tsx`, `app/dashboard.tsx`. AuthProvider + SecureStore.

### CI
- Adds `mongo-guard` job (`scripts/verify-no-mongo.sh`).
- Retains lint / type-check / vitest / next-build / ruff / black / pytest / audit.

### Not in Sprint 1 (intentional)
- Field, Crop, Season (aquaculture-first, deferred to Sprint 2).
- `scaffold:feature` code generator (only after patterns survive Sprint 1+).
- Full OpenTelemetry export (interface only).
- Resend / SendGrid production email backends (LogEmailSender ships).

## Sprint 1 hardening (2026-02-06)
- ✅ Postgres partial unique index on `email_verification_tokens (user_id) WHERE is_used = false` (migration `0003_verification_active_unique_index`) — prevents concurrent resends from creating multiple active tokens.
- ✅ Strict production rate-limiter fallback: `get_rate_limiter()` raises `RateLimiterUnavailableError` when Redis is required but missing/unreachable; `/health` reports rate-limiter backend + surfaces 503 if unhealthy in prod without explicit `RATE_LIMIT_ALLOW_INMEMORY` opt-in.
- ✅ Rate limiting on `/api/v1/auth/login` (per-email + per-IP) and `/api/v1/invitations/accept` (per-user + per-IP); responses stay generic to avoid enumeration.
- ✅ New login security suite (`test_login_security.py`): brute force → 429 w/ `Retry-After`, unknown-email parity, window-reset recovery, shared-state across "workers", IP-spraying detection.
- ✅ Terminology corrected: JWTs described as "signed, structured tokens backed by a server-side hashed record" (docstrings + shim comment).
- Test total: **27** (was 22; +5 new login security tests).

## Sprint 1 closeout (2026-02-06 pm)
- ✅ Farm soft delete + restore endpoints (`DELETE /farms/{id}` and `POST /farms/{id}/restore`). Deleted farms are excluded from list + read queries and reject new invitations with 409.
- ✅ Audit-event filtering (`farm_id`, `actor_id`, `action`, `entity_type`, `occurred_from`, `occurred_to`) + deterministic pagination (`created_at DESC, id DESC`) with hard-capped `limit=200`, returning `{items, total, limit, offset}` envelope.
- ✅ Tenant-existence leak plugged: `require_permission()` returns 404 (not 403) when the caller is not a member of the target organization. Applied uniformly to invitations, audit, role-assignments, farms.
- ✅ Concurrent-revoke race hardened: `RoleAssignmentService.revoke` uses a compare-and-swap primitive (`revoke_if_active`) + post-revoke count check that self-heals via `unrevoke` when a two-owner concurrent revoke would have orphaned an org.
- ✅ Trusted-proxy policy: new `TRUSTED_PROXIES` + `TRUSTED_PROXY_HEADER` settings; `app/core/trusted_proxy.py` resolves the true client IP right-to-left; direct socket peer is used when the peer is not a trusted proxy. Documented in `docs/trusted-proxy.md`.
- ✅ Every callsite that used `request.client.host` (login, resend, refresh, invitation accept, request-context middleware, audit log) now goes through `get_client_ip()`.
- ✅ Cross-tenant integration test suite (`test_cross_tenant.py`) covering list, read, update, delete, restore, invitation, audit, role-assignment endpoints — every access from a foreign tenant returns 404.
- ✅ Concurrency tests (`test_concurrency.py`) — asyncio.gather on same-assignment revoke, last-owner double-revoke, farm delete×2, delete/restore race.
- ✅ Trusted-proxy tests (`test_trusted_proxy.py`) — 9 cases covering spoofing, chain peeling, malformed headers, and login-endpoint integration.
- **Test total: 61** (previously 27 → +34).

### Backlog (deferred, NOT built)
- **Security posture panel** (P3, deferred): admin observability page. When implemented, it must use real metrics (Prometheus/Otel counters, structured logs) and operational data — NOT direct DB counts framed as security intelligence.
- **Real Resend backend** (P2, deferred): only when a staging env with a verified sending domain exists. API keys never committed; introduced via `apps/api/.env` per environment.
- **RateLimiter.ping()** protocol method (P2): current implementation uses `_client.ping()` directly. Only worth doing if we add a non-Redis backend that needs its own probe.

## Sprint 2 — Production Engine (2026-02-06 evening)
- ✅ Species-agnostic hierarchy: `Organization → Farm → ProductionSite → ProductionUnit → ProductionBatch → ProductionEvent`.
- ✅ 6 domain models in `app/models/production.py` — Site (rich physical location with lat/lng/timezone/manager/capacity/status), UnitType (system-seeded + org-custom, partial unique on system codes), Unit, Batch (with typed state machine), BatchTransition (append-only history), Event (append-only, JSONB payload, denormalised tenant fields).
- ✅ Alembic migration `0004_production_engine` — Postgres DDL including composite index `(batch_id, performed_at, id)`, 6 per-column indexes on events, partition-ready `performed_at` column.
- ✅ Batch state machine with explicit typed transitions: PLANNED → STOCKED (via STOCKING event only) → ACTIVE → HARVESTED (via HARVEST is_final only) → CLOSED; plus SUSPENDED/CANCELLED/FAILED. Compare-and-swap primitive (`compare_and_set_state`) makes concurrent transitions race-safe (verified: exactly one 200 + one 409). Every transition recorded in `production_batch_transitions` + audit trail. Terminal states reject new events (409). PATCH endpoints strip `state` and lifecycle timestamps as defence-in-depth.
- ✅ Central `ProductionEventCatalog` (`app/production/event_catalog.py`) with 9 registered types (STOCKING, FEEDING, MORTALITY, SAMPLING, WATER_QUALITY, MEDICATION, TRANSFER, HARVEST, INSPECTION). Each has a Pydantic schema with `extra="forbid"`. `GET /api/v1/production-events/catalog` exposes the JSON Schema for frontend form generation.
- ✅ Auto-created "Main Site" on every farm (`is_default=true`, code `MAIN`).
- ✅ Site soft-delete blocked while active units exist (409). Unit soft-delete blocked while active batches exist (409). Both idempotent + auditable.
- ✅ System production unit types seeded idempotently (HATCHERY_TANK, NURSERY_TANK, GROW_OUT_POND, CAGE, RACEWAY, BIOFLOC_TANK); org-custom types allowed via `POST /organizations/{id}/production-unit-types`; system-code shadowing rejected (409); system deletion refused (403).
- ✅ Cursor-paginated event listing with opaque cursors + `(performed_at DESC, id DESC)` ordering.
- ✅ Full cross-tenant isolation for the whole engine — every URL returns 404 to non-members.
- ✅ New permissions (13 codes) distributed to system roles; seeder idempotent.
- ✅ Docs: `/app/docs/production-engine.md` with hierarchy, state-machine diagram, API surface, and deferred work.
- **Test total: 77** (was 61 → +16 for the Production Engine).

## Codex Review Gate 01 — validation gate (2026-02-07)
Pre-Sprint 3 hardening pass on branch `fix/codex-review-gate-01`.
Findings & fixes documented in `docs/audits/codex-review-gate-01.md`.

- ✅ **CRG01-1**: Cross-tenant leak on `GET /production-unit-types` closed. Non-members no longer see foreign org customs; superusers still see all.
- ✅ **CRG01-2**: Production-event idempotency (`Idempotency-Key`). Partial unique index `uq_events_batch_idempotency_key` + SAVEPOINT-wrapped INSERT + payload-hash conflict detection. Replay returns 200 + `X-Idempotent-Replay: true`; same-key/different-payload returns 409 `idempotency_key_payload_conflict`; concurrent-race collapses to exactly one row.
- ✅ **CRG01-3**: New CI job `alembic-upgrade` — spins Postgres 16, upgrades to head, asserts current==heads, then round-trips downgrade base → upgrade head.
- ✅ **CRG01-4**: Yarn → pnpm hygiene. `pnpm-lock.yaml` shipped, every `pnpm install` in CI now uses `--frozen-lockfile`.
- ✅ **CRG01-5**: Migration bring-up bugs fixed (Duplicate enum `CREATE TYPE`, over-long revision IDs), conftest respects `DATABASE_URL`, real Postgres `pg_advisory_xact_lock` to close the last-owner orphan race under concurrent revokes.
- ✅ **CRG01-6**: Frontend scaffold made buildable end-to-end (`.prettierignore`, root eslint config + `apps/mobile/.eslintrc.cjs`, `packages/config/tsconfig.json`, `declaration:false` on web tsconfig, `publicHoistPattern` for `@types/*`, `<Suspense>` on `/accept-invite`, `vitest --run` for `pnpm test`).
- ✅ **CRG01-7** (testing-agent finding): Enum label mismatch (`values_callable=lambda enum: [m.value for m in enum]`) so `alembic upgrade head` + `python -m app.seed` succeeds on a fresh Postgres. Verified `SEED OK`.

Final validation set (all green on this branch):
- ruff / black — 0 issues
- pytest — SQLite: 84 passed, 1 skipped (postgres-only concurrency test) · Postgres: 85 passed
- alembic upgrade head → head `0005_prod_event_idempotent`; round-trip clean
- alembic + seed on fresh Postgres → `SEED OK`
- prettier / eslint / tsc / vitest --run — 7/7 packages green
- next build — 10 routes emitted, no prerender errors
- Testing-agent iteration_5: 9/9 curl-driven CRG01-1/CRG01-2 tests pass

Commits: `f790649` (initial sweep), `85254e1` (enum label fix + drop live-HTTP suite).

**Test total: 85** on Postgres (was 77 → +8 for CRG01 regressions).

## Domain positioning (2026-02-07)

The **Production Engine** built in Sprint 2 (`Organization → Farm →
ProductionSite → ProductionUnit → ProductionBatch → ProductionEvent`
+ pluggable `EventCatalog`) **is** the canonical agricultural domain
foundation. All future vertical capabilities — aquaculture, crop,
livestock — extend the engine rather than introduce a parallel set
of generic domain models. New "domain" work manifests as:

- Additional `ProductionUnitType` codes (system-seeded and/or org-custom).
- New `EventCatalogEntry` registrations with Pydantic payload schemas
  and (optionally) a `triggers_transition_to` mapping.
- New batch-state predicates and lifecycle rules attached to the
  existing state machine.
- New reporting / aggregation projections over `production_events`.

There is **no** roadmap item to build `Crop`, `Season`, `Hatchery`,
`Pond`, `FeedLog`, `MortalityLog`, etc. as free-standing tables. Those
names are aquaculture-flavoured surface concepts; their persistence
lives inside `ProductionEvent.data` (JSONB), governed by their catalog
schema. `StockingEvent`, `HARVEST`, `FEEDING`, `MORTALITY`,
`WATER_QUALITY`, `SAMPLING`, `MEDICATION`, `TRANSFER`, `INSPECTION`
are already registered.

## Next Actions
1. Extend the Production Engine with vertical-specific catalog entries
   (aquaculture-first) and any new lifecycle rules they require — no
   parallel domain-model track.
2. Resend backend for `EmailSender` (verified sender + templated HTML).
3. Fine-grained audit UI + filtering + export.
4. Mobile onboarding flow (currently just shell).
