# Release 6.0.6 Production Acceptance & UAT Closeout Report

**Closeout date:** 2026-09-01 (WAT)  
**Repository:** `michaelheavensd1st/Agrovix`  
**Release branch:** `develop`  
**Accepted release SHA:** `48c236ac2e625f0ca18c0e7e7f9940327c2197e4`  
**Alembic head:** `0015_aqua_transfer_integrity`

## 1. Decision

**PRODUCTION ACCEPTED / FUNCTIONAL UAT CLOSED.**

Release 6.0.6 passed the functional UAT and production-acceptance gates described below. No additional application redeployment was required during closeout because the Railway production service was already running the exact UAT-approved Git SHA.

This acceptance is subject to the frontend-environment qualification in Section 8 and does not waive the non-blocking technical debt recorded in Section 9.

## 2. Canonical release baseline

At closeout the repository baseline was verified as:

- Branch: `develop`
- Local HEAD: `48c236ac2e625f0ca18c0e7e7f9940327c2197e4`
- `origin/develop`: `48c236ac2e625f0ca18c0e7e7f9940327c2197e4`
- Divergence: `0 / 0`
- Worktree: clean
- Alembic: exactly one head, `0015_aqua_transfer_integrity`

Recent remediation lineage included:

- PR #36 — `fix(production): return conflict for duplicate unit codes`
- PR #37 — `fix(receipts): scope warehouse lookup to purchase order`
- PR #38 — `fix(web): expose purchase orders from organization hub`
- PR #38 merge commit is the accepted release SHA.

## 3. UAT remediation and acceptance evidence

### Aquaculture transfer integrity and timeline

PASS.

Validated atomic transfer behavior, source/destination population projections, idempotent replay, conflicting replay rejection, overdraw rejection, cross-farm destination protection, and sanitized timeline rendering without destination UUID exposure.

### Production-unit duplicate-code handling

PASS / REMEDIATED.

Duplicate production-unit code creation now returns sanitized HTTP `409` with code `production_unit_code_conflict` instead of leaking an unhandled SQLAlchemy integrity failure as HTTP `500`.

### Purchase receipt warehouse lookup

PASS / REMEDIATED.

Frontend warehouse discovery was corrected to scope the request by Purchase Order ID rather than organization ID. Browser UAT confirmed the prior repeated `404` behavior was removed.

### Transactional email verification

PASS / REMEDIATED.

A verified sending subdomain was configured and a fresh registration email was delivered successfully. The verification link completed successfully without weakening verification requirements.

### Purchase Order navigation

PASS / REMEDIATED.

The organization workspace now exposes an Operations → Purchase Orders navigation card. Browser UAT confirmed the organization-scoped Purchase Orders list loads correctly.

### Purchase Order lifecycle

PASS.

Validated submit, withdraw, resubmit, independent approval, creator self-approval prevention, reject, revise, cancel, reason-length validation, invalid post-terminal transitions, and mutation replay behavior.

### Purchase Order draft edit / optimistic concurrency

PASS.

Fixture: `PO-2026-000004`.

- Normal Draft edit persisted `supplier_reference = UAT-EDIT-V2`.
- Version advanced from `v1` to `v2`.
- A stale PATCH using `expected_version: 1` against current version `2` returned HTTP `409` with code `purchase_order_version_conflict` and context `current_version: 2`.
- Final read proved the rejected stale write changed nothing: status remained `DRAFT`, version remained `2`, and supplier reference remained `UAT-EDIT-V2`.

## 4. Release-UAT deployment verification

Railway release-UAT API health returned HTTP `200` with Redis-backed rate limiting healthy.

Version endpoint reported the staging environment and `/api/v1` prefix.

The exact accepted SHA had successful Railway and Vercel deployment statuses.

Inside the release-UAT Railway container:

- working directory: `/app`
- `alembic current`: `0015_aqua_transfer_integrity (head)`
- `alembic heads`: `0015_aqua_transfer_integrity (head)`

Final browser smoke validation on the canonical Vercel `develop` Preview confirmed the organization-scoped Purchase Orders page loaded the expected UAT records without a visible frontend error.

## 5. Production preflight and database state

Railway production target:

- Project: `talented-fulfillment`
- Environment: `production`
- Application service: `Agrovix`
- Production application deployment ID at closeout: `b45ed9ca-33db-4dfa-a3f3-36cb85e3f18e`

