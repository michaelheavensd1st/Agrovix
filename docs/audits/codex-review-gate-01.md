# Codex Review Gate 01 — Foundation Security Audit

## Executive summary
Agrovix's canonical applications are under `apps/api`, `apps/web`, and `apps/mobile`; the root `frontend/` and `backend/` preview shims are non-canonical. The audit found two verified high-severity Sprint 2 risks and one repository-integrity issue. The high findings have been corrected and regression-tested in the API suite. The foundation is approved only with the deferred CI limitations below addressed before production release.

## Critical findings
None verified during this pass.

## High findings
1. **Cross-tenant custom production unit type disclosure.** `GET /production-unit-types?organization_id=...` accepted arbitrary organization IDs and returned custom unit types without proving organization membership. A cross-tenant caller could enumerate another tenant's custom production unit taxonomy.
2. **Production event retry duplication/idempotency gap.** `POST /batches/{batch_id}/events` had no idempotency key. Client/network retries could duplicate append-only events and, for lifecycle events, race with or duplicate transition attempts.

## Medium findings
1. **Workspace lockfile drift.** The repo declared pnpm as canonical tooling but carried stale Yarn lockfiles. CI used pnpm, but stale lockfiles invited accidental divergent installs.
2. **Production router size.** The production router remains large. It is cohesive as one bounded context, but should be split by sites, units, batches, events, and catalog when ownership becomes harder to reason about.

## Low findings
1. Preview shim directories still exist for Emergent compatibility. They should remain blocked from production deployment paths and reviewed periodically for stale branding.
2. Dependency audits are intentionally non-blocking; failures are visible but do not fail CI.

## Evidence and affected files
- Canonical application paths: `apps/api`, `apps/web`, and `apps/mobile` are the production workspaces.
- Preview shim evidence: `PREVIEW_SHIM.md`, `frontend/`.
- Production unit type leak: `apps/api/app/api/v1/endpoints/production.py` list-unit-types handler.
- Event idempotency gap: `apps/api/app/schemas/production.py`, `apps/api/app/models/production.py`, `apps/api/app/services/production.py`, `apps/api/app/repositories/production.py`.
- Database migration chain through `apps/api/alembic/versions/0005_production_event_idempotency.py`.

## Corrections made
1. Added server-side membership verification before listing organization-scoped custom production unit types.
2. Added `idempotency_key` to production event create/public schemas, ORM model, repository lookup, service create flow, and Alembic migration.
3. Added a `(batch_id, idempotency_key)` uniqueness constraint for PostgreSQL-backed duplicate prevention.
4. Added regression tests for cross-tenant custom unit-type isolation and event retry de-duplication.
5. Removed stale Yarn lockfiles so pnpm remains the only declared workspace package manager lock system.
6. Added explicit Alembic upgrade validation to the PostgreSQL-backed API CI job.

## Deferred risks
- Full PostgreSQL integration execution could not be completed locally because PostgreSQL is not running in this container.
- Generating `pnpm-lock.yaml` could not be completed locally because Corepack could not download pnpm through the environment proxy.

## Recommended next actions
1. Run PostgreSQL-backed pytest and Alembic upgrade validation in CI before merge.
2. Generate and commit `pnpm-lock.yaml` from an environment with registry access, then enforce `pnpm install --frozen-lockfile`.
3. Consider splitting the production router once the bounded context grows beyond current Sprint 2 ownership.
