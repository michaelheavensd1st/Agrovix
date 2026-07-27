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

## Sprint 2 — Agrovix Production Engine (APE) (2026-02-06 evening)
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

## Architectural invariant — Agrovix Production Engine (APE) (2026-02-07)

The Sprint-2 engine is now the named canonical foundation:
**Agrovix Production Engine (APE)** (short form: **APE**).
APE is the **universal production engine for every agricultural
vertical** — aquaculture, livestock, and crop all run on top of it.

### APE owns (single source of truth — no vertical may duplicate)
- `ProductionSite`
- `ProductionUnit`
- `ProductionUnitType`
- `ProductionBatch`
- `ProductionEvent`
- `ProductionEventCatalog`
- Batch lifecycle
- State machine
- Event validation
- Event history
- Production analytics foundation

### How verticals extend APE (never duplicate)
A vertical is a **plug-in surface**, not a parallel domain. It ships
its capability by contributing:

- **Unit types** — new `ProductionUnitType` codes (system-seeded or
  org-custom).
- **Event catalog entries** — new `EventCatalogEntry` registrations
  with Pydantic payload schemas and (optionally) a
  `triggers_transition_to` mapping.
- **Validation schemas** — Pydantic models bound to those catalog
  entries (`extra="forbid"` remains mandatory).
- **Lifecycle rules** — additional batch-state predicates layered on
  the existing state machine (no parallel state graph).
- **Reporting projections** — vertical-specific read-only projections
  and aggregates over `production_events` (materialised views,
  cursor endpoints, dashboards).
- **Vertical-specific services** — domain logic that composes APE
  primitives; never reaches around them to write directly to
  `production_*` tables.

### Illustrative (non-exhaustive) vertical surface concepts

| Vertical | Unit types (extend `ProductionUnitType`) | Events (extend `EventCatalog`) |
|---|---|---|
| Aquaculture | Pond, Raceway, Cage | Stocking, Feeding, Mortality |
| Livestock | Barn, Pen | Vaccination, Breeding, Weaning |
| Crop | Plot, Greenhouse | Planting, Irrigation, Fertilization, Harvest |

These names are **surface concepts**, not new tables. Their
persistence lives inside `ProductionUnitType` (structural) and
`ProductionEvent.data` (JSONB, governed by their catalog schema).

### Architectural invariant (non-negotiable)
**No vertical module may redefine `ProductionBatch`,
`ProductionEvent`, or `ProductionUnit`.** Any PR that introduces a
parallel table, model, or lifecycle machine for these concepts is a
regression against APE and must be rejected in review. Reviewers
should also reject:

- Parallel state machines for batch-like entities.
- Direct writes to `production_*` tables bypassing APE services.
- New "event log" tables that shadow `production_events`.
- Vertical-owned `Site` / `Unit` / `Batch` copies.

When a vertical genuinely needs a concept APE does not yet expose,
the fix is to **extend APE first** (add the primitive, generalise
it, ship it in a migration) and then let the vertical consume it —
never fork the engine.

## Sprint 3 — Aquaculture Vertical Slice 01 (2026-02-08)

First vertical to run **on top of APE without a parallel domain
track.** Sprint 3 proves the "extend, never duplicate" contract by
delivering a complete stock-through-report workflow using nothing
but APE primitives + vertical registrations.

### Backend
- **10 aquaculture unit types** system-seeded (idempotent):
  `BROODSTOCK_UNIT`, `INCUBATION_UNIT`, `HATCHERY_TANK`, `FRY_TANK`,
  `NURSERY_TANK`, `GROW_OUT_POND`, `BIOFLOC_TANK`, `RACEWAY`,
  `FLOATING_CAGE`, `QUARANTINE_UNIT`.
- **User-facing naming** on `ProductionUnitType`: added
  `display_name`, `plural_name`, `vertical` columns (migration
  `0006_aqua_vertical_slice_01`). `GROW_OUT_POND` renders as
  "Pond" / "Ponds"; `FLOATING_CAGE` as "Cage" / "Cages".
  Architecture stays abstract; product language stays natural.
- **Sprint-3 event catalog** (only these 7, per spec): `STOCKING`,
  `FEEDING`, `MORTALITY`, `SAMPLING`, `WATER_QUALITY`, `TRANSFER`,
  `HARVEST`. Every schema is `extra="forbid"`, every schema has an
  OpenAPI example, weight/feed/measurement units are explicit.
- **Business rules** (pre-insert, atomic with event insert):
  - `MORTALITY.count` cannot exceed
    `estimated_remaining_population`; no silent negative stock.
  - `TRANSFER.source_unit_id` must equal the batch's current unit;
    destination must exist and share the same farm;
    cross-farm transfers rejected with
    `transfer_cross_farm_blocked`; population guard applies.
  - `HARVEST.is_final=true` triggers the existing
    HARVESTED transition; partial harvests stay ACTIVE.
- **Projections service** (`app/services/projections.py`): derived,
  read-only aggregates over the append-only event stream —
  `initial_stocked_quantity`, `cumulative_mortality`,
  `cumulative_harvest`, `cumulative_transfer_out`,
  `estimated_remaining_population` (SAMPLING override or
  mass-balance), `latest_average_weight`, `estimated_biomass_kg`,
  `total_feed_kg`, `survival_rate`, `batch_age_days`,
  `latest_water_quality`. Exposed at
  `GET /api/v1/batches/{id}/projections` via `BatchProjectionsPublic`.
- **Idempotency** applied to every new event type (SAVEPOINT +
  partial-unique index — unchanged from CRG01).
- Bug fix (found while wiring OpenAPI for the projections
  endpoint): removed `response_class=None` from
  `DELETE /organizations/{id}` which was breaking
  `app.openapi()` generation.

### Frontend (`apps/web`)
- New pages:
  - `/farms/[farmId]` — sites index
  - `/sites/[siteId]` — units grouped by their vertical display
    name ("Ponds", "Cages", "Hatchery Tanks", …)
  - `/units/[unitId]` — batches for a unit
  - `/batches/[batchId]` — event timeline, projections panel,
    record-event workflows
- **Deliberate forms** (not JSON-schema renderers) for STOCKING,
  FEEDING, MORTALITY (`components/event-forms.tsx`).
- **Catalog-driven fallback form** for SAMPLING / WATER_QUALITY /
  TRANSFER / HARVEST, seeded from the OpenAPI example, nested
  unit annotations auto-populated.
- Shared UX components (`components/ape-ui.tsx`): Breadcrumbs,
  StateBadge (colour-coded lifecycle), Loading, EmptyState,
  ErrorBanner, ForbiddenBanner — covers **explicit loading,
  empty, error, forbidden, offline states** (spec requirement).
- Every interactive element carries `data-testid`.
- Mobile-responsive Tailwind layouts throughout.

### Testing
- **New test file** `test_aquaculture_slice_01.py` (26 tests) —
  unit-type seeding + idempotency, valid payloads per event type,
  schema-level rejections (missing species, ph=15, min>avg,
  harvest total requires is_final), deleted-unit rejection,
  idempotency replay + payload conflict for new event types,
  mortality guard (exceeds population, on planned batch),
  transfer source-mismatch / destination-not-found /
  cross-farm-blocked, final vs partial harvest, projections
  correctness incl. SAMPLING population override, timeline
  cursor pagination stability, cross-tenant rejection.
- Test helpers in `_helpers.py` provide canonical payload
  builders for all 7 event types so downstream sprints stay
  aligned automatically.
- Vitest coverage in `apps/web/tests/event-forms.test.tsx`
  proves the deliberate forms gate empty / unconfirmed
  submissions client-side.

### Validation (branch `fix/codex-review-gate-01` continued)
- ruff / black: PASS
- pytest SQLite: **110 passed / 1 skipped** (postgres-only race)
- pytest Postgres: **111 passed**
- Alembic full round-trip on fresh Postgres:
  `upgrade head` → `downgrade base` → `upgrade head` — clean.
- `alembic upgrade head + python -m app.seed` on fresh Postgres:
  SEED OK.
- prettier / eslint / tsc / `vitest --run` — 7/7 workspaces green.
- Next.js production build: 15 routes, 0 prerender errors.
- Curl-driven E2E: register → verify → create org / farm / site /
  3 ponds / batch → STOCKING (25 000 shrimp, PL10) → transition
  to ACTIVE → 3 feedings + mortality + sampling + water-quality;
  `GET /projections` returns:
  `stocked=25 000, mortality=420, remaining=23 800 (sampling
  override), avg=4.8g, biomass=114.24kg, feed=19.5kg,
  survival=95.2%, latest_water_quality={temp 29.4°C, DO 5.6mg/l,
  pH 7.9, …}`.

**Test total: 111 on Postgres** (was 85 → +26 for the vertical
slice).

## Next Actions
1. **Await approval before Sprint 4.** Do NOT begin inventory
   integration or additional aquaculture lifecycle features
   (breeding, spawning, incubation, hatching, grading,
   medication, sales) without explicit go.
2. Resend backend for `EmailSender` (verified sender + templated HTML).
3. Fine-grained audit UI + filtering + export.
4. Mobile onboarding flow (currently just shell).

## Codex Review Gate 02 — pre-merge hardening (2026-02-08 pm)

Locked-in policies and enforcement pass on branch
`fix/codex-review-gate-01`. Fixed the five items surfaced during the
Sprint 3 acceptance review before merge.

### CRG02-1 · Endpoint permission enforcement
Every APE production endpoint now enforces an explicit permission
scope AFTER the tenancy 404 check. Order is unchanged
(non-members still get 404, not 403) so the cross-tenant leak
invariant from Sprint 1 is preserved.

Codes enforced per route (permission-driven, never role-name):
- Sites: `production_site.create|read|update|delete|restore`
- Unit types: `production_unit_type.create|delete`
  (`.read` implicit — the list endpoint is scope-filtered)
- Units: `production_unit.create|read|update|delete`
- Batches: `production_batch.create|read|update|transition`
- Events: `production_event.create|read`

Regression tests (`test_codex_review_gate_02.py`):
- viewer role → 403 on POST /events
- non-member → 404 (tenancy 404 still precedes permission 403)
- viewer role → 200 on GET /batches/{id}