Production health verification:

- `/health`: HTTP `200`
- Application environment: `production`
- Redis rate limiter: healthy
- PostgreSQL: online

Inside the production Railway application container:

- working directory: `/app`
- `alembic current`: `0015_aqua_transfer_integrity (head)`
- `alembic heads`: `0015_aqua_transfer_integrity (head)`

Therefore no pending Alembic migration was required for this acceptance event.

## 6. Backup and rollback evidence

A fresh production PostgreSQL volume backup was created immediately before production acceptance:

- Timestamp: `2026-08-31 23:50` WAT
- Size shown by Railway: approximately `112 MB`
- Environment: `production`
- Service: `Postgres`

An older `2026-08-26 22:33` backup remained available as additional historical coverage.

At closeout:

- Point-in-time recovery was OFF.
- No automatic volume-backup schedule was configured.
- PITR was deliberately not enabled during closeout because enabling it would introduce an unrelated service redeployment.

Application rollback anchor:

- Deployment ID: `b45ed9ca-33db-4dfa-a3f3-36cb85e3f18e`
- Git SHA: `48c236ac2e625f0ca18c0e7e7f9940327c2197e4`
- Git branch: `develop`
- Repository: `michaelheavensd1st/Agrovix`

The production application was already running the exact UAT-approved SHA, so no redundant redeployment was performed.

## 7. Railway platform stability gate

During preflight the Railway dashboard displayed an incident banner concerning delayed deployment initialization. Promotion was held while the incident was considered active.

Railway's status report subsequently marked the incident **Resolved**, stating that the deployment pipeline had stabilized, the queued-deployment backlog had cleared, and throughput had returned to normal. Only after this status was established was the infrastructure-stability gate treated as passed.

## 8. Frontend environment qualification

The final browser validation used the canonical Vercel `develop` Preview rather than a separately identified production frontend/domain.

Therefore this report records:

- production Railway API acceptance: PASS;
- accepted frontend build browser smoke: PASS;
- dedicated production frontend/domain validation: **not established by this closeout**.

A dedicated production frontend/domain should be treated as a follow-up deployment-hardening objective. This qualification prevents the closeout evidence from being interpreted as proof that a distinct production web deployment was validated when it was not.

## 9. Accepted non-blocking technical debt / follow-up

The following items were not treated as release blockers for this closeout:

1. Dedicated production frontend/domain deployment and validation remains to be established.
2. Railway production Postgres has PITR disabled and no automatic backup schedule; production backup policy should be hardened separately.
3. Transactional email provider failures can currently surface as generic HTTP `500`; graceful provider-failure handling should be hardened.
4. A previously observed email-verification test login returned `401`; this was not reproduced as a verified product defect and may have been test-password input error.
5. Receipt-posting UAT was not completed because the tested Purchase Order returned an empty eligible-warehouse list; a controlled warehouse fixture is required for that flow.
6. A timezone-sensitive web test has previously failed outside UTC while passing under `TZ=UTC`; this is test-environment debt.
7. Broad API mypy debt remains outside the focused remediation scope.
8. Repository dependency/security-alert debt should be handled as a dedicated security-maintenance stream rather than silently folded into this closeout.

## 10. Data preservation and cleanup rule

UAT fixtures must not be deleted until this closeout evidence is committed and reviewed. Cleanup should be controlled and limited to disposable UAT data. Production data must not be modified as part of UAT fixture cleanup.

Aquaculture and Purchase Order fixtures used to establish the acceptance evidence should remain available until the closeout commit/PR is safely merged and the evidence is no longer dependent on live fixture inspection.

## 11. Final acceptance statement

Release 6.0.6 is accepted at Git SHA:

`48c236ac2e625f0ca18c0e7e7f9940327c2197e4`

The functional UAT gate is closed and the Railway production API is accepted on that exact SHA with a healthy application, Redis, PostgreSQL, aligned Alembic state, and a fresh pre-acceptance database backup.

No further deployment is required merely to reproduce the accepted release SHA. Follow-up work should proceed as separately controlled hardening/cleanup work, beginning with preservation of this report, then UAT fixture cleanup, production frontend/domain hardening, and production backup-policy hardening.
