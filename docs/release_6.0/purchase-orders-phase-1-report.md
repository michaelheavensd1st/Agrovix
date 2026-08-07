# Release 6.0.3 — Purchase Orders — Phase 1 Draft PR Report

**Status:** Sprint 1.3 hardening validated — ready for a 4th independent review · **Scope:** Backend domain layer only (no REST endpoints, no frontend)
**Contract:** `docs/release_6.0/purchase-orders.md` (frozen 6.0.3) · **Base:** `0011_business_partners`

> **Sprint 1.1 addendum (domain hardening / review remediation).** The independent
> Milestone-1 review returned BLOCK (4 High / 6 Medium / 3 Low). All findings are now
> remediated — transactional governance locking, in-transaction authorization revalidation,
> full submission rebuild, stable line identity (UUID-preserving add/update/reorder/remove),
> exact 6-dp decimals, delivery-address + ISO-3166 + bounded-string validation, dual
> received-accumulator cancel guard, richer repository filters + transition pagination, and an
> expanded PostgreSQL concurrency matrix. Gate: ruff/black clean, **SQLite 441 passed**,
> **PostgreSQL 502 passed**, alembic round-trip clean (head `0012`), seed OK. Details:
> `docs/release_6.0/purchase-orders-sprint-1.1-remediation-report.md`. Migration `0012` is
> unchanged. **Milestone 2 not started.**

> **Sprint 1.2 addendum (transactional governance / concurrency hardening).** The second
> independent review returned BLOCK (2 High / 4 Medium / 2 Low). Sprint 1.2 places supplier
> qualification and active authorization rows inside the PO lock domain, unions current and
> requested draft dependencies before locking, uses wide-context Decimal result arithmetic,
> translates only the PO-number unique constraint, and adds direct repository/audit plus expanded
> PostgreSQL race coverage. Migration `0012` remains byte-identical. Local Ruff, Black, collection,
> Alembic-head/round-trip, seed, decimal-boundary, scope, whitespace, full SQLite (**447 passed / 105
> skipped**), full PostgreSQL (**520 passed / 32 skipped**), and repeated PO concurrency checks all
> pass. Details:
> `docs/release_6.0/purchase-orders-sprint-1.2-remediation-report.md`. **Milestone 2 not started.**

> **Sprint 1.3 addendum (concurrency-test determinism).** The third independent review retained one
> Medium blocker for permissive/incomplete concurrency proofs. Tightening those proofs exposed and
> resolved two real High defects: stale current-farm validation during `update_draft`, and an
> actor-before-organization PostgreSQL deadlock. The canonical prefix is now organization → actor →
> authorization rows → PO → governed dependencies. Full SQLite (**452 passed / 107 skipped**), full
> PostgreSQL (**527 passed / 32 skipped**), PO concurrency (**27 passed**) and three consecutive
> concurrency runs (**81 passed**) are green. Alembic round-trip, seed, Ruff, Black, scope, and
> whitespace gates pass; migration `0012` remains unchanged. Details:
> `docs/release_6.0/purchase-orders-sprint-1.3-test-hardening-report.md`. **Milestone 2 not started.**

---

## 1. What Phase 1 delivers

The Purchase Order aggregate domain, exactly as scoped:

- **Alembic migration `0012_purchase_orders`** — status enum + four tables + permission/grant seeding, with a reversible `downgrade`.
- **Domain models** (`app/models/purchase_order.py`) — `PurchaseOrder`, `PurchaseOrderLine`, `PurchaseOrderSequence`, `PurchaseOrderTransition`, `PurchaseOrderStatus`.
- **Repositories** (`app/repositories/purchase_order.py`) — pure data access + concurrency primitives (`allocate`, `get_by_id_for_update`, scoped cursor paging).
- **Service** (`app/services/purchase_order.py`) — all business rules and invariants.
- **Supplier governance** — capability-removal guard wired into `app/services/business_partner.py`.
- **Permission seeding** — 7 PO permissions + role grants in `app/security/permissions.py` (seed path) and in the migration (deploy path).
- **Currency data** (`app/core/currency_codes.py`) — frozen ISO 4217 set + validator.
- **Tests** — `tests/test_purchase_orders.py` (26 domain) + `tests/test_purchase_orders_concurrency.py` (6 Postgres proofs).

**Explicitly NOT built (per scope):** REST endpoints, request/response Pydantic schemas, frontend routes, Purchase Receipts, inventory mutations, warehouse receiving, AP, payments, any Release 6.0.4 functionality.

---

## 2. Invariant coverage (contract → implementation)