### CRG02-2 · Postgres row-level concurrency
`ProductionBatchRepository.get_by_id_for_update()` emits
`SELECT ... FOR UPDATE` on Postgres. `ProductionEventService.create()`
and `ProductionBatchService.transition()` acquire the batch lock at
the top of their flow so:
- MORTALITY / TRANSFER / HARVEST population validation reads happen
  INSIDE the same lock as the INSERT
- Two mortalities that together exceed remaining population resolve
  to exactly one 201 + one 409 (proven under real Postgres in
  `test_concurrent_mortalities_never_overshoot`)
- Same for TRANSFER and final HARVEST races (dedicated tests each)
- Two racing STOCKING events resolve to exactly one 201 + one 409

Under SQLite the FOR UPDATE clause is a no-op, but StaticPool +
single connection already serialise writers so the domain guards
still hold. Race tests are `_postgres_only`.

### CRG02-3 · STOCKING policy (documented + enforced)
**Exactly one STOCKING event per batch, allowed only while
`state == PLANNED`.**

Rationale — a batch is one biologically coherent cohort. Multiple
stocking events would distort `initial_stocked_quantity`, cumulative
mortality, biomass and survival rate. Additional intake must arrive
via:
- a new batch, or
- a TRANSFER event from a source batch where lineage is preserved.

Adjustments are deliberately NOT in scope for Sprint 3 — a
controlled correction workflow is a Sprint 4+ backlog item.

Enforcement points:
- `ProductionEventService._enforce_stocking_once()` — 409
  `stocking_only_in_planned_state` outside PLANNED, 409
  `stocking_already_recorded` on repeat
- Batch state machine (STOCKING drives PLANNED → STOCKED once)
- Postgres FOR UPDATE lock serialises concurrent stocking attempts

### CRG02-4 · HARVEST validation
- `quantity <= estimated_remaining_population` → 409
  `harvest_exceeds_population`
- `total_weight > 0` — tightened schema (`gt=0`); a redundant
  server-side guard covers the corner case that would otherwise
  need a migration
- Second final HARVEST rejected: either 409
  `harvest_already_final` (racing on ACTIVE) or the terminal-state
  guard (batch already HARVESTED)
- All checks run under the batch FOR UPDATE lock so concurrent
  final harvests resolve to exactly one 201 + one 409

### CRG02-5 · Site / Unit lifecycle policy
**MAINTENANCE — narrow allow-list of writes.** Only these events
are permitted while a site or unit is in maintenance:
- `WATER_QUALITY` — readings must continue during maintenance
- `TRANSFER` — permitted only when the source unit is the unit
  under maintenance (i.e. an evacuation). Transfer INTO a
  MAINTENANCE unit is blocked with `transfer_destination_under_maintenance`.

Blocked while MAINTENANCE: `STOCKING`, `FEEDING`, `MORTALITY`,
`SAMPLING`, `HARVEST`, and any TRANSFER not evacuating.
A mortality observation during maintenance is BLOCKED for Sprint 3
and documented as a limitation — a Sprint 4+ emergency / incident
pathway can handle exceptions.

**CLOSED — read-only.** Every write returns 409
`resource_closed_no_writes`. A unit or site cannot transition to
CLOSED while it still holds an active (PLANNED / STOCKED / ACTIVE
/ SUSPENDED) batch — enforced at PATCH `/units/{id}` and PATCH
`/sites/{id}` with error codes `unit_close_blocked_by_active_batches`
and `site_close_blocked_by_active_batches`. HARVESTED batches are
permitted (final harvest IS the exit gate).

### Validation (all green on this branch)
- ruff / black — 0 issues
- pytest SQLite: **123 passed / 5 skipped** (Postgres-only race
  tests)
- pytest Postgres: **128 passed** — including all 4 CRG02 concurrency
  tests
- alembic upgrade head → downgrade base → upgrade head — clean on
  fresh Postgres

**Test total: 128 on Postgres** (was 111 → +17 for CRG02).

## Codex Review Gate 02 (final) — centralised lifecycle policy (2026-02-08 evening)

Re-review follow-up: closed the "creation + manual transition + update"
gaps left after the first CRG02 pass and consolidated ALL
ACTIVE / MAINTENANCE / CLOSED semantics behind one helper module so
future divergence is impossible.

### New central helper — `app/production/lifecycle_policy.py`
Single source of truth used by:
- `ProductionUnitService.create()` — `assert_can_create_unit_in_site`
- `ProductionBatchService.create()` — `assert_can_create_batch`
- `ProductionBatchService.transition()` (manual endpoint only —
  event-driven transitions stay governed by the event gate below)
  — `assert_can_manually_transition`
- `ProductionEventService._enforce_site_unit_lifecycle_policy` —
  `assert_event_allowed_by_lifecycle` (includes evacuating TRANSFER
  exception when `source_unit_id == unit.id`)
- `PATCH /sites/{id}` — `assert_site_update_allowed`
- `PATCH /units/{id}` — `assert_unit_update_allowed`

### Enforced semantics
- **CLOSED** site or unit → *no writes at all*. Cannot host new
  units or batches, cannot record events, cannot be transitioned
  manually, cannot be edited except for a controlled `status`
  reopen. Error codes: `site_closed_no_writes`, `unit_closed_no_writes`.
- **MAINTENANCE** site or unit → narrow write allow-list:
  events limited to `WATER_QUALITY` and evacuating `TRANSFER`
  (source unit == unit under maintenance); PATCH restricted to
  `status` + safe administrative metadata (`name`, `description`,
  `address`, `timezone`, `manager_id`, `metadata_json` — units:
  `status`, `name`, `metadata_json`). Structural fields such as
  `capacity` are refused. Error codes: `site_under_maintenance`,
  `unit_under_maintenance`.
- **ACTIVE** site or unit → normal behaviour.

### New tests (`test_codex_review_gate_02.py`)
+ `test_cannot_create_unit_under_maintenance_site`
+ `test_cannot_create_unit_under_closed_site`
+ `test_cannot_create_batch_under_maintenance_unit`
+ `test_cannot_create_batch_under_closed_unit`
+ `test_cannot_create_batch_under_maintenance_site`
+ `test_cannot_create_batch_under_closed_site`
+ `test_cannot_manual_transition_under_maintenance_unit`
+ `test_cannot_manual_transition_under_maintenance_site`
+ `test_cannot_manual_transition_under_closed_unit`
+ `test_evacuation_transfer_still_works_from_maintenance`
+ `test_closed_site_is_read_only_for_patch`
+ `test_closed_unit_is_read_only_for_patch`
+ `test_maintenance_site_disallows_capacity_edit`

### Validation (all green)
- ruff / black — 0 issues
- pytest SQLite: **136 passed / 5 skipped** (Postgres-only race
  tests)
- pytest Postgres: **141 passed** — including all 4 concurrency
  tests + 10 new lifecycle-gap tests
- alembic upgrade head → downgrade base → upgrade head — clean
- pnpm lint / type-check / test / next build (7/7 workspaces) — green

**Test total: 141 on Postgres** (was 128 → +13 lifecycle-gap tests).

## Codex Review Gate 02 (verification pass) — remaining read-perm + CLOSED-mutation blockers (2026-02-08 late)

Verification-only follow-up: two High-severity blockers surfaced in
the post-consolidation Codex pass. Resolved without expanding scope.

### 1 · Read endpoints — explicit permission gates
- `GET /production-unit-types`:
  - `organization_id` provided → tenancy 404 (non-member) BEFORE
    `production_unit_type.read` (403). System types included.
  - `organization_id` omitted → returns **system-only** types by
    policy (no cross-tenant hint) AND requires the caller to hold
    `production_unit_type.read` at some scope (platform or any
    org-scoped role assignment). Pure authentication is not enough.
- `GET /production-events/catalog`: now requires
  `production_event.read` (any scope). Previously auth-only.

The CRG01 "own-org custom type is visible unfiltered" behaviour has
been superseded by the stricter CRG02 policy — that test was
updated to filter explicitly by `organization_id` for the positive
control.

### 2 · CLOSED lifecycle on remaining mutations
Central helper additions in `app/production/lifecycle_policy.py`:
- `assert_batch_update_allowed(site, unit)` — used by `PATCH
  /batches/{id}`. CLOSED site or unit → 409; MAINTENANCE site or
  unit → 409 (no batch-admin allow-list defined for Sprint 3).
- `assert_site_delete_allowed(site)` — used by `DELETE /sites/{id}`.
  CLOSED → 409. Reopen via explicit `status=active` first.
- `assert_unit_delete_allowed(unit)` — used by `DELETE /units/{id}`.
  Same policy as sites.

CLOSED-means-read-only invariant now applies uniformly across
`update_batch`, `delete_site`, `delete_unit`, alongside the existing
`update_site`, `update_unit`, unit creation, batch creation, manual
transition and event creation gates.

### New tests (`test_codex_review_gate_02.py`, +13)
- unauthenticated → `list_unit_types`, `get_event_catalog` → 401
- orphan (no memberships) → both endpoints → 403
- non-member org-scoped `list_unit_types` → 404
- authorized member → both endpoints → 200
- batch PATCH blocked when parent unit CLOSED
- batch PATCH blocked when parent site CLOSED
- site DELETE blocked when site CLOSED
- unit DELETE blocked when unit CLOSED
- reopen → DELETE follows normal safeguards (positive control)

### Validation (all green)
- ruff / black — 0 issues
- pytest SQLite: **148 passed / 5 skipped** (Postgres-only race tests)
- pytest Postgres: **153 passed** (all 4 concurrency tests inclusive)
- alembic upgrade head → downgrade base → upgrade head — clean on
  fresh Postgres 15
- pnpm lint / type-check / test / next build (7/7 workspaces) — green

### Changed files (delta for Codex verification-only pass)
- `apps/api/app/api/v1/endpoints/production.py`
- `apps/api/app/production/lifecycle_policy.py`
- `apps/api/tests/test_codex_review_gate_01.py`
- `apps/api/tests/test_codex_review_gate_02.py`
- `memory/PRD.md`

**Commit SHA (base):** `4fb1601`
**Unresolved blockers:** none. Awaiting `APPROVE FOR MERGE`.

