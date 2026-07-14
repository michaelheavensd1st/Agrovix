# Codex Review Gate 01 — findings & remediation

**Branch:** `fix/codex-review-gate-01`
**Base:** `agent/mvp-foundation`
**Audit date:** 2026-02-07
**Scope:** Sprint 0 → Sprint 2 canonical develop tree.

---

## CRG01-1 — Cross-tenant leak on `GET /production-unit-types`

### Finding
The list endpoint accepted an unvalidated `organization_id` query
parameter and returned that organization's custom `ProductionUnitType`
rows regardless of whether the caller was an active member of the
requested organization. A curious client could enumerate custom types
across the entire installation by iterating org UUIDs.

### Severity
**High.** Reveals inventory / operational reference data of foreign
tenants — a direct violation of the tenant-isolation invariant
enforced everywhere else in the API (see
`docs/trusted-proxy.md` and the tenant-404 policy in
`require_permission`).

### Fix
- `ProductionUnitTypeRepository.list_visible` now accepts a **list**
  of `organization_ids` rather than a single query-supplied id. The
  caller is responsible for populating that list with orgs the
  session-authenticated user actually belongs to.
- `GET /production-unit-types` now:
  1. Reads the caller's active `OrganizationMembership` rows.
  2. Intersects the resulting set with the (optional)
     `organization_id` filter. Non-member ids are dropped silently
     rather than 403'd — this preserves the "don't tell outsiders
     which orgs exist" property.
  3. Superusers see all custom types (this is the platform-admin
     escape hatch, documented in the endpoint docstring).
- No changes to `POST /organizations/{id}/production-unit-types` or
  `DELETE /production-unit-types/{id}` — both already validated org
  membership before the fix.

### Regression tests
`tests/test_codex_review_gate_01.py`:
- `test_cross_tenant_custom_unit_type_is_never_returned`
- `test_own_org_custom_unit_type_is_visible`

---

## CRG01-2 — Production-event idempotency

### Finding
`POST /batches/{id}/events` had no idempotency guard. A client that
retries a request after a transient network failure (which is the
common failure mode for mobile & field devices) would silently create
duplicate events. On lifecycle-driving events (`STOCKING`, `HARVEST`)
this compounded the damage by potentially triggering redundant batch
transitions.

### Severity
**High.** Silent operational-log duplication is a data-integrity
issue that cannot be reliably detected post-hoc.

### Fix
Schema (migration `0005_production_event_idempotency`):
- Added `idempotency_key VARCHAR(128) NULL` and
  `payload_hash VARCHAR(64) NULL` columns to `production_events`.