| Contract area | Where enforced | Test |
| --- | --- | --- |
| §5 State machine (draft→submitted→approved/rejected; withdraw; revise; cancel) | `PurchaseOrderService.{submit,withdraw,approve,reject,revise,cancel}` | `test_full_lifecycle_*`, `test_withdraw_and_replay`, `test_reject_revise_flow`, `test_cancel_*`, `test_invalid_transitions` |
| §5.1 Independent approval (creator ≠ approver, **all** roles) | `approve()` checks `actor.id == created_by_id` first | `test_self_approval_forbidden`, `test_self_approval_forbidden_under_concurrency` |
| §7.1 Optimistic `version` precondition on draft edit | `update_draft(expected_version=…)` | `test_update_version_conflict`, `test_update_noop_keeps_version`, `test_concurrent_patch_same_version_one_winner` |
| §7.2 Snapshot freeze on submit | `submit()` re-freezes supplier + item snapshots under lock | `test_full_lifecycle_submit_approve` |
| §2 Supplier governance (draft-selection vs submit/approve) | `_validate_supplier(for_submission=…)` | `test_draft_selection_*`, `test_submit_requires_approved_qualification`, `test_submit_blocked_supplier` |
| §2 Capability-in-use guard | `BusinessPartnerService.remove_capability` → `count_non_terminal_for_partner` | `test_capability_removal_blocked_by_non_terminal_po`, `test_capability_removal_allowed_after_terminal` |
| §10.2 Monotonic org/year number allocation | `PurchaseOrderSequenceRepository.allocate` (PG `ON CONFLICT`, SQLite locked upsert) | `test_create_number_monotonic_same_org_year`, `test_concurrent_sequence_allocation_unique_monotonic`, `test_different_org_year_independent_sequences` |
| §4.3 Exact decimals + canonical unit conversion | `_parse_decimal`, `app.inventory.units.convert` | `test_create_generates_number_snapshots_decimals`, `test_unit_conversion_and_incompatibility` |
| §4.2 Zero-price ⇒ note required (service + DB check) | `_build_line_values` + `ck_purchase_order_line_zero_price_requires_note` | `test_zero_price_requires_note` |
| §8.2 Append-only transition history + replay idempotency | `_transition` / `_append_transition`, `_last_operation` | `test_submit_replay_is_idempotent`, withdraw/revise/cancel replay tests |
| §8 Bounded audit (named + generic transition events) | `_audit` via `AuditRepository.record` | `test_create_generates_number_snapshots_decimals` |
| §12 Aggregate-root locking / serialization | `get_by_id_for_update` (`SELECT … FOR UPDATE`) | `test_concurrent_approve_reject_serialize` |
| §10.4 Received accumulators bounded by ordered (6.0.4-ready) | DB check constraints | `test_db_rejects_received_above_ordered` |

---

## 3. Acceptance-gate evidence

| Gate | Result |
| --- | --- |
| `ruff check` (touched files) | **pass** (pre-existing `UP047` in `_transfer_locks.py` unrelated) |
| `black --check` (py312) | **pass** |
| `pytest` — SQLite hermetic (full suite) | **424 passed**, 86 skipped |
| `pytest` — PostgreSQL (full suite) | **478 passed**, 32 skipped |
| `alembic upgrade head` | **pass** (single head `0012_purchase_orders`) |
| `alembic downgrade base → upgrade head` round-trip | **pass** |
| `python -m app.seed` (post-migrate) | **pass** |

No regressions in Business Partners, inventory, tenancy, or RBAC suites.

---

## 4. Suggested reviewable commit sequence

1. `feat(po): ISO 4217 currency data + validator`
2. `feat(po): purchase order domain models`
3. `feat(db): migration 0012 — purchase order tables + enum + permission seeding`
4. `feat(po): purchase order repositories (sequence, aggregate, lines, transitions)`
5. `feat(po): purchase order service — invariants, state machine, governance, audit`
6. `feat(bp): block supplier-capability removal while non-terminal POs depend on it`
7. `feat(rbac): seed the seven purchase order permissions + role grants`
8. `test(po): domain + PostgreSQL concurrency suites`

---

## 5. Phase 2 handoff (API layer — do NOT start yet)

- Endpoint permission dependencies for the 7 codes + org/farm scope resolution (service already exposes `load_for_tenant`).
- Pydantic request/response schemas (decimals as strings; derived `subtotal` via `PurchaseOrderService.subtotal`).
- Idempotency-key surface returning `X-Idempotent-Replay` from `LifecycleResult.replay`.
- Cursor pagination wiring via `PurchaseOrderRepository.list_page` (+ `encode/decode_po_cursor`).

> **Stopping here per the Phase 1 directive — awaiting review before API implementation.**