## Sprint 4 — Operational Resources 01 · Inventory (2026-02-08 late — closeout for CRG03)

Delivered on branch `agent/sprint-4-operational-resources`. Sprint 4 is
the first vertical-agnostic Operational Resource bounded context to
run on top of APE, and is designed as an append-only ledger with
strict Postgres row-level concurrency, tenant isolation, and full
idempotency semantics — the same disciplines Sprint 2/3 established
for `ProductionEvent`.

### Domain
- `Warehouse` — org-scoped or optionally farm-pinned physical storage
  with `status` in {`active`, `maintenance`, `closed`}. Farm-pinned
  warehouses require farm-membership OR org-membership to view or
  mutate. `code` unique per organisation.
- `StorageLocation` — optional child of a warehouse for finer-grained
  binning. Not required for Sprint 4 operations; wired for future
  vertical extensions.
- `InventoryItem` — org-scoped catalog record with a fixed
  `canonical_unit` (`kg`/`g`/`L`/`mL`/`count`/`bag`/`pack`) and a
  `category` (`feed`/`medicine`/`chemical`/`supply`). Canonical unit
  is immutable after creation; the service layer rejects updates that
  would change it.
- `InventoryLot` — a (`warehouse`, `item`, `lot_code`) tuple with
  optional `expiry_date`, `unit_cost`, and metadata. Balances are
  **not stored on the lot** — they are computed live from the ledger.
- `InventoryTransaction` — append-only ledger, one row per movement:
  `receipt`, `issue`, `adjustment_increase`, `adjustment_decrease`,
  `transfer_out`, `transfer_in`, `reversal`, `consumption`. Never
  mutated after insert; every entry carries `performed_by`, optional
  `reason`, optional `reference_type`/`reference_id`, and the
  `idempotency_key` that produced it.

### Backend surface (`apps/api/app/api/v1/endpoints/inventory.py`)
- Warehouses: `POST/GET /organizations/{org}/warehouses`,
  `GET/PATCH /warehouses/{id}`, and `POST/GET /warehouses/{id}/storage-locations`.
- Items: `POST/GET /organizations/{org}/inventory-items`,
  `PATCH /inventory-items/{id}`.
