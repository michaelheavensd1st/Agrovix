# Release 6.0.3 — Purchase Orders — Milestone 2 REST API Report

**Scope:** REST API and route-level tests only
**Milestone 1 baseline:** `eb6694322118fede4a145d1f3ccebdd036dd2ab6`
**Contract:** `docs/release_6.0/purchase-orders.md`

## Implementation

Milestone 2 adds the Pydantic request/response contract in
`app/schemas/purchase_order.py`, the thin FastAPI adapter in
`app/api/v1/endpoints/purchase_orders.py`, router registration, bounded list-filter support in the
existing PO repository, and API integration tests in `tests/test_purchase_orders_api.py`.

The endpoint matrix is:

| Method | Path                                                      | Permission               |
| ------ | --------------------------------------------------------- | ------------------------ |
| GET    | `/api/v1/organizations/{organization_id}/purchase-orders` | `purchase_order.read`    |
| POST   | `/api/v1/organizations/{organization_id}/purchase-orders` | `purchase_order.create`  |
| GET    | `/api/v1/purchase-orders/{purchase_order_id}`             | `purchase_order.read`    |
| PATCH  | `/api/v1/purchase-orders/{purchase_order_id}`             | `purchase_order.update`  |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/submit`      | `purchase_order.submit`  |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/withdraw`    | `purchase_order.update`  |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/approve`     | `purchase_order.approve` |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/reject`      | `purchase_order.reject`  |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/revise`      | `purchase_order.update`  |
| POST   | `/api/v1/purchase-orders/{purchase_order_id}/cancel`      | `purchase_order.cancel`  |
| GET    | `/api/v1/purchase-orders/{purchase_order_id}/transitions` | `purchase_order.read`    |

Routes resolve authenticated users and tenant/farm visibility, then delegate mutations to the
approved `PurchaseOrderService`. They do not implement transitions, number allocation, supplier or
inventory governance, locking, decimal arithmetic, or audit writes.

## HTTP contract

- Draft PATCH requires `expected_version`; lifecycle operations have no version precondition.
- Domain replay returns `X-Idempotent-Replay: true`; first execution omits the header. Replay is the
  frozen operation/state replay contract and does not create duplicate transitions or audits.
- Domain `HTTPException` envelopes pass through unchanged, preserving stable 403/404/409/422 codes.
- Shape errors use FastAPI/Pydantic 422 responses; request models forbid extra fields.
- Tenant-inaccessible POs and out-of-scope farms are hidden as 404 before permission evaluation.
- Business quantities, prices, canonical quantities, line extensions, and subtotal serialize as
  six-decimal JSON strings and never as floats.

List results use deterministic `(created_at DESC, id DESC)` cursor pagination, default 50 and hard
maximum 200. Frozen filters include farm, supplier, repeatable status, order-date and expected-date
ranges, plus bounded case-insensitive search over PO number, supplier reference, and frozen supplier
code/names. Transition history uses chronological cursor pagination.

## Validation evidence

- Targeted PO API (SQLite): **23 passed**
- Targeted PO domain (SQLite): **54 passed**
- PO PostgreSQL concurrency: **29 passed**
- Targeted PO API (PostgreSQL, final schema): **23 passed**
- Targeted PO API + concurrency (PostgreSQL): **50 passed** before the final two API-only cases;
  concurrency remained independently green and the final complete PostgreSQL suite includes all
  23 API tests
- Full SQLite: **475 passed / 109 skipped**
- Full PostgreSQL: **552 passed / 32 skipped**
- Ruff: passed
- Black: passed, 103 API files unchanged at the final targeted gate
- Alembic upgrade → downgrade base → re-upgrade: passed on isolated PostgreSQL
- `app.seed`: passed after re-upgrade

## Scope and risk

Milestone 1 state-machine, service, models, migrations, locking, authorization revalidation, audit,
numbering, and decimal behavior were not redesigned. The repository adjustment is read-only and
limited to filters/search required by the frozen list endpoint.

No frontend, receipt, GRN, receiving, stock mutation, AP, payment, tax, FX, RFQ, purchase-request,
configurable approval, or Release 6.0.4 functionality is included. Migration `0012_purchase_orders`
remains unchanged and no migration `0013` exists.

The previously accepted Low risk remains: organization-level mutation serialization should be
monitored under production-scale contention.

## Independent-review Decimal remediation

The independent Milestone 2 review identified that the API response adapter recalculated each line
extension under the ambient Decimal context. At the maximum legal boundary, quantity
`999999999999.999999` multiplied by unit price `99999999999999.999999`, subsequent six-place
quantization could raise `decimal.InvalidOperation` instead of returning the canonical
`99999999999999999899000000.000000` string.

The shared API response adapter now performs both multiplication and quantization inside a local
64-digit `ROUND_HALF_UP` Decimal context matching the frozen domain arithmetic. Regression coverage
exercises create, detail, list, and PATCH responses at the maximum legal boundary and checks both
`extended_amount` and `subtotal`. The Milestone 1 service and domain arithmetic remain unchanged.

Independent review must resume after this remediation; this report does not claim renewed review
approval.

Post-remediation validation evidence:

- Maximum-boundary API regression (PostgreSQL): **1 passed**
- Complete PO API (SQLite): **23 passed / 1 skipped**; the boundary case is skipped because SQLite
  cannot preserve the canonical PostgreSQL `NUMERIC` values at this magnitude
- Complete PO API (PostgreSQL): **24 passed**
- PO domain (SQLite): **54 passed**
- PO concurrency (PostgreSQL): **29 passed**
- Full SQLite: **475 passed / 110 skipped**
- Full PostgreSQL: **552 passed / 32 skipped / 1 unrelated inventory-concurrency failure**; the
  failing `test_reversal_blocks_concurrent_item_org_mutation` passed immediately when rerun alone
- Ruff, Black check, and `git diff --check`: passed
- FastAPI import and OpenAPI generation: passed; exactly 11 PO operations registered
- Alembic: one head, `0012_purchase_orders`; migration unchanged and no `0013`
