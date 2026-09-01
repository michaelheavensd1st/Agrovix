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

### Purchase receipt posting / inventory posting

PASS.

A controlled production-acceptance fixture was created against the Railway production API to validate the receiving flow end to end at API level.

Controlled Purchase Order:

- Purchase Order ID: `6a3a1d6e-8065-4ff7-b2ee-e7fc596b10b4`
- Initial receivable state: `APPROVED`, version `3`
- Purchase Order line ID: `e4e41ad5-3e24-464e-ab7d-77031758966a`
- Ordered quantity: `100.000000 kg`
- Eligible warehouse ID: `94e15351-d4b4-46bc-ac36-a304c675ba8f`
- Warehouse code: `UAT_RECEIPT_WH_A`

Independent approval was performed by a separate non-superuser organization-scoped approver account. Creator self-approval was therefore not used.

First partial receipt:

- HTTP `201`
- Receipt ID: `27c2131f-cc97-404f-bc6b-cfe8753357e8`
- GRN: `GRN-2026-000001`
- Quantity: `40.000000 kg`
- Inventory lot ID: `958208f1-dd3b-41cd-b860-51f43a3313ef`
- Inventory transaction ID: `42462b62-b99e-4f3e-abf1-f6a5aba8902f`
- Purchase Order transitioned from `APPROVED v3` to `PARTIALLY_RECEIVED v4`
- Readback confirmed `40.000000 / 100.000000 kg` received.

Idempotency validation:

- Replaying the exact first receipt with the same `Idempotency-Key` returned HTTP `200`.
- Response header `x-idempotent-replay: true` was present.
- The replay returned the same receipt ID, GRN, inventory lot ID, and inventory transaction ID.
- Reusing the same idempotency key with a changed quantity returned HTTP `409` with code `idempotency_key_payload_conflict`.
- Readback after the rejected changed-payload request confirmed the Purchase Order remained `PARTIALLY_RECEIVED v4` with exactly `40.000000 kg` received.

Final receipt:

- HTTP `201`
- Receipt ID: `f36cd2c2-25b2-4bb1-83be-e989560401a9`
- GRN: `GRN-2026-000002`
- Quantity: `60.000000 kg`
- Inventory lot ID: `7d91e5a2-d289-4e9a-9ab7-35763751891f`
- Inventory transaction ID: `94f0aba1-845b-48c8-aa80-18be9209aa9e`
- Purchase Order transitioned from `PARTIALLY_RECEIVED v4` to `RECEIVED v5`
- Final readback confirmed `100.000000 / 100.000000 kg` received and canonical quantities matched exactly.

Post-completion protection:

- A further receipt attempt against the fully received Purchase Order returned HTTP `409` with code `purchase_order_not_receivable`.
- No additional receipt mutation was accepted after the Purchase Order reached `RECEIVED`.

This closes the API-level Purchase Receipt posting gate, including inventory-lot creation, inventory-transaction creation, partial and full receipt transitions, replay safety, conflicting replay rejection, and terminal over-receipt protection.

### Production receipt-fixture inventory isolation

PASS.

Because Purchase Receipt posting creates immutable inventory-ledger history, a read-only production database audit was performed before authorizing fixture cleanup.

The controlled receipt fixture is logically isolated from all other observed inventory activity:

- Warehouse `94e15351-d4b4-46bc-ac36-a304c675ba8f` is explicitly named `UAT Receipt Warehouse A` with code `UAT_RECEIPT_WH_A`.
- Inventory item `3ee95b24-b3c4-4d56-9dcc-141ccd755f84` is explicitly named `UAT Receipt Feed` with code `UAT-RECEIPT-FEED`.
- The UAT warehouse contains exactly `2` inventory transactions, `2` active lots, and `1` distinct inventory item.
- The two transactions total exactly `100.000000 kg`, matching the controlled `40 kg` and `60 kg` Purchase Receipt scenarios.
- The UAT inventory item has no transaction activity or active lots in any other warehouse.
- The only transaction type recorded for the UAT item is `receipt`.
- Read-only schema discovery returned `inventory_items`, `inventory_lots`, and `inventory_transactions` as the inventory-related tables relevant to this fixture; no separately named stock/balance table was identified.
- Receipt transaction IDs are `42462b62-b99e-4f3e-abf1-f6a5aba8902f` and `94f0aba1-845b-48c8-aa80-18be9209aa9e`.
- Receipt lot IDs are `958208f1-dd3b-41cd-b860-51f43a3313ef` and `7d91e5a2-d289-4e9a-9ab7-35763751891f`.