- Lots: `GET /warehouses/{id}/lots` (returns each lot with a live
  balance in the item's canonical unit), `GET /lots/{id}`.
- Ledger actions (all require `Idempotency-Key`; same key + same
  payload → 200 replay with `X-Idempotent-Replay: true`; same key +
  different payload → 409 `idempotency_key_payload_conflict`):
  - `POST /warehouses/{id}/inventory:receive`
  - `POST /warehouses/{id}/inventory:issue`
  - `POST /warehouses/{id}/inventory:transfer`
  - `POST /warehouses/{id}/inventory:adjust` (reason required)
  - `POST /warehouses/{id}/inventory:reverse`
- History: `GET /lots/{id}/transactions` with `(performed_at DESC, id DESC)`
  ordering and opaque cursor pagination (same shape as APE event feed).
- Permissions (13 codes): `inventory_warehouse.{create,read,update,delete}`,
  `inventory_item.{create,read,update,delete}`, `inventory_lot.{read}`,
  `inventory_transaction.{create,read,reverse}`. Cross-tenant leak
  invariant preserved: tenancy 404 comes before permission 403.

### Concurrency + safety
- Postgres row-level lock on the lot (`SELECT ... FOR UPDATE`) inside
  every ledger action, so two racing issues that would together
  overshoot balance resolve to exactly one 201 + one 409.
- `values_callable=lambda enum: [m.value for m in enum]` on all
  SQLAlchemy `Enum` columns to make asyncpg agree with fresh
  `CREATE TYPE` labels — same fix pattern established during CRG01.
- Idempotency is enforced via a partial-unique index on
  `(warehouse_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
  plus a SAVEPOINT-wrapped INSERT + payload-hash comparison.
- `MAINTENANCE` warehouses accept `receipt`, `adjustment`, `reversal`
  but block outbound `issue`/`transfer_out` unless the reason string
  matches the documented evacuation pattern. `CLOSED` warehouses are
  strictly read-only.

### FEEDING → inventory consumption wiring
- `POST /batches/{id}/events` with `event_type=FEEDING` accepts an
  optional `inventory_lot_id`. When present, the service atomically:
  1. Acquires the batch lock (existing APE guard).
  2. Acquires the lot lock (`SELECT … FOR UPDATE`).
  3. Validates unit compatibility with the item's canonical unit.
  4. Rejects if the lot doesn't belong to a warehouse in the same
     organisation, or if the lot is closed / balance would go
     negative (409 `insufficient_stock`).
  5. Inserts a `consumption` transaction on the lot with
     `reference_type='production_event'` and `reference_id` equal to
     the newly-created event, then completes the event insert in the
     same transaction. The canonical linkage direction is
     `InventoryTransaction.reference_id → ProductionEvent.id` — the
     event itself stays immutable (Sprint 2 append-only invariant),
     so consumers should query `GET /lots/{id}/transactions` filtered
     by `reference_type='production_event'` when they need to walk
     from an event to its consumption row.
- Ad-hoc feed (no lot) remains supported by providing
  `feed_description` instead of `inventory_lot_id`.

### Frontend (`apps/web/app/inventory/page.tsx` + `components/ui-polish.tsx`)
- Deliberate operator workspace with 9 tabs — Overview, Warehouses,
  Items, Lots & balances, Receive, Issue, Transfer, Adjust /
  reconcile, Transaction history. `useSearchParams` bootstrap wrapped
  in `<Suspense>` per Next.js 14 CSR bailout.
- Sprint 4 UX polish primitives (`ui-polish.tsx`):
  toast bus (`toast()`, `<Toaster />`), stable `useSyncExternalStore`
  snapshots, `Skeleton`/`SkeletonRows`, `EmptyStateCard`,
  `ConfirmDialog`, `friendlyError()` mapping known backend codes
  (idempotency, insufficient_stock, warehouse_closed_no_writes,
  reverse_already_reversed, unit_incompatible, …) into user-friendly
  language.
- Every interactive control carries a `data-testid`; test IDs are
  catalogued in `/app/memory/test_credentials.md`.
- Search/filter on Warehouses, Items, Lots & History; category
  dropdown on Items; type filter on History (matches the lowercase
  ledger enum values); empty-state CTAs on first-run screens; submit
  buttons disable while requests are in flight; destructive posts
  (Adjust, Issue) always confirm via `ConfirmDialog`.
- FeedingForm surfaces an optional `feeding-lot-id` field. When
  populated the description input is disabled and the API is
  called with `inventory_lot_id` so the lot balance is deducted.

### Migration
- `0007_inventory_sprint_4` — creates `warehouses`,
  `storage_locations`, `inventory_items`, `inventory_lots`,
  `inventory_transactions`; adds the four enum types
  (`warehousestatus`, `inventoryitemcategory`, `stockunit`,
  `inventorytransactiontype`); creates the `idempotency_key` partial
  unique index and the `(lot_id, performed_at, id)` ledger index.
- Full round-trip clean on fresh Postgres 15:
  `upgrade head → downgrade base → upgrade head`.

### Validation (all green on branch `agent/sprint-4-operational-resources`)
- ruff / black — 0 issues (Python 3.12 target).
- pytest SQLite — **167 passed, 7 skipped** (Postgres-only concurrency).
- pytest Postgres — **179 passed** (added 5 live-server curl-driven
  E2E tests in `test_sprint4_e2e_curl.py` that skip cleanly when the
  local API on `SPRINT4_API_BASE` isn't reachable, so CI stays hermetic).
- Alembic `upgrade head → downgrade base → upgrade head` on fresh
  Postgres — clean; `python -m app.seed` — SEED OK.
- Frontend workspace suite (`pnpm -r` filter '!@agrovix/mobile'):
  eslint + tsc + vitest — 6/6 green (7 vitest cases pass in
  `apps/web`; 4 in `@agrovix/validation`).
- `next build` — 16 routes emitted, 0 prerender errors,
  `/inventory` 9.11 kB (First Load JS 96.3 kB).
- `scripts/verify-no-mongo.sh` — clean after the guard was updated to
  exclude `node_modules` (zod's own template-literal test file was
  triggering a false positive — see M6 below).

### Sprint 4 milestone log
- **M1**: models + permissions + migration `0007_inventory_sprint_4`
  (commit `1994aec`).
- **M2**: units/schemas/repos/service/endpoints + FEEDING integration
  (commit `b946677`).
- **M3**: comprehensive inventory pytest suite (commit `925f5ac`).
- **M4**: inventory frontend UI polish — toasts, skeletons, filters,
  confirmation dialogs, empty-state CTAs, submit-disabled semantics,
  friendly 409 language (commit `895918a`).
- **M5**: testing-agent-driven fixes — history filter aligned with
  lowercase ledger enum values, `Toaster` server snapshot stable
  reference, live-server E2E curl suite skips when API is down
  (commit `400fb02`).
- **M6**: `scripts/verify-no-mongo.sh` excludes `node_modules` so
  bundled zod fixtures don't false-positive (commit `62867ed`).
- **M7**: PRD closeout for CRG03 request (commit `8eaebcf`).
- **M8**: CRG03 P0/P1 corrections (commit `3796618`). Adds
  `WarehouseStatus.MAINTENANCE` with a central lifecycle gate
  (`_assert_warehouse_status_allows`) applied to every ledger writer;
  extends `warehouse_status` Postgres enum via migration
  `0008_wh_maintenance` with a fully reversible downgrade; enforces
  dual-warehouse authorization on `POST :transfer` (source AND
  destination); moves `update_warehouse` / `update_item` /
  `create_storage_location` into `InventoryService` with full audit
  logging; reorders reversal so idempotency replay short-circuits
  BEFORE the `already_reversed` check; aligns the FEEDING linkage
  documentation to the canonical direction
  (`InventoryTransaction.reference_id → ProductionEvent.id`, event
  stays immutable). +9 integration tests. Backend pytest totals rise
  to 176 (SQLite) / 183 (Postgres). Testing agent iteration_7:
  backend 100% pass (176/176 hermetic + 9/9 live curl), frontend
  100% pass (9/9 tabs), zero critical defects, one cosmetic
  entity_type inconsistency fixed in the same commit range.

### Sprint 4 CRG03 verification pass — Final Closeout Report

**Branch:** `agent/sprint-4-operational-resources`
**Final commit SHA:** `3796618` (M8) followed by cosmetic entity_type
fix currently uncommitted at write-time; will be part of M9 commit.

**Files changed in this correction pass (Sprint 4 M8 + M9):**
```
apps/api/alembic/versions/0008_warehouse_maintenance_status.py    (+72)
apps/api/app/models/inventory.py                                  (+1 −0)
apps/api/app/services/inventory.py                                (+280 −45)
apps/api/app/api/v1/endpoints/inventory.py                        (+45 −25)
apps/api/tests/test_sprint_4_inventory.py                         (+263)
apps/api/tests/test_crg03_live.py                                 (+484, testing-agent artifact)
memory/PRD.md                                                     (+70)
memory/test_credentials.md                                        (+2)
```

**Migration revisions in Sprint 4:**
- `0007_inventory_sprint_4` — warehouses / storage_locations /
  inventory_items / inventory_lots / inventory_transactions +
  4 enum types + partial-unique idempotency index (base).
- `0008_wh_maintenance` — adds `maintenance` to `warehouse_status`
  (upgrade uses idempotent `ADD VALUE IF NOT EXISTS`; downgrade
  refuses when any warehouse is still in maintenance, otherwise
  cleanly drops the label via drop-default → rename-old →
  create-new → alter-using → set-default → drop-old-type).

**Test summary:**
- **Ruff / Black** — 0 issues (Python 3.12 target).
- **Pytest SQLite** — 176 passed, 7 skipped (Postgres-only concurrency).
- **Pytest Postgres** — 183 passed (was 174 pre-CRG03 → +9 CRG03
  tests). Includes 30+ Sprint 4 inventory tests, 9 new CRG03 tests
  covering MAINTENANCE lifecycle, transfer dual-auth, reversal
  idempotency replay, and service-layer audit logging.
- **Alembic** — `upgrade head → downgrade base → upgrade head`
  clean on fresh Postgres 15; seed OK.
- **Frontend workspace** — `pnpm -r` (excluding mobile): eslint +
  tsc + vitest all green; `next build` — 16 routes, 0 prerender
  errors.
- **CI guards** — `scripts/verify-no-mongo.sh` clean.
- **Testing agent (iteration_7.json)** — backend 100% pass
  (176/176 hermetic + 9/9 live curl on `http://127.0.0.1:8055`),
  frontend 100% pass (9/9 tabs on `http://127.0.0.1:3001`), zero
  critical defects, `retest_needed=false`,
  `should_main_agent_self_test=false`.

**Remaining known limitations** (deliberate, deferred to backlog):
- Adjustments and reversals remain auditable but not
  approval-gated (Sprint 5+ workflow will add multi-step approval).
- No barcode / QR scanning or bulk import flows yet.
- Frontend uses plain Tailwind consistent with existing pages; a
  design-system consolidation to Shadcn UI is a separate,
  deliberately scheduled pass.
- MAINTENANCE warehouse policy is intentionally coarse (allow-list
  by transaction type). A Sprint 5+ maintenance workflow can
  generalise it with time-boxed windows + reason schemas.
- `apps/web/app/inventory/page.tsx` remains a single ~1200-line
  component. Cosmetic; extraction into `_components/*` tracked as a
  Sprint 5 pre-flight task.

**Deployment considerations:**
- Migration `0008_wh_maintenance` is additive and reversible.
  Deploy sequence: `alembic upgrade head` (adds enum label —
  idempotent) → `python -m app.seed` (permissions unchanged for
  this migration).
- No environment variable changes.
- No new external integrations; Redis remains optional.
- CORS / rate-limit defaults unchanged.
- The `inventory:transfer` endpoint now returns 403 in cases that
  previously succeeded silently (dual-warehouse authorization
  contract). API clients that hard-coded transfers from a
  farm-scoped operator into a foreign farm will start seeing 403;
  this is the intended behavioural change.

**Recommendation:**
**Sprint 4 with CRG03 P0/P1 corrections is ready for Codex Review
Gate 03 (verification pass).** All DoD gates are green, all
testing-agent findings resolved, PRD documentation reflects the
implementation exactly, and both `ProductionEvent` + `InventoryTransaction`
retain their append-only invariants.

**Not requesting merge approval.** Awaiting the Codex Review Gate 03
verification pass before promoting to `develop`. Do NOT begin
Sprint 5.

### Ready for Codex Review Gate 03
Sprint 4 backend and frontend are functionally complete, tested,
and all Definition-of-Done gates are green. Awaiting Codex Review
Gate 03 before merging into develop.

**Test total: 179 on Postgres** (was 141 → +38 for the inventory bounded
context and its concurrency + idempotency + FEEDING-consumption tests).
**Do NOT begin Sprint 5.** Procurement, suppliers, purchase approvals,
equipment/asset management, water resource management, and
sales/finance costing methods remain in the backlog.

### Known limitations (deliberate, deferred)
- Adjustments and reversals are auditable but not
  approval-gated. A Sprint 5+ workflow will add multi-step approval
  for large adjustments.
- Inventory does not yet expose barcode/QR scanning or bulk import
  flows — Sprint 4 focuses on the correctness kernel.
- The design system remains plain Tailwind (consistent with the
  farm/batch pages). A separate design-system consolidation pass to
  Shadcn UI is tracked in the backlog and NOT part of Sprint 4.
- MAINTENANCE warehouse policy is minimal (evacuation matching by
  reason). A Sprint 5+ maintenance workflow can generalise this.

### Deployment considerations
- Migration `0007_inventory_sprint_4` is additive (no data loss on
  upgrade) and reversible (round-trip verified). Deploy via the
  standard `alembic upgrade head` step.
- New permissions (13 codes) are added by `python -m app.seed`; the
  seeder is idempotent and safe to run on every deploy.
- No new external integrations; Redis is still optional (in-memory
  fallback covers dev).
- No changes to environment variables or CORS defaults.



## Sprint 5.4 — Stock Operations UI (accepted 2026-02)
- Frontend for the Sprint 4 inventory kernel: Receive / Issue / Transfer
  / Adjust / Reverse dialogs with shared idempotency-key discipline,
  route + generation guards, and post-mutation refresh.
- Regression tests in `apps/web/tests/stock-operations.test.tsx`.

## Sprint 5.4.1 — Review fixes (accepted 2026-02)
- Focus trap + focus restoration inside stock-operation dialogs.
- Unmount / URL-flip invalidation across every dialog side-effect
  (toasts, refresh, /login redirect).
- Activity component derives reversal eligibility from loaded
  reversal rows so an in-flight double-click cannot show a stale
  Reverse action.

## Sprint 5.4.2 — Atomic Warehouse Transfer Reversal (2026-02, delivered)

### Problem
Codex identified a P1 inventory-integrity bug: a warehouse transfer
lands as two ledger rows (`TRANSFER_OUT` + `TRANSFER_IN`) that share
`reference_type='transfer'` + a `reference_id`, but the existing
`reversal` path only inverted whichever row the caller pointed at. The
frontend also exposed the reversal action on `transfer_out` only, so a
paired reversal from the UI reliably left the destination-side
`TRANSFER_IN` intact. Result: source balance restored, destination
balance still credited — stock effectively duplicated.

### Solution
**Backend (`apps/api/app/services/inventory.py`)**
- Inspected the existing transfer creation flow (`InventoryService.transfer`)
  and confirmed that both ledger rows are already atomically linked by
  `reference_type='transfer'` + a common `reference_id` set inside a single
  DB transaction. `reversal()` now determines and reuses this existing
  canonical transfer linkage (reference_id or equivalent) after inspecting
  the transfer creation flow; a new linkage would only be introduced if
  none currently existed — none was needed, so no DB migration ships.
- Locates the partner row via that linkage, asserts same-org + non-CLOSED
  counterpart, and refuses (`transfer_pair_incomplete` /
  `transfer_pair_cross_org` / `warehouse_closed_no_writes`) rather than
  half-reverse.
- Posts inverse ledger rows AND `REVERSAL` markers on BOTH sides
  inside the caller's DB transaction. Any failure (`insufficient_stock`
  on the destination, integrity violation, etc.) rolls back the whole
  operation and leaves both warehouse balances unchanged.
- Idempotency-Key discipline preserved (keyed on the caller-selected
  lot); the partial unique index still enforces exactly-once semantics
  for the request as a whole.
- Reversing either OUT or IN reaches the same atomic outcome.

**Frontend (`apps/web/components/inventory-items/inventory-item-activity.tsx`)**
- Exactly one reversal entry point: the canonical `transfer_out` row
  now shows a `Reverse transfer` action. The paired `transfer_in`
  row remains unreversible.
- Single backend request per user click (the service fans out to both
  sides).

### Tests
- `apps/api/tests/test_sprint_4_inventory.py` (Sprint 5.4.2 block):
  paired reversal via OUT, paired reversal via IN, idempotent replay,
  already-reversed guard blocks re-reversal from either side, and a
  Postgres-only rollback test asserting the source balance stays put
  when reversing would drive the destination negative.
- `apps/web/tests/stock-operations.test.tsx` (Sprint 5.4.2 block):
  the reversal action is exposed on `transfer_out` only; a click
  fires exactly one POST to the source warehouse endpoint.

### Branch / commit
- Branch: `feature/sprint-5-4-2-atomic-transfer-reversal`
- Commit: `fix(inventory): reverse warehouse transfers atomically`
- Awaiting engineering review.

## Sprint 5.4.3 — Atomic Transfer Reversal Hardening (2026-02, delivered)

### Problem
Codex review of Sprint 5.4.2 flagged two P1 gaps in the atomic transfer
reversal path:

1. `reversal()` still fell back to the generic single-row reversal when
   a `TRANSFER_OUT` / `TRANSFER_IN` row had missing or malformed
   canonical linkage. A tampered pair could therefore be half-reversed.
2. Authorization only covered the source warehouse; the reversal also
   writes to the counterpart warehouse, so a caller could mutate a
   scope they were never authorized against.

