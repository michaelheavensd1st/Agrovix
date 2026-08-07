# Release 6.0.3 — Purchase Orders — Sprint 1.1 Remediation Report

**Milestone-1 review verdict:** BLOCK MILESTONE 2 — 0 Critical, 4 High, 6 Medium, 3 Low.
**This sprint:** remediate every finding. **Do NOT begin Milestone 2.**
**Scope guard:** backend domain only — no REST endpoints, routers, schemas, frontend, receipts, warehouse receiving, inventory mutations, AP, payments, or 6.0.4 behaviour.

Files changed (5, all `apps/api`):

- `app/services/purchase_order.py` — locking-owning lifecycle, in-transaction authorization, submission rebuild, stable line identity, exact decimals, address/bounds validation, dual-accumulator cancel guard.
- `app/repositories/purchase_order.py` — deterministic dependency locking, richer filters, transition-history pagination, hard limit enforcement.
- `app/services/business_partner.py` — supplier-row `FOR UPDATE` lock before the capability-in-use check (race-free vs PO submit/approve).
- `tests/test_purchase_orders.py` — 43 domain tests (SQLite-hermetic).
- `tests/test_purchase_orders_concurrency.py` — 13 PostgreSQL concurrency proofs.

No model or migration change — `0012_purchase_orders` is byte-identical to the reviewed Phase 1; the schema is unchanged.

---

## Objective-by-objective resolution

### 1. Transactional governance locking  *(High)*
Lifecycle methods now **own** locking and take an id, never a caller-supplied object.
Each acquires the aggregate root with `SELECT … FOR UPDATE` (`_lock_po`) then locks every
governed dependency via `PurchaseOrderRepository.acquire_dependency_locks` in one **global
deterministic order**: `business_partner → supplier capabilities → farm → inventory_items`,
each set ordered by **ascending PK**. A single global order across all callers guarantees
deadlock freedom; locking before any read closes every check-then-act window.
*Evidence:* `test_edit_vs_submit_serialize`, `test_submit_vs_cancel_serialize`,
`test_approve_vs_cancel_serialize`, `test_concurrent_approve_reject_serialize`,
`test_capability_removal_race_with_submit`.

### 2. Transactional authorization revalidation  *(High)*
After all locks are held, `_authorize` re-resolves the caller's permissions from
**canonical active scopes** via `resolve_permission_scopes`, which validates active
organization membership, active farm membership, active (non-revoked) role assignment,
active organization, and active farm. Authorization is therefore decided **inside** the
locked transaction, never from a stale pre-request decision. Org-scoped grants apply to
every PO; farm-scoped grants apply only to farm-assigned POs; platform grants always apply.
*Evidence:* `test_authorization_allows_org_grant`, `test_authorization_denies_without_grant`,
`test_authorization_revoked_membership_denies`.

### 3. Submission revalidation  *(High)*
`submit` calls `_rebuild_and_validate_for_submission`, which re-derives the **entire
document** from authoritative locked data: currency, dates, delivery address, bounded text,
farm, supplier governance, and every line (item snapshots, canonical unit, canonical
quantity, unit compatibility, zero-price rule). Snapshots are frozen **only after** the
rebuild succeeds.
*Evidence:* `test_submission_rebuild_rejects_deactivated_item` (item deactivated post-draft
→ submit fails on authoritative re-read), plus the governance/zero-price submit tests.

### 4. Stable line identity  *(High)*
`_apply_line_diff` replaces the old delete-and-recreate with UUID-preserving reconciliation
supporting **add / update / reorder / remove**. Referenced ids are validated
(`duplicate_line_id`, `unknown_line_id`); a two-phase renumber avoids the
`(po_id, line_number)` unique collision during reorder. Audit metadata distinguishes
`added_line_ids`, `updated_line_ids`, `removed_line_ids` (each bounded, with counts). Simple
in-place edits never emit artificial remove/add pairs.
*Evidence:* `test_line_edit_preserves_uuid`, `test_line_reorder_add_remove_audit`,
`test_line_diff_rejects_duplicate_and_unknown_ids`.

### 5. PostgreSQL concurrency coverage  *(Medium)*
`tests/test_purchase_orders_concurrency.py` (independent sessions/transactions) covers:
sequence uniqueness/monotonicity, per-org/year isolation, edit vs submit, submit vs cancel,
approve vs cancel, simultaneous approvals (single effect + idempotent replay),
self-approval under concurrency, capability-removal race, rollback/readback consistency,
deterministic lock ordering, deadlock avoidance, and DB-level received-accumulator guards.

