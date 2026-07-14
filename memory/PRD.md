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