### Solution
**Backend `apps/api/app/services/inventory.py`**
- `reversal()` now unconditionally treats `TRANSFER_OUT` / `TRANSFER_IN`
  as paired. Missing `reference_type='transfer'` or `reference_id` →
  `transfer_pair_incomplete`, no writes.
- Pair validation before any write: exactly two rows, exactly one OUT
  + one IN, same organization, same item, same unit, same quantity,
  partner warehouse resolvable, non-CLOSED, distinct from source, and
  partner lot belongs to partner warehouse. Each violation surfaces a
  distinct diagnostic code (`transfer_pair_item_mismatch`,
  `transfer_pair_quantity_mismatch`, `transfer_pair_unit_mismatch`,
  `transfer_pair_cross_org`, `transfer_pair_warehouse_mismatch`,
  `transfer_pair_lot_mismatch`, `warehouse_closed_no_writes`).
- New helper `InventoryService.resolve_reversal_scopes()` enumerates
  every `(organization_id, farm_id)` scope that must pass authorization
  for a reversal request.

**Backend `apps/api/app/api/v1/endpoints/inventory.py`**
- `reverse_stock` now enforces `_enforce_prod_permission` for every
  scope returned by `resolve_reversal_scopes()` — source AND
  counterpart — BEFORE opening the write transaction.

### Tests (`apps/api/tests/test_sprint_4_inventory.py`)
New Sprint 5.4.3 block (16 tests):
- Corrupted linkage: missing `reference_type`, missing `reference_id`,
  unknown `reference_id`.
- Invalid topology: two OUT rows, two IN rows.
- Attribute mismatches: item, quantity, unit, cross-org, partner
  warehouse resolves to source (topology).
- Authorization: farm_manager scoped to source-only cannot reverse a
  cross-farm transfer; same for destination-only.
- Idempotency: no duplicate inverse / marker rows on same-key replay,
  fresh key after successful reversal, or attempt via opposite side.
- Audit integrity: exactly 4 rows added (2 inverse + 2 markers),
  markers point at OUT and IN via `reverses_transaction_id`,
  organization-total inventory unchanged before / after.
- Postgres-only rollback: on `insufficient_stock`, ledger row count
  unchanged, no inverse rows, no reversal markers, org-total unchanged.

Full test posture: 53 pass (was 38) + 4 Postgres-only skips.

### Frontend
No functional changes required — the single-entry-point UX shipped in
Sprint 5.4.2 already conforms to the hardened backend contract.

### Files modified
- `apps/api/app/services/inventory.py` (hardened `reversal()`, added
  `resolve_reversal_scopes()`).
- `apps/api/app/api/v1/endpoints/inventory.py` (dual-scope
  authorization).
- `apps/api/tests/test_sprint_4_inventory.py` (Sprint 5.4.3 test block).

### Invariants introduced
- A `TRANSFER_OUT` / `TRANSFER_IN` ledger row NEVER traverses the
  single-row reversal path; the linkage is a hard prerequisite.
- Reversal authorization always covers every warehouse that receives
  a ledger write.
- Any refused paired reversal is a perfect no-op — zero rows written
  in the ledger, no marker, no inverse, org-total inventory
  unchanged.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): harden atomic transfer reversal
  (Sprint 5.4.3)`
- Local validation only — no push, no PR per sprint brief.


## Sprint 5.4.4 — Symmetric Lot and Tenant Validation (2026-02, delivered)

### Problem
Codex flagged one remaining P1 gap in atomic transfer reversal: the
Sprint 5.4.3 hardening validated the transfer *pair* but not the
symmetric lot / item / organization relationships on each side. A
tampered ledger row whose `lot_id`, `item_id`, or `organization_id`
disagreed with its warehouse could reach `_post_ledger` — or, worse,
cause `resolve_reversal_scopes()` to enumerate an authorization scope
derived from a cross-tenant relationship.

### Solution
**Backend `apps/api/app/services/inventory.py`**
- New helper `_validate_reversal_original(original, warehouse)` runs
  before *any* scope derivation or write. It verifies
  `original.warehouse_id == request warehouse.id`,
  `original.organization_id == warehouse.organization_id`,
  `original_lot.warehouse_id == warehouse.id`,
  `original_lot.item_id == original.item_id`, and
  `item.organization_id == warehouse.organization_id`. Every failure
  raises a distinct diagnostic
  (`transfer_original_org_mismatch`,
  `transfer_original_lot_warehouse_mismatch`,
  `transfer_original_lot_item_mismatch`,
  `transfer_original_item_org_mismatch`) with no writes.
- New helper `_validate_paired_transfer(original, warehouse, item)`
  consolidates all partner-side symmetric checks (topology, org, item,
  unit, quantity, partner warehouse resolvable / distinct / non-CLOSED,
  partner lot binds to partner warehouse, partner lot references the
  partner tx's item, partner item lives in the same org, and the
  original and partner items are the same canonical item). New
  diagnostic codes: `transfer_partner_lot_item_mismatch`,
  `transfer_partner_item_org_mismatch` (existing codes retained for
  the topology / pair-level checks).
- `resolve_reversal_scopes()` and `reversal()` now both run
  `_validate_reversal_original` upfront, and (for TRANSFER_OUT / IN)
  `_validate_paired_transfer` before locking lots. The endpoint's
  dual-scope authorization cannot receive a partner scope derived
  from a malformed row — the resolver refuses first.
- Post-lock defensive re-check in `reversal()` confirms the locked
  lot state still matches the tx it was validated against.

### Tests (`apps/api/tests/test_sprint_4_inventory.py`)
Sprint 5.4.4 block (9 tests):
- Original tx points at a lot in another warehouse / farm / org.
- Original tx's `item_id` diverges from its lot's `item_id`.
- Partner tx's `item_id` diverges from its lot's `item_id` (two
  fixtures — cross-check via original-side path AND direct
  partner-side path).
- Original tx's `organization_id` diverges from the warehouse's org.
- Partner tx's `organization_id` diverges from the warehouse's org.
- Authorization resolver rejects malformed linkage BEFORE returning
  scopes (verified by observing 409 on the corruption diagnostic even
  when the caller lacks counterpart-scope authorization).

Each failure case asserts the full no-op invariant suite: request
rejected, both lot balances unchanged, org-wide inventory total
unchanged (DB-level SUM), ledger row count unchanged, inverse row
count unchanged, reversal-marker count unchanged, and no audit rows
attributed to the wrong tenant. Cross-tenant assertions use a
direct DB SUM so a source-side caller can still verify the OTHER
org's inventory did not move.

Full test posture: 62 pass in `test_sprint_4_inventory.py` (was 53)
+ 4 Postgres-only skips. Full API suite: 241 pass, 33 skipped.

### Frontend
No functional changes — the existing single-entry-point UX still
matches the hardened backend contract. Frontend `vitest`: 28 pass.

### Files modified
- `apps/api/app/services/inventory.py` (two new symmetric-validation
  helpers; `resolve_reversal_scopes` and `reversal` rewritten to use
  them; post-lock defensive re-check).
- `apps/api/tests/test_sprint_4_inventory.py` (Sprint 5.4.4 test
  block + DB-level `_sum_org_inventory`).
- `memory/PRD.md`.

### New invariants
- Every reversal — transfer or not — validates
  `tx.warehouse_id / lot_id / item_id / organization_id` against the
  loaded warehouse, lot, and item before any write is attempted.
- `resolve_reversal_scopes()` never derives an authorization scope
  from a malformed or cross-tenant relationship.
- A refused reversal is a perfect no-op across BOTH participating
  organizations: zero rows written, no marker, no inverse, org-total
  inventory unchanged on either side.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): symmetric lot & tenant validation
  (Sprint 5.4.4)`
- Local validation only — no push, no PR per sprint brief.


## Sprint 5.4.5 — Farm Consistency + Race-Safe Transfer Reversal (2026-02, delivered)

### Problem
Two P1 gaps remained after Sprint 5.4.4:
1. Farm-consistency was not enforced on either transfer side —
   `original.farm_id` / `partner.farm_id` were never compared against
   the owning warehouse. A tampered `farm_id` would silently move
   authorization scope across farms.
2. Validation ran against UNLOCKED ledger rows. Between the
   pre-lock validation and the write phase a concurrent UPDATE
   could rewrite `farm_id` / `item_id` / `reference_id` etc.,
   letting a partial reversal escape past the invariants under
   PostgreSQL READ COMMITTED.

### Solution
**Backend `apps/api/app/repositories/inventory.py`**
- New `InventoryTransactionRepository.get_by_id_for_update(tx_id)`
  emits `SELECT ... FOR UPDATE` with `populate_existing=True` so
  the identity map refreshes from the LOCKED authoritative state.

**Backend `apps/api/app/services/inventory.py`**
- New helper `_acquire_reversal_context()` — the race-safe backbone.
  Locking sequence (Pattern A, deterministic):
  1. `SELECT ... FOR UPDATE` the target transaction.
  2. If it is a `TRANSFER_OUT` / `TRANSFER_IN` row, enumerate the
     pair via `reference_id` (unlocked list read).
  3. Sort the two transaction ids ascending, then
     `SELECT ... FOR UPDATE` each in that order — deterministic
     ordering eliminates the AB / BA deadlock between two callers
     targeting opposite sides.
  4. Re-fetch the locked rows via `get_by_id_for_update`
     (populate_existing) so the identity map holds the AUTHORITATIVE
     locked state; re-verify `reference_type` / `reference_id`
     still match between OUT and IN — a discrepancy raises
     `transfer_pair_changed_during_reversal`.
  5. Run `_validate_reversal_original` + `_validate_paired_transfer`
     against the locked rows. If ANYTHING changed since step (2),
     validation refuses with the relevant diagnostic and no writes
     are attempted.
- Both `resolve_reversal_scopes()` and `reversal()` now route
  through `_acquire_reversal_context()`. The endpoint's dual-auth
  scope enumeration and the write phase share the SAME locked
  state (locks persist for the outer request transaction).
- Added farm-consistency checks:
  - `_validate_reversal_original`: `original.farm_id != warehouse.farm_id`
    → `transfer_original_farm_mismatch`.
  - `_validate_paired_transfer`: `partner.farm_id != partner_warehouse.farm_id`
    → `transfer_partner_farm_mismatch`.