Accordingly, the synthetic `100 kg` balance is quarantined inside a dedicated, clearly identified UAT warehouse/item ledger namespace and is not commingled with another observed warehouse or inventory-item ledger. The immutable Purchase Receipt and inventory transaction history must not be deleted, rewritten, or offset merely for UAT cleanup. No compensating inventory adjustment is authorized or required for this closeout because the fixture remains quarantined as acceptance evidence and is not being converted into operational stock.

Browser qualification remains governed by Section 8: the dedicated production frontend/domain was not established by this closeout, so this receipt-posting evidence is specifically API-level production acceptance and is not represented as dedicated production-browser receipt-posting validation.

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
- Production application deployment ID at closeout: `19028a58-3e26-4e11-95c4-1c44a142c610`

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

- Deployment ID: `19028a58-3e26-4e11-95c4-1c44a142c610`
- Git SHA: `48c236ac2e625f0ca18c0e7e7f9940327c2197e4`
- Git branch: `develop`
- Repository: `michaelheavensd1st/Agrovix`

The production application code remained on the exact UAT-approved SHA. A subsequent configuration-only redeployment was performed to apply the corrected transactional-email sender configuration; in-container verification after that redeployment confirmed `RAILWAY_GIT_COMMIT_SHA=48c236ac2e625f0ca18c0e7e7f9940327c2197e4` and `RAILWAY_GIT_BRANCH=develop`. No application-code change was introduced by that configuration redeployment.

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
5. Dedicated production-browser receipt-posting validation was not established because the validated Vercel `develop` Preview is not treated as proof of a distinct production frontend/database path; API-level receipt posting was completed successfully as recorded in Section 3.
6. A timezone-sensitive web test has previously failed outside UTC while passing under `TZ=UTC`; this is test-environment debt.
7. Broad API mypy debt remains outside the focused remediation scope.
8. Repository dependency/security-alert debt should be handled as a dedicated security-maintenance stream rather than silently folded into this closeout.

## 10. Data preservation and cleanup rule

UAT fixtures must not be deleted until this closeout evidence is committed and reviewed. Cleanup should be controlled and limited to genuinely disposable UAT data. Production data must not be modified merely to remove acceptance evidence.

The Release 6.0.6 Purchase Receipt fixture is specifically excluded from destructive cleanup: its Purchase Receipt records, inventory lots, and inventory transactions form immutable acceptance/audit evidence and must not be deleted, rewritten, or neutralized by a compensating adjustment solely for cleanup purposes. Its synthetic `100 kg` balance remains quarantined in the dedicated `UAT_RECEIPT_WH_A` / `UAT-RECEIPT-FEED` ledger namespace documented in Section 3.

Aquaculture and other Purchase Order fixtures used to establish the acceptance evidence should remain available until the closeout commit/PR is safely merged and the evidence is no longer dependent on live fixture inspection.

## 11. Final acceptance statement

Release 6.0.6 is accepted at Git SHA:

`48c236ac2e625f0ca18c0e7e7f9940327c2197e4`

The functional UAT gate is closed and the Railway production API is accepted on that exact SHA with a healthy application, Redis, PostgreSQL, aligned Alembic state, and a fresh pre-acceptance database backup.

The current production deployment remains on the accepted release SHA; no further application-code deployment is required merely to reproduce that SHA. Follow-up work should proceed as separately controlled hardening/cleanup work, beginning with preservation of this report, then UAT fixture cleanup, production frontend/domain hardening, and production backup-policy hardening.
