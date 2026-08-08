# Release 6.0.3 — Purchase Orders — Sprint 1.4 Remediation Report

**Fourth independent review verdict:** BLOCK MILESTONE 2 (1 High / 2 Medium / 1 Low).
**Sprint outcome:** the High and Medium findings are remediated and the full validation gate is
green. The remaining Low finding is a performance-monitoring concern only.
**Scope:** Purchase Order service readback, PostgreSQL concurrency/integration tests, and reports.
Milestone 2 was not started.

## Findings remediated

### Authoritative current-Farm reread

The fourth review identified that `update_draft()` locked the current Farm and then called
`session.get(Farm, id)`. An active Farm loaded earlier in the transaction could remain unexpired in
the SQLAlchemy identity map, allowing validation to accept stale governance after another
transaction committed deactivation.

`PurchaseOrderService._load_farm()` now executes `SELECT Farm WHERE id = ...` with
`execution_options(populate_existing=True)`. Every caller still acquires the Farm dependency lock
through the existing deterministic global order before validation. The query overwrites a cached
identity-map entity with post-lock committed state; it does not expire the session, weaken or repeat
the lock, or introduce another loading path.

The new PostgreSQL regression preloads the active Farm in session A, deactivates and commits it in
session B, and calls a header-only `update_draft()` in session A without expiration. The operation
returns canonical tenant-hidden `not_found`. Authoritative readback proves DRAFT status, version 1,
the original `farm_id`, unchanged header and line data, inactive Farm state, one original create
transition, one original create audit, and no partial mutation.

Existing coverage also proves header-only and line-only inactive-current-Farm rejection, active
current Farm acceptance, valid replacement acceptance, foreign-Farm hiding, and Farm deactivation
versus submit serialization.

### Unrelated IntegrityError proof

The Sprint 1.3 test monkeypatched `po_repo.create`, so it did not prove the real repository flush.
The amended Sprint 1.4 requirement recognizes that the public service prevents construction of an
unrelated invalid PO by design.

The replacement repository/integration proof calls the real `PurchaseOrderRepository.create()` and
uses a real PostgreSQL violation of `ck_purchase_order_delivery_after_order`. PostgreSQL raises
`IntegrityError`; it is not labeled `duplicate_purchase_order_number`; rollback leaves no PO or
sequence row; and a subsequent legitimate service creation succeeds as `PO-2026-000001`.

A separate, explicitly unit-isolated service test monkeypatches only the repository call to verify
that an unrecognized `IntegrityError` is re-raised. The existing real duplicate-number test proves
recognized PO-number violations are translated narrowly. Production service validation and
repository behavior are unchanged.

### Lifecycle concurrency attribution

The submit/cancel and approve/cancel proofs now branch on the committed serialization order and
assert status, version, actor header fields, timestamps, exact transition operations and actors,
exact audit actions and actors, and absence of false submit/approve attribution when cancellation
wins first.

The self-approval proof asserts the creator receives
`purchase_order_self_approval_forbidden`, the independent actor succeeds, approval attribution and
timestamp identify that actor, and no creator approval transition or audit exists. The
role-assignment-revocation proof asserts the submitted state and attribution remain intact while
approval actor/timestamp, transition, and audit are absent.

The complete PostgreSQL PO concurrency suite was audited for race-owned state. Assertions were
added where attribution, lifecycle chronology, audit semantics, or rollback could be corrupted;
contract-valid outcome branches were retained only where lock acquisition order legitimately
chooses the serialization.

## Validation evidence

| Gate | Sprint 1.4 result |
| --- | --- |
| Required PostgreSQL targeted set | **9 passed** |
| Targeted PO domain suite | **54 passed** |
| PO PostgreSQL concurrency | **29 passed** |
| Three consecutive PO concurrency runs | **87 passed** |
| SQLite full API suite | **452 passed / 109 skipped** |
| PostgreSQL full API suite | **529 passed / 32 skipped** |
| Ruff (`apps/api`) | pass |
| Black (`apps/api`, 131 files) | pass |
| `git diff --check` | pass |
| Alembic heads | one: `0012_purchase_orders` |
| Upgrade → downgrade base → re-upgrade | pass |
| `app.seed` after re-upgrade | pass |
| Migration `0012` modified | no; working copy and HEAD hash `53d53e6eb868cf07462a0f7d7b6b38289789d838` |
| Scope scan | pass |

## Scope and remaining risk

Production changes are confined to `apps/api/app/services/purchase_order.py`. No migration,
repository, model, state-machine, numbering, decimal, permission, Business Partner, API, frontend,
receipt, stock, AP/payment, or Release 6.0.4 behavior changed.

The organization-level mutation anchor remains deliberately broad. It is correct and prevents
deadlocks, but organization-level contention should be monitored under expected-scale load. Sprint
1.4 does not redesign or optimize it.

Remaining findings after Sprint 1.4: **Critical 0 / High 0 / Medium 0 / Low 1**. No new production
defect was exposed.

**Recommendation: READY FOR FIFTH INDEPENDENT DOMAIN REVIEW.**