### Exact locking sequence
```
BEGIN TRANSACTION (per HTTP request, managed by DBSession dependency)

  # Endpoint: resolve_reversal_scopes()
  SELECT ... FOR UPDATE  inventory_transactions WHERE id = :target_tx
  SELECT                 inventory_transactions WHERE reference_type='transfer'
                                                 AND reference_id = :ref
  -- deterministic order:
  SELECT ... FOR UPDATE  inventory_transactions WHERE id = MIN(target, partner)
  SELECT ... FOR UPDATE  inventory_transactions WHERE id = MAX(target, partner)
  -- validate; derive scopes.

  # Endpoint: enforce permission on each returned scope.

  # Endpoint: reversal()
  -- context re-hydrates from the identity map (locks still held).
  SELECT ... FOR UPDATE  inventory_lots WHERE id = MIN(src_lot, dst_lot)
  SELECT ... FOR UPDATE  inventory_lots WHERE id = MAX(src_lot, dst_lot)
  -- defensive post-lock re-check of lot ↔ tx invariants.
  INSERT inventory_transactions ...  (inverse source-side)
  INSERT inventory_transactions ...  (inverse partner-side)
  INSERT inventory_transactions ...  (REVERSAL marker source)
  INSERT inventory_transactions ...  (REVERSAL marker partner)

COMMIT
```

### New diagnostics
- `transfer_original_farm_mismatch`
- `transfer_partner_farm_mismatch`
- `transfer_pair_changed_during_reversal`

### PostgreSQL concurrency-test design
Three `_postgres_only` tests in `apps/api/tests/test_sprint_4_inventory.py`:

1. `test_reversal_serialises_concurrent_writers_on_same_pair`
   Fires two `asyncio.gather` reversal calls on the same OUT row
   with different idempotency keys. FOR UPDATE serialises them:
   exactly one wins (201), the other refuses (`already_reversed`).
   Ledger row count = baseline + 4 (one paired reversal executed).

2. `test_reversal_serialises_concurrent_writers_via_opposite_sides`
   Same, but caller A targets OUT and caller B targets IN.
   Deterministic ORDER BY tx.id ASC lock acquisition prevents the
   classic AB / BA deadlock. Exactly one wins.

3. `test_reversal_detects_relationship_change_between_read_and_lock`
   A "mutator" coroutine holds FOR UPDATE on the partner tx,
   rewrites its `farm_id`, then commits. Concurrently the API
   reversal request blocks on that lock; once the mutator commits
   the API re-reads the (now-corrupted) row under its own lock and
   refuses with `transfer_partner_farm_mismatch`. Zero-write
   invariant asserted.

These tests exercise real DB-level lock semantics and MUST NOT be
skipped in Postgres CI.

### Files modified
- `apps/api/app/repositories/inventory.py`
- `apps/api/app/services/inventory.py`
- `apps/api/tests/test_sprint_4_inventory.py`
- `memory/PRD.md`

### Test results
- `apps/api/tests/test_sprint_4_inventory.py`: 64 pass (was 62) +
  7 Postgres-only skips (was 4).
- Full API suite: 243 pass, 36 skipped, 0 failures.
- Frontend `vitest`: 28 pass (unchanged).
- Ruff check + format: clean on modified files.

### New invariants
- Every reversal — transfer or not — validates
  `tx.farm_id == warehouse.farm_id` (in addition to the earlier
  organization / lot / item / warehouse symmetry).
- Both transfer transaction rows are held under
  `SELECT ... FOR UPDATE` (deterministic order) from before any
  scope enumeration through commit. Concurrent UPDATEs to the
  pair's relationship columns cannot slip between validation and
  write.
- A paired reversal is inventory-neutral across BOTH warehouses:
  `SUM(balance)` unchanged before / after.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): farm consistency + race-safe transfer
  reversal (Sprint 5.4.5)`
- Local validation only — no push, no PR per sprint brief.


## Sprint 5.4.6 — Deterministic Pair Locking + Fully Locked Auth State (2026-02, delivered)

### Problem
Sprint 5.4.5 already ordered `SELECT … FOR UPDATE` by ascending
`tx.id`, but the caller's own target transaction row was locked
FIRST — before the pair was discovered. Under PostgreSQL, two
concurrent reversals targeting opposite ends of the same transfer
pair therefore acquired their locks in opposite orders and could
deadlock (`ProcessA locks OUT then IN; ProcessB locks IN then OUT`).
Additionally, authorization and relationship validation still ran
against ORM entities loaded WITHOUT `FOR UPDATE` (the endpoint
resolved the caller warehouse and, indirectly, the item + partner
warehouse from unlocked reads), so a concurrent `UPDATE` could
change `warehouse.farm_id` / `item.organization_id` between
authorization and write.

### Design
`_acquire_reversal_context` was rebuilt around a strictly
"never lock a caller-selected row before the pair is ordered"
sequence:

1. **Unlocked probe.** Read the target transaction row with plain
   `get_by_id` — solely to learn its `transaction_type` and, for
   transfers, its `reference_id`. NO `FOR UPDATE` yet.
2. **Unlocked pair enumeration** via
   `list_by_reference("transfer", reference_id)`; enforce that
   exactly two `TRANSFER_OUT`/`TRANSFER_IN` rows exist.
3. **Bulk deterministic transaction lock.**
   `list_by_ids_for_update(sorted([out.id, in.id]))` — a single
   `SELECT … WHERE id IN (…) ORDER BY id ASC FOR UPDATE`. Both
   racers contend for the SAME lowest-id row first. Deadlock-free.
4. **Post-lock relationship revalidation.** `reference_type`,
   `reference_id`, and the caller's `warehouse_id` must still
   match under lock — any concurrent `UPDATE` between step (2)
   and step (3) trips `transfer_pair_changed_during_reversal`.
5. **Bulk deterministic warehouse lock.**
   `warehouse_repo.list_by_ids_for_update(sorted(wh_ids))`.
   Authorization scopes (`(organization_id, farm_id)`) are
   derived EXCLUSIVELY from these locked rows, never from the
   endpoint's pre-lock warehouse ORM object.
6. **Bulk deterministic item lock.**
   `item_repo.list_by_ids_for_update(sorted(item_ids))`.
7. **Bulk deterministic lot lock.**
   `lot_repo.list_by_ids_for_update(sorted(lot_ids))`. The write
   phase re-uses these already-locked rows — no additional lot
   lock is issued downstream.
8. **Full symmetric + farm + pair validation** against the fully
   locked context; assertions confirm the locked entities and the
   validation helpers' identity-mapped entities are the SAME rows.

### New repository methods
| Repository | Method |
| --- | --- |
| `WarehouseRepository` | `list_by_ids_for_update(ids)` |
| `InventoryItemRepository` | `list_by_ids_for_update(ids)` |
| `InventoryLotRepository` | `list_by_ids_for_update(ids)` |
| `InventoryTransactionRepository` | `list_by_ids_for_update(ids, org_ids=None)` |

All four issue `SELECT … WHERE id IN (:ids) ORDER BY id ASC
FOR UPDATE`, use `populate_existing()` so the identity map
adopts the locked row, and are the ONLY sanctioned way to
acquire the reversal-path row locks.

### Test-only instrumentation on `InventoryService`
Two class-level hooks (both default `None` in production):

- `_reversal_lock_barrier` — an `asyncio.Event` the service
  awaits AFTER unlocked pair-discovery and BEFORE the bulk
  transaction lock. Two racers can register the same event,
  finish discovery independently, then race for the bulk lock
  simultaneously.
- `_reversal_after_warehouse_locks_signal` — an `asyncio.Event`
  the service `.set()`s immediately AFTER the bulk warehouse
  `FOR UPDATE` completes. Mutation-race tests wait on this
  signal so their competing `UPDATE` fires only when the
  reverser is provably holding the warehouse row locks.

### Postgres-only concurrency proofs (test_sprint_4_inventory.py)
| Test | What it proves |
| --- | --- |
| `test_reversal_deterministic_opposite_side_barrier` | Two HTTP reversals targeting OUT and IN sides simultaneously never deadlock — bulk-sorted lock acquisition serialises to `[201, 409]`. |
| `test_reversal_blocks_concurrent_warehouse_farm_mutation` | With reverser holding warehouse FOR UPDATE, a mutating `UPDATE warehouses SET farm_id = …` blocks; reversal audit rows are sealed with the ORIGINAL farm ids. |
| `test_reversal_blocks_concurrent_item_org_mutation` | With reverser holding item FOR UPDATE, a mutating `UPDATE inventory_items SET organization_id = …` blocks; reversal REVERSAL rows are sealed with the ORIGINAL organization_id. |
| `test_reversal_uses_locked_warehouse_state_for_authz` | Even if the caller's warehouse row was updated to a different farm between HTTP dispatch and the reversal transaction, authorization is decided against the LOCKED post-`FOR UPDATE` state. |

All eleven `@_postgres_only` concurrency tests in this file
skip cleanly on SQLite (`sqlite+aiosqlite:///:memory:`) and
pass under PostgreSQL 15.

### Validation
- `ruff check apps/api/app/repositories/inventory.py apps/api/app/services/inventory.py apps/api/tests/test_sprint_4_inventory.py` — clean.
- **SQLite**: `pytest -q apps/api/tests/test_sprint_4_inventory.py` — `64 passed, 11 skipped` (all Postgres-only tests skip cleanly).
- **PostgreSQL 15** (`postgresql+asyncpg://…/agrovix_test`):
  - `pytest -q apps/api/tests/test_sprint_4_inventory.py` — `75 passed`.
  - `pytest -q apps/api/tests/` (full backend suite) — `260 passed, 23 skipped` (skips are live-API / SPRINT4_API_BASE suites).

### Guarantees now enforced
- No lock is ever acquired before the transfer pair has been
  fully enumerated and its ids sorted. Deterministic acquisition
  order across transactions, transaction rows, warehouses,
  items, and lots eliminates the opposite-side deadlock.
- Authorization scopes are derived from the LOCKED warehouse
  rows returned by `list_by_ids_for_update`, never from the
  endpoint's initially resolved ORM entity.