### 6. Decimal precision  *(Medium)*
`_parse_decimal` rejects > 6 fractional digits and out-of-range magnitudes, then quantizes to
exactly `0.000001`. Converted canonical quantities pass through `_quantize_canonical`, which
refuses any value not representable at 6 dp. `subtotal` quantizes to 6 dp. All business
arithmetic uses `Decimal` end-to-end — no float.
*Evidence:* `test_subtotal_exact_quantization`, `test_reject_more_than_six_decimals`,
`test_reject_out_of_range_quantity`, `test_unit_conversion_and_incompatibility`.

### 7. Domain validation  *(Medium)*
`_validate_delivery_address` enforces an allow-list of keys
(`line1,line2,city,region,postal_code,country_code`), string typing, bounded lengths, and a
valid **ISO 3166-1 alpha-2** country code (normalised to upper-case). Bounded-string helpers
enforce supplier_reference (≤120), notes (≤4000), description (≤500), line_note (≤1000) with
stable `value_too_long` / `invalid_delivery_address` / `invalid_country_code` errors.
*Evidence:* `test_delivery_address_rejects_unknown_key`, `test_delivery_address_rejects_bad_country`,
`test_delivery_address_valid_normalizes`, `test_supplier_reference_length_bounded`.

### 8. Cancellation guards  *(Medium)*
`cancel` inspects **both** frozen accumulators (`received_quantity` **and**
`received_quantity_canonical`); a non-zero value in either raises
`purchase_order_has_receipts`. 6.0.3 cannot create receipts, but the guard is complete for
6.0.4.
*Evidence:* `test_cancel_blocked_by_received_canonical_accumulator`,
`test_db_rejects_received_above_ordered`, `test_db_rejects_received_canonical_above_ordered`.

### 9. Repository foundations  *(Medium)*
`PurchaseOrderRepository.list_page` adds: order-date range filters, repeatable status filter,
supplier search (po_number/legal/trading), supplier-reference search, and cursor pagination.
`PurchaseOrderTransitionRepository.page_for_po` adds transition-history pagination. A hard
`MAX_PAGE_LIMIT` (200) is enforced internally regardless of the requested limit. Repository
only — no REST surface.

### 10. Numbering validation  *(Low)*
Numbering strategy preserved (`PO-{year}-{NNNNNN}`, org/year sequence). Added tests for
year-boundary behaviour, same-org/different-year independence, and rollback (no permanent
gap on the next committed allocation); duplicate handling is proven by the unique
`(organization_id, po_number)` constraint and the concurrency allocation proof.
*Evidence:* `test_numbering_year_boundary`, `test_numbering_same_org_different_year_independent`,
`test_numbering_rollback_leaves_no_gap_on_next`, `test_concurrent_sequence_allocation_unique_monotonic`.

> The 3 Low findings (numbering edge cases, bounded-string completeness, and audit
> line-id disambiguation) are folded into objectives 10, 7, and 4 respectively.

---

## Quality-gate evidence

| Gate | Result |
| --- | --- |
| `ruff check` (changed files) | **pass** |
| `black --check` (py312) | **pass** |
| `git diff --check` | **pass** (no whitespace errors) |
| SQLite hermetic suite | **441 passed**, 93 skipped |
| PostgreSQL suite | **502 passed**, 32 skipped |
| `alembic upgrade head` | **pass** (single head `0012_purchase_orders`) |
| `alembic downgrade base` → `upgrade head` | **pass** |
| `python -m app.seed` | **pass** |
| Single Alembic head | **pass** |
| No Phase 2 / no frontend / no 6.0.4 | **verified** |

---

## Remaining known risks

- **Operation→permission mapping** (`withdraw`→`submit`, `revise`→`update`) is a reasoned
  interim mapping; the canonical §6 matrix is confirmed when the Phase-2 endpoint layer wires
  permission dependencies. It does not change domain behaviour.
- **Authorization revalidation** relies on `resolve_permission_scopes`; farm-scoped POs
  assume org-scoped grants also authorise (documented in `_authorize`).
- **Concurrency proofs** run on PostgreSQL only (correct — SQLite serialises writers); CI must
  execute the Postgres job to exercise them.

## Readiness for a second independent Codex review

**Ready.** All four High and six Medium findings are remediated with tests; the three Low
findings are folded in; the full gate is green on both engines; scope guards (no Phase 2,
no frontend, no 6.0.4) are verified. Recommend a second independent review before Milestone 2.