- Added a **partial unique index** on
  `(batch_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
  DB-level enforcement of the invariant.

Service (`ProductionEventService.create`):
- Optional `Idempotency-Key` header, mapped to the new column.
- Pre-insert lookup: existing row with same key + same
  `payload_hash` → **replay** (return existing event; do NOT re-audit
  or retrigger transitions). Same key + different hash → **409
  `idempotency_key_payload_conflict`**.
- Insert is wrapped in `session.begin_nested()` (a Postgres SAVEPOINT)
  so that a concurrent-race `IntegrityError` rolls back only the
  event insertion, not the surrounding audit / transition writes.
- Payload hash is a deterministic SHA-256 over
  `{event_type, data}` with sorted keys — same logical payload from
  two clients hashes identically.

Endpoint (`POST /batches/{id}/events`):
- Reads `Idempotency-Key` header (case-insensitive per HTTP spec).
- Returns **201 Created** on first success, **200 OK** on replay,
  and sets the `X-Idempotent-Replay: true` response header when
  replaying.
- `409` on payload conflict; `422` still returned for schema
  validation failures.

### Atomicity guarantee
Event insertion and any lifecycle transition it drives share a single
request-scoped SQLAlchemy session. Either both commit or the
FastAPI DB dep rolls both back. The SAVEPOINT layer prevents a
concurrent-race exception from corrupting the surrounding request
context.

### Regression tests
`tests/test_codex_review_gate_01.py`:
- `test_same_key_same_payload_returns_replay`
- `test_same_key_different_payload_returns_409`
- `test_missing_header_does_not_activate_idempotency`
- `test_idempotent_stocking_does_not_double_transition`
- `test_concurrent_same_key_produces_exactly_one_event` (Postgres-only)
- `test_idempotent_replay_is_scoped_per_batch`

---

## CRG01-3 — Alembic upgrade-to-head validation

### Finding
The `api-quality` CI job ran pytest against a Postgres service, but
pytest uses `Base.metadata.create_all` in fixtures rather than the
Alembic migration path. As a result, **no CI job verified that the
Alembic migrations actually apply cleanly against a fresh Postgres
database**. A migration that referenced a non-existent column or an
enum name collision would only be caught on deploy.

### Severity
**Medium.** Migration bugs are recoverable but catch them at PR time
rather than during a production rollout.

### Fix
New CI job `alembic-upgrade`:
1. Spins up a dedicated Postgres 16 service.
2. Installs the API's runtime dependencies.
3. Runs `alembic current` (must show `base`).
4. Runs `alembic upgrade head`.
5. Runs `alembic current` again and asserts it equals the output of
   `alembic heads` (guards against multi-head accidents).
6. Runs a **round-trip** `alembic downgrade base && alembic upgrade
   head` to guarantee every migration's `downgrade()` is also valid.

The current head after this audit is
`0005_prod_event_idempotent`.

---

## CRG01-4 — Lockfile hygiene (Yarn → pnpm)

### Finding
The repo shipped a root `yarn.lock` alongside `pnpm-workspace.yaml`.
The Turborepo docs are explicit that the workspace must be
single-lockfile; a stale Yarn lockfile is a footgun that lets
developers install with different versions from CI.

CI also ran `pnpm install --frozen-lockfile=false`, which defeats the
whole point of committing a lockfile — CI would happily churn
dependencies on every run and mask lockfile drift.

### Severity
**Medium.** Not a runtime bug, but a supply-chain integrity risk and
a reproducibility gap.

### Fix
- Removed all tracked `yarn.lock` files.
- Generated a fresh `pnpm-lock.yaml` with `pnpm install --lockfile-only`.
- Updated `.github/workflows/ci.yml`: every `pnpm install` step now
  uses `--frozen-lockfile` (no more `=false`).

The frontend/legacy shim at `/app/frontend` still contains
`node_modules/*/yarn.lock` files bundled inside npm packages — those
are transitive artifacts, not repo-tracked lockfiles, and are not
touched by this fix.

---

## CRG01-7 — Enum label mismatch (alembic vs SQLAlchemy)

### Finding
Discovered during Gate-01 testing-agent verification (iteration_5):
`alembic upgrade head` seeded the Postgres native enums with the
**lowercase enum values** (`'platform'`, `'organization'`, `'farm'`,
`'active'`, `'planned'`, …), but SQLAlchemy's `Enum(<PythonEnum>, …)`
column type defaults to writing the enum **names** (`'PLATFORM'`,
`'ORGANIZATION'`, …). Consequence: a freshly-migrated database
rejected every seed insert with
`invalid input value for enum X: "PLATFORM"`. The pytest suite
passed because `conftest.py` uses `Base.metadata.create_all`, which
regenerates the enum labels from the model.

### Severity
**High.** Silent deploy-time failure: any greenfield staging or
production Postgres would be un-seedable.

### Fix
Passed `values_callable=lambda enum: [m.value for m in enum]` on
every SQLAlchemy `Enum` column so the string label written to the
DB matches the migration:

- `Role.scope` (`role_scope`)
- `Invitation.status` (`invitation_status`)
- `ProductionSite.status` (`production_site_status`)
- `ProductionUnit.status` (`production_unit_status`)
- `ProductionBatch.state` (`production_batch_state`)
- `ProductionBatchTransition.{from,to}_state` (`production_batch_state`)

Verified end-to-end:
```
alembic upgrade head  →  head 0005_prod_event_idempotent
python -c "from app.seed import seed_permissions_and_roles; …"  →  SEED OK
```


## Unresolved limitations

1. **SQLite cannot faithfully model DB-level concurrent
   idempotency races.** The test
   `test_concurrent_same_key_produces_exactly_one_event` is marked
   Postgres-only. Coverage is complete only in the CI Postgres path.
2. **The `pnpm audit` job stays non-blocking (`continue-on-error:
   true`).** This audit did not tighten it — that will land with a
   dedicated security-hardening gate.
3. **Alembic's autogenerate diff** is not part of the new job. Adding
   an "autogenerate produces empty diff on head" guard is a
   worthwhile follow-up but requires a stable base-model comparison
   snapshot that we don't ship yet.

---

## CRG01-5 — Migration lifecycle fixes (Postgres bring-up)

### Finding
While wiring the Alembic-against-real-Postgres validation job we
discovered three latent bugs that would have blocked a fresh install
against Postgres:

1. `sa.Enum(..., name="X")` used both to `.create(op.get_bind())`
   *and* as a `Column("...", enum_type)` type caused SQLAlchemy to
   attempt a second `CREATE TYPE X` when the table was created,
   raising `DuplicateObject`. Fixed by binding the column to a
   `postgresql.ENUM(..., create_type=False)` handle instead.
   Affects: `invitation_status`, `production_site_status`,
   `production_unit_status`, `production_batch_state`.
2. Two revision IDs exceeded the default Alembic `version_num`
   column size (32 chars). Shortened:
   - `0003_verification_active_unique_index` →
     `0003_verify_active_uniq`
   - `0005_production_event_idempotency` →
     `0005_prod_event_idempotent`
3. The pytest `_engine` fixture hardcoded a SQLite URL, so the CI
   Postgres service in `api-quality` was a no-op — pytest silently
   ran against SQLite. Fixed by letting the fixture honour
   `DATABASE_URL` and gating the JSONB→JSON test-only shim on the
   dialect.

### Follow-on race fix
Running the full suite against a real Postgres uncovered a genuine
last-owner orphan race: two concurrent revokes of two *different*
owner assignments could both pass the "≥ 1 owner remaining"
post-check on stale (uncommitted) reads. Fixed by acquiring a
transaction-scoped Postgres advisory lock
(`pg_advisory_xact_lock`) keyed on the organization id in
`OrganizationRepository.lock_owner_set` before any owner-mutating
recount. The lock is a no-op on non-Postgres dialects (SQLite's
serialised writers cover the same invariant).

### Regression coverage
The postgres-only invariant test in `tests/test_concurrency.py`
now runs green under the actual `postgresql+asyncpg` pytest path,
alongside all 85 tests.

---

## CRG01-6 — Frontend build/lint scaffolding

### Finding
The Sprint-2 scaffold had never been driven through the full JS
toolchain against real (production) constraints:

- Prettier picked up ~1400 non-source files (the pod
  `frontend/` shim, `.pnpm-store/`, memory notes) and failed.
- Package-level `lint` scripts (`eslint src`) had no
  root-config for `eslint` to discover — every package failed with
  `ESLint couldn't find a configuration file`.
- `packages/config` had a `type-check` script but no
  `tsconfig.json`.
- `apps/web` inherited `declaration: true` from the base tsconfig,
  which under pnpm's content-addressed store surfaces as
  `TS2742` on every page component.
- `next build` prerender-crashed on `/accept-invite` because
  `useSearchParams()` was not wrapped in a `<Suspense>` boundary.
- `pnpm test` hung indefinitely because `apps/web`'s `test`
  script ran vitest in watch mode.

### Fix
- Tightened `.prettierignore` (`.pnpm-store`, `frontend`,
  `backend`, `memory`, `docs/audits`, `test_reports`, etc.).
- Added a root `.eslintrc.json` (parser: `@typescript-eslint`,
  extends `eslint:recommended`) + installed `eslint@^8.57`,
  `@typescript-eslint/parser@^7`, `@typescript-eslint/eslint-plugin@^7`
  as root devDeps. Added `apps/mobile/.eslintrc.cjs` extending the
  root config.
- Added `packages/config/tsconfig.json`.
- Overrode `declaration`, `declarationMap`, `sourceMap` to `false`
  in `apps/web/tsconfig.json`.
- Added `"pnpm": { "publicHoistPattern": ["@types/*"] }` in the
  root `package.json`.
- Wrapped `AcceptInvitePage` in a `<Suspense>` boundary.
- Changed `apps/web` test script from `vitest` to `vitest --run`
  so `pnpm test` terminates.

---

## Non-changes (updated)

Explicitly **not** in scope for this gate:
- New Sprint 3 features.
- The `RateLimiter.ping()` protocol method (still P2 backlog).
- Real Resend email backend (still P2, needs verified sending domain).
- The security-posture admin panel (still P3).
- `conflict_130726_0222` — that branch was declared to have no common
  ancestor with the canonical tree and remains untouched on the
  remote.