- Item / warehouse `organization_id` and `farm_id` used for
  audit rows and inverse ledger entries come from LOCKED rows —
  a concurrent `UPDATE` cannot slip in between authorization
  and write.
- A paired reversal remains inventory-neutral across both
  warehouses and produces exactly 4 rows (2 inverse + 2 REVERSAL
  markers) or zero rows on refusal.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): deterministic pair locking (Sprint 5.4.6)`
- Local validation only — no push, no PR per sprint brief.


## Sprint 5.4.7 — Serialized Transfer Topology + Full Authorization Locking (2026-02, delivered)

### Problem
Sprint 5.4.6 already row-locked the two participating transactions
of a transfer pair in ascending id order, closing the opposite-side
deadlock. But under PostgreSQL READ COMMITTED there remained two
unclosed holes:

1. **Topology serialization.** A concurrent `INSERT` (or a hostile
   `UPDATE` re-parenting an unrelated row) could still add a THIRD
   transaction into the same logical transfer identity between our
   unlocked discovery step and the write phase. Row-level locks on
   two rows do not prevent a NEW row appearing.
2. **Farm + organization authoritative state.** Authorization ran
   against warehouse ORM entities that carried `farm_id` /
   `organization_id`, but the referenced `farms` / `organizations`
   rows themselves were never locked. A concurrent `UPDATE` to
   `farm.organization_id`, `farm.is_active`, `farm.deleted_at`,
   `organization.is_active`, or `organization.deleted_at` could
   slip between authorization and write.

### Design
#### Advisory-lock key
Deterministic PostgreSQL transaction-scoped advisory lock keyed on
the LOGICAL transfer identity:

```
canonical = f"inventory-transfer:{organization_id}:{reference_type}:{reference_id}"
digest    = SHA-256(canonical)          # 32 bytes
key64     = int.from_bytes(digest[:8], big-endian, unsigned)
signed    = key64 - 2**64 if key64 >= 2**63 else key64  # PG BIGINT
```

Emitted as `SELECT pg_advisory_xact_lock(:key)`. Transaction-scoped
(released automatically at commit / rollback), deterministic,
independent of Python's `hash()`, ~2^32 identities before birthday
collision (a collision would merely serialise two unrelated
transfers, never corrupt state). No-op on SQLite (StaticPool
already serialises writers).

Helper module: `apps/api/app/services/_transfer_locks.py` exposes
`advisory_lock_key_for_transfer(org, ref_type, ref_id)` and
`acquire_transfer_advisory_lock(session, ...)`.

#### Code paths using the advisory lock
| Path | When acquired |
| --- | --- |
| `InventoryService.transfer()` — creates TRANSFER_OUT + TRANSFER_IN | Immediately after `transfer_ref = uuid4()`; BEFORE either row is inserted. |
| `InventoryService._acquire_reversal_context()` — reversal of a transfer | Immediately after the unlocked probe reads `reference_id` from the target; BEFORE any FOR UPDATE. |

Both writers thus contend for the SAME key. No topology mutation
for `(organization_id, "transfer", reference_id)` can occur while
any writer holds the lock.

#### Deterministic lock order (final, `_acquire_reversal_context`)
1. **Unlocked probe** of the target transaction (`tx_repo.get_by_id`).
2. **Test barrier hook** (`_reversal_lock_barrier`) — a two-party
   sync point placed BEFORE the advisory lock so both racers reach
   the advisory-lock boundary before either acquires it.
3. **Advisory lock** on `(organization_id, "transfer", reference_id)`.
4. **Re-read target** post-advisory (`get_by_id`) and verify
   `reference_id` unchanged; refuse `transfer_topology_changed`
   otherwise.
5. **Unlocked topology enumeration** (`list_by_reference("transfer", ref_id)`).
   Refuse `transfer_topology_malformed` unless exactly one
   TRANSFER_OUT + one TRANSFER_IN exists.
6. **Bulk FOR UPDATE** on the two transaction ids, sorted ASC.
7. **Post-lock relationship revalidation** — refuse
   `transfer_pair_changed_during_reversal` on any drift.
8. **Repeat topology enumeration under lock** — belt-and-braces
   check for a pre-existing malformed row.
9. **Bulk FOR UPDATE** on the two warehouse ids, sorted ASC.
10. **Bulk FOR UPDATE** on the referenced farm ids, sorted ASC.
    Refuse `transfer_farm_deleted` / `transfer_farm_inactive`.
11. **Bulk FOR UPDATE** on the owning organization id.
    Refuse `transfer_organization_deleted` /
    `transfer_organization_inactive`.
12. **Farm ⟷ Org ⟷ Warehouse invariants** —
    `transfer_farm_organization_mismatch` /
    `transfer_warehouse_farm_mismatch`.
13. **Bulk FOR UPDATE** on the referenced item ids, sorted ASC.
    Refuse `transfer_item_organization_mismatch`.
14. **Bulk FOR UPDATE** on the referenced lot ids, sorted ASC.
15. **Full symmetric + farm + pair validation** against the fully
    locked context.
16. **Return locked context** carrying the LOCKED original / partner
    transactions, warehouses, farms, organization, items, lots, and
    the authorization scopes derived EXCLUSIVELY from the locked
    state.

Authorization (via `resolve_reversal_scopes`) is decided AFTER
every lock is held and every validation has passed; scopes come
only from `context["scopes"]` which are derived from the locked
warehouse rows.

#### New repository methods
| Repository | Method (Sprint 5.4.7 additions) |
| --- | --- |
| `FarmRepository` | `list_by_ids_for_update(ids)` — includes soft-deleted |
| `OrganizationRepository` | `list_by_ids_for_update(ids)` — includes soft-deleted |

Both use `WHERE id IN (:ids) ORDER BY id ASC FOR UPDATE` +
`populate_existing()`. Soft-deleted rows are DELIBERATELY
included: the reversal path must observe `deleted_at` under the
lock to refuse with the correct diagnostic.

#### New error diagnostics (all 409)
`transfer_topology_changed`, `transfer_topology_malformed`,
`transfer_organization_inactive`, `transfer_organization_deleted`,
`transfer_farm_inactive`, `transfer_farm_deleted`,
`transfer_farm_organization_mismatch`,
`transfer_warehouse_farm_mismatch`,
`transfer_item_organization_mismatch`.
Existing codes preserved: `transfer_pair_changed_during_reversal`,
`already_reversed`.

#### PostgreSQL test infrastructure
Two new class-level test hooks on `InventoryService` (default
`None` in production):

- `_reversal_after_farm_org_locks_signal` — set immediately after
  the bulk FOR UPDATE on farm rows AND the org row completes.
  Farm / org mutation-race tests wait on this before firing.
- `_reversal_hold_after_farm_org_locks_gate` — the reverser awaits
  this event AFTER signalling farm+org locks are held and BEFORE
  proceeding. Tests use this to keep the reverser transaction OPEN
  (still holding every lock) while asserting a competing UPDATE is
  genuinely blocked (`mut_task.done() is False`).

Plus a bounded two-party barrier utility in the test module
(`_TwoPartyBarrier` — counter + `asyncio.Condition`) so proofs of
"both racers reached the same synchronization point before either
continued" no longer rely on plain `asyncio.Event`.

### Locked-context structure
```python
{
    "original":       InventoryTransaction,  # locked
    "warehouse":      Warehouse,             # locked
    "item":           InventoryItem,         # locked
    "original_lot":   InventoryLot,          # locked
    "partner":        InventoryTransaction,  # locked
    "partner_warehouse": Warehouse,          # locked
    "partner_item":   InventoryItem,         # locked
    "partner_lot":    InventoryLot,          # locked
    "organization":   Organization,          # locked
    "original_farm":  Farm | None,           # locked
    "partner_farm":   Farm | None,           # locked
    "scopes":         list[(org_id, farm_id | None)],  # from locked rows
}
```

### Files modified
- `apps/api/app/services/_transfer_locks.py` (new)
- `apps/api/app/services/inventory.py`
- `apps/api/app/repositories/org_repo.py`
- `apps/api/app/api/v1/endpoints/inventory.py`
- `apps/api/tests/test_sprint_4_inventory.py`
- `memory/PRD.md`

### Validation
- `ruff check` — clean on all modified files.
- **SQLite** (`sqlite+aiosqlite:///:memory:`)
  `pytest -q apps/api/tests/test_sprint_4_inventory.py` →
  **65 passed, 18 skipped** (Postgres-only concurrency proofs
  skip cleanly).
- **PostgreSQL 15** (`postgresql+asyncpg://.../agrovix_test`)
  - `pytest -q apps/api/tests/test_sprint_4_inventory.py` →
    **83 passed** (75 pre-existing + 8 Sprint 5.4.7 additions:
    advisory-key determinism, pre-existing 3-row rejection,
    reference-mutation blocking on advisory lock, org
    deactivation blocking, org deletion pre-refusal, farm
    deactivation blocking, farm deletion pre-refusal,
    two-party-barrier opposite-side race).
  - `pytest -q apps/api/tests/` (full backend suite) →
    **268 passed, 23 skipped** (skips are live-API `:8055`
    suites requiring a running server).

### Guarantees now enforced
- **Topology serialisation.** No writer can add / remove / mutate
  a row into a transfer identity while any other writer holds the
  advisory lock on that identity. Under-lock topology re-checks
  refuse `transfer_topology_malformed` on any pre-existing
  malformed state.
- **Full authoritative locking.** Farm, organization, warehouse,
  item, and lot rows are all held FOR UPDATE before authorization
  or validation runs. A concurrent UPDATE to
  `farm.organization_id`, `is_active`, `deleted_at`, or the
  organization equivalents blocks on our lock and cannot slip
  between authorization and write.
- **Authorization from locked state only.** Scopes returned by
  `resolve_reversal_scopes` are derived exclusively from the
  locked warehouse / farm / organization rows. Pre-lock ORM
  entities are never used for permission decisions.
- **Zero-write refusal.** Every rejection path returns 409 (or
  the pre-existing 403 for authorization failures) with a distinct
  diagnostic code AND asserts unchanged `_count_tx_rows` /
  `_count_inverse_rows` / `_count_reversal_markers` /
  `_sum_org_inventory` in tests.
