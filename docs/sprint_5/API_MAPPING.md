# API Mapping

Sprint 5 will consume the existing FastAPI endpoints defined by the
Sprint 4 inventory engine and Sprint 4.1 hardening pass. The mapping
below is the authoritative source for what each Sprint 5 screen uses.

## Sprint 5.1 — Inventory Dashboard

The dashboard is **read-only**. It performs zero writes and never
duplicates backend business rules.

| Purpose                               | Method + Path                                         | Backing repository / service                                                                            |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pick active organization              | `GET /api/v1/organizations`                           | `organizations.py`                                                                                      |
| List warehouses for the current org   | `GET /api/v1/organizations/{org_id}/warehouses`       | `WarehouseRepository.list_for_org`                                                                      |
| List item catalog for the current org | `GET /api/v1/organizations/{org_id}/inventory-items`  | `InventoryItemRepository.list_for_org`                                                                  |
| List lots + live balance in a wh      | `GET /api/v1/warehouses/{warehouse_id}/lots`          | `InventoryLotRepository.list_for_warehouse` + `InventoryTransactionRepository.get_balance_in_canonical` |
| Deep-link to full ledger (per lot)    | `GET /api/v1/lots/{lot_id}/transactions?limit&cursor` | Sprint 4.1 hardened cursor pagination                                                                   |

**Response shapes consumed (all Sprint 4 schemas, unchanged):**

- `Organization` — `{ id, name, slug }`
- `WarehousePublic` — `{ id, code, name, status, farm_id, organization_id, … }`
- `InventoryItemPublic` — `{ id, code, name, category, canonical_unit, is_active, … }`
  ⚠️ _No `reorder_level` field yet._ See "Known limitations" below.
- `InventoryLotWithBalance` — `{ id, item_id, warehouse_id, lot_code, expiry_date, balance, balance_unit, updated_at, … }`
  ⚠️ _`updated_at` is NOT a transaction-activity proxy._ Backend
  tracing confirmed that receipts, issues, transfers, adjustments and
  reversals write `InventoryTransaction` rows without touching the
  parent lot's timestamp. Sprint 5.1 review therefore removed the
  earlier "recent lot activity" list. Cross-warehouse recent activity
  remains deferred to a future sprint that ships a dedicated
  transaction-feed endpoint.

**Tenant isolation.** Every endpoint above is guarded by
`_assert_org_membership` (or `_load_warehouse` + `inventory_*.read`
permissions) on the backend. The frontend trusts that filter and
does not re-implement tenancy client-side. In addition, the dashboard
propagates the selected `organization_id` into every workspace link
via the `?organization_id=…` query parameter, and both the dashboard
and the `/inventory` workspace validate that query parameter against
the caller's authenticated organization list before using it.

## Frontend-side aggregation (Sprint 5.1)

Because the Sprint 4 API surface is per-warehouse, the dashboard fans
out one `GET /warehouses/{wh}/lots` request per warehouse in the org
using `Promise.allSettled`. Fan-out results are then inspected:

- Any rejected `ApiError` with status `401` propagates to `/login`.
- Any rejected `ApiError` with status `403` propagates to
  `ForbiddenBanner`; no partial projection is rendered.
- Any other rejected reason (5xx, network) surfaces the
  "One or more warehouses could not be loaded. Some totals may be
  understated." banner alongside the successful partial data.

A monotonically increasing generation ref (`useRef`) guards the
dashboard against stale organization responses: when the user
switches organization mid-flight, any late response for the previous
organization is ignored and cannot overwrite the current view.

## Known limitations documented for Sprint 5.1

| UI_SPEC item                       | Implemented?      | Reason                                                                                                                                                                             |
| ---------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total active items                 | ✅                | `InventoryItemPublic.is_active` count.                                                                                                                                             |
| Total warehouses                   | ✅                | list length; active count also surfaced.                                                                                                                                           |
| Total tracked lots                 | ✅                | Aggregated across warehouses.                                                                                                                                                      |
| Out-of-stock lots                  | ✅                | `balance <= 0` from `InventoryLotWithBalance`.                                                                                                                                     |
| Expiring-soon lots (≤ 30 days)     | ✅                | Derived from `expiry_date`.                                                                                                                                                        |
| Already-expired lots               | ✅                | Derived from `expiry_date`.                                                                                                                                                        |
| **Per-item low-stock threshold**   | ❌ Deferred       | `InventoryItem` has no `reorder_level` field on the backend yet. Requires a schema change.                                                                                         |
| **Estimated stock value**          | ❌ Deferred       | Requires reliable `unit_cost_amount` and currency across all lots in an org.                                                                                                       |
| **Warehouse utilization**          | ❌ Deferred       | `Warehouse` has no `capacity` / `used_capacity` metadata.                                                                                                                          |
| **Pending / in-transit transfers** | ❌ Not applicable | Existing stock transfers are immediate. Sprint 4.1 explicitly rejects a workflow lifecycle.                                                                                        |
| **Recent transactions (global)**   | ❌ Deferred       | No cross-warehouse transactions endpoint exists. `lot.updated_at` is NOT a valid proxy (see above). Dashboard renders an explicit deferred placeholder linking to per-lot history. |

Reserved for a later Sprint 5 slice or a dedicated backend follow-up.