- **Non-transfer reversals unaffected.** Single-row reversals for
  RECEIPT / ISSUE / CONSUMPTION / ADJUSTMENT_* still use the
  simple locked path — no advisory lock, no farm/org lock, no
  regression.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): serialized transfer topology + full authorization locking (Sprint 5.4.7)`
- Local validation only — no push, no PR per sprint brief.


## Sprint 5.4.8 — Single Deterministic Locking Model + DB Topology Enforcement (2026-02, delivered)

### Problem
Sprint 5.4.7 closed topology drift under the ADVISORY lock, but:

1. Transfer CREATION still locked source and destination lots
   SEQUENTIALLY (`_lock_lot(src)` then `_get_or_create_lot_safe`
   for dst). Under a real A→B / B→A race the lock order was
   request-direction-dependent and PostgreSQL detected a genuine
   AB/BA deadlock, surfacing to the API as an unhandled DBAPI
   error.
2. The advisory-lock key was derived from the MUTABLE tuple
   `(organization_id, reference_type, reference_id)` read from an
   unlocked transaction row. A concurrent UPDATE of tenant fields
   would change the key. Two writers could then serialise on
   DIFFERENT keys for the same topology.
3. Non-transfer reversals (`RECEIPT`, `ISSUE`, `ADJUSTMENT_*`,
   `CONSUMPTION`) locked only the transaction, warehouse, item,
   and lot rows — org and farm rows were never locked. A
   concurrent org/farm mutation could slip between authorization
   and write.
4. Unsafe destructuring (`[row] = repo.list_by_ids_for_update([id])`)
   raised `ValueError` on 0 or ≥ 2 rows, producing 500s rather
   than controlled domain errors.
5. Topology invariants ("exactly one OUT and one IN per transfer
   identity", "transfer identity never changes") were enforced
   only in application code. Raw SQL could bypass them.

### Design

#### New immutable transfer identity column
`inventory_transactions.transfer_group_id UUID NULL` (indexed) —
assigned once at transfer creation, NEVER updateable. Immutability
enforced by a PostgreSQL `BEFORE UPDATE` trigger
(`trg_inventory_tx_group_immutable`) that raises
`integrity_constraint_violation` if a non-NULL value is changed.
Migration 0009 installs the column, backfills it from
`reference_id` for pre-existing transfer pairs, and creates the
trigger. The trigger is ALSO installed automatically by
`Base.metadata.create_all` via a SQLAlchemy DDL event so the
hermetic Postgres test path observes the same enforcement without
running migrations.

#### DB topology constraint
Partial unique index `uq_inventory_tx_transfer_role` on
`(transfer_group_id, transaction_type)` WHERE
`transfer_group_id IS NOT NULL AND transaction_type IN
('transfer_out', 'transfer_in')`. Enforces at most one
`TRANSFER_OUT` and one `TRANSFER_IN` per group at the DB layer —
any INSERT / UPDATE that would produce a duplicate is rejected
with a raw `IntegrityError`.

#### New advisory-lock key derivation
`advisory_lock_key_for_transfer_group(transfer_group_id) → int`
in `apps/api/app/services/_transfer_locks.py`:

```
canonical = f"inventory-transfer-group:{transfer_group_id}"
digest    = SHA-256(canonical)
key64     = int.from_bytes(digest[:8], 'big', unsigned)
signed    = key64 - 2**64 if key64 >= 2**63 else key64
```

Emitted as `SELECT pg_advisory_xact_lock(:key)`. Derived solely
from the IMMUTABLE `transfer_group_id` — no tenant field
participates. The legacy Sprint 5.4.7 key derivation is retained
as `advisory_lock_key_for_transfer` for the unit test that pins
the exact algorithm.

#### Canonical lock order (creation AND reversal)
1. Immutable transfer serialization key (advisory lock)
2. Transaction IDs (sorted ASC, `FOR UPDATE`)
3. Warehouse IDs (sorted ASC, `FOR UPDATE`)
4. Farm IDs (sorted ASC, `FOR UPDATE`)
5. Organization ID (`FOR UPDATE`)
6. Item IDs (sorted ASC, `FOR UPDATE`)
7. Lot IDs (sorted ASC, `FOR UPDATE`)

`transfer()` now:
* Resolves source lot with plain `get_by_id` (NO `FOR UPDATE`) —
  locking it first would make lock order request-direction-
  dependent.
* Calls `_get_or_create_lot_safe` for destination lot (savepoint
  + insert-or-select, no `FOR UPDATE`).
* Bulk-locks BOTH lots in one query, sorted ASC by id:
  `lot_repo.list_by_ids_for_update(sorted({src.id, dst.id}))`.
  Both racers therefore lock the SAME lowest-id lot first — no
  AB/BA deadlock possible.
* Verifies exact set equality via `require_set_equality`.
* Post-lock re-validates warehouse / item associations
  (`lot_association_changed` on drift).
* Generates `transfer_group_id = uuid4()`, stamps both ledger
  rows, uses it as the advisory-lock key.

#### `_acquire_reversal_context` update
Uses `original_probe.transfer_group_id` (falling back to
`reference_id` for pre-Sprint-5.4.8 rows) as the advisory-lock
key. Non-transfer reversals now ALSO lock the referenced farm
and organization, refusing with the Sprint 5.4.7 diagnostic set
(`transfer_farm_deleted` / `transfer_farm_inactive` /
`transfer_organization_deleted` / `transfer_organization_inactive`)
on any deviation. Uses `require_exactly_one` throughout — no
`ValueError` from destructuring can escape.

#### Safe cardinality helpers
`require_exactly_one(rows, resource, identifier)` — 404 on empty,
409 integrity on duplicates, returns the row on exactly one.
`require_set_equality(rows, resource, requested_ids)` — 409 with
missing + unexpected id lists on mismatch.

### Files modified
- `apps/api/app/models/inventory.py` (new column, partial unique
  index, DDL events installing the immutability trigger)
- `apps/api/alembic/versions/0009_transfer_group_id.py` (new
  migration: column, backfill, partial index, trigger)
- `apps/api/app/services/_transfer_locks.py` (new advisory-key
  function, `require_exactly_one`, `require_set_equality`,
  updated `acquire_transfer_advisory_lock` signature)
- `apps/api/app/services/inventory.py` (bulk lot lock in
  `transfer()`, non-transfer reversal org+farm locking, use of
  the immutable transfer_group_id in `_acquire_reversal_context`,
  `require_exactly_one` throughout, `_post_ledger` accepts
  `transfer_group_id`)
- `apps/api/tests/test_sprint_4_inventory.py` (Sprint 5.4.8 tests
  — SQLite domain proofs and Postgres adversarial tests; updated
  reference-mutation test to use the new key)
- `memory/PRD.md`

### Validation
- `ruff check` — clean on all modified files.
- **SQLite** (`sqlite+aiosqlite:///:memory:`) — non-locking
  coverage: validation, domain-error mapping, topology parsing,
  cardinality helpers, immutable-group-id column presence.
  `pytest -q apps/api/tests/test_sprint_4_inventory.py` →
  **67 passed, 22 skipped**. All Postgres-only concurrency tests
  skip cleanly on SQLite.
- **PostgreSQL 15** — locking, deadlock avoidance, DB constraint
  and trigger enforcement.
  `pytest -q apps/api/tests/test_sprint_4_inventory.py` →
  **89 passed**.
  Adversarial tests included:
  * `test_sprint_5_4_8_opposite_direction_transfers_no_deadlock`
    — real A→B / B→A race, `return_exceptions=True`, asserts no
    `deadlock` string leaks anywhere.
  * `test_sprint_5_4_8_db_constraint_rejects_phantom_transfer_row`
    — raw SQL INSERT that would create a third TRANSFER_OUT in
    the same group is rejected by
    `uq_inventory_tx_transfer_role`.
  * `test_sprint_5_4_8_advisory_key_immutable_under_org_mutation`
    — raw SQL UPDATE of `transfer_group_id` on an existing row
    is rejected by `trg_inventory_tx_group_immutable`.
  * `test_sprint_5_4_8_non_transfer_reversal_missing_lot` —
    soft-deleting the lot before receipt reversal returns a
    controlled 404/409 via `require_exactly_one`, never a
    `ValueError` / 500. Zero writes verified.
  * `test_transfer_reversal_refuses_when_two_out_rows` /
    `test_transfer_reversal_refuses_when_two_in_rows` —
    Sprint 5.4.8 proves the DB partial unique index REJECTS the
    corrupting `UPDATE` at the database layer.
  Full backend suite:
  `pytest -q apps/api/tests/` → **274 passed, 23 skipped**
  (skips are the `:8055` live-API suites).

### Behavioural outcomes (one per required use case)
1. **Normal transfer** — locks org, farms, warehouses, item, lots
   in canonical order under advisory lock; validates all
   associations under lock; posts exactly one topology; balances
   consistent.
2. **Opposite-direction transfers** — verified by
   `test_sprint_5_4_8_opposite_direction_transfers_no_deadlock`.
   No AB/BA deadlock; deterministic outcome; no 500.
3. **Warehouse closure during creation** — warehouse row is
   `FOR UPDATE`'d; closure waits or transfer sees the closed
   status (409 `warehouse_state_forbidden`).
4. **Tenant reassignment** — warehouse row locked; scopes
   derived only from locked rows; stale org/farm scope never used.
5. **Item deletion** — item row locked; deletion waits or
   transfer sees the deleted state and refuses.
6. **Phantom topology insertion** — DB partial unique index
   rejects. Verified.
7. **Transfer reversal** — same canonical lock order as
   creation; advisory key from immutable `transfer_group_id`;
   `transfer_topology_malformed` on any deviation.
8. **Non-transfer reversal** — org + farm locked; missing/
   deleted lot returns controlled 404/409 via
   `require_exactly_one`. Zero writes verified.
9. **Malformed state** — `_integrity_violation` diagnostic
   with 409; never `ValueError` / 500.

### Branch / commit
- Branch: `feature/sprint-5-4-stock-operations-review`
- Commit: `fix(inventory): single deterministic locking model + DB topology enforcement (Sprint 5.4.8)`
- Local validation only — no push, no PR per sprint brief.

