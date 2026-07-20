# Sprint 5 Tasks

This document tracks task-level progress per Sprint 5 slice. Only
completed and in-flight tasks are recorded here — the rest of the
Sprint 5 backlog remains in `SPRINT_PLAN.md` under "Deliverables".

## Sprint 5.1 — Inventory Dashboard ✅

Status: **implemented, awaiting Codex review.**
Branch: `feature/sprint-5-1-inventory-dashboard`.

| #   | Task                                                              | State            |
| --- | ----------------------------------------------------------------- | ---------------- |
| 1   | Design the dashboard information architecture                     | ✅               |
| 2   | Enumerate the Sprint 4 endpoints the dashboard can safely use     | ✅               |
| 3   | Document backend gaps (no reorder_level, no cross-wh tx feed)     | ✅               |
| 4   | Add `apps/web/lib/inventory-dashboard.ts` (types + aggregator)    | ✅               |
| 5   | Add `SummaryCards` component                                      | ✅               |
| 6   | Add `AttentionPanel` component with out-of-stock/expired/expiring | ✅               |
| 7   | Add `RecentActivity` component (proxied via `lot.updated_at`)     | ✅               |
| 8   | Add `QuickActions` component with deferred-action styling         | ✅               |
| 9   | Add `apps/web/app/inventory/dashboard/page.tsx`                   | ✅               |
| 10  | Add link from `/inventory` workspace to the new dashboard         | ✅               |
| 11  | Add pure aggregation unit tests                                   | ✅               |
| 12  | Add per-component render tests (populated + empty)                | ✅               |
| 13  | Add page-level integration tests (loading/empty/error/401/403)    | ✅               |
| 14  | Update `docs/sprint_5/API_MAPPING.md`                             | ✅               |
| 15  | Update `docs/sprint_5/ACCEPTANCE_CRITERIA.md`                     | ✅               |
| 16  | Update `docs/sprint_5/TASKS.md` (this file)                       | ✅               |
| 17  | Run frontend lint + type-check + tests + build                    | ⏳               |
| 18  | Run backend regression suite (must remain green)                  | ⏳               |
| 19  | Push branch to GitHub via "Save to Github"                        | ⏳ (user action) |
| 20  | Open PR into `develop` (only after Codex review approves)         | ⏳ (user action) |

## Sprint 5.2+ (not started)

- Stock Items screen + item detail
- Warehouse list + warehouse detail
- Receive / Issue / Transfer / Adjust / Return workflows
- Cross-warehouse transaction history filters
- Warehouse-scoped search + pagination
- Role-aware CTAs on the dashboard (hide "Receive stock" for read-only roles)
- (Backend) `InventoryItem.reorder_level` field to enable proper low-stock alerts
- (Backend) Cross-warehouse transactions feed endpoint

These are explicitly **out of scope** for Sprint 5.1.
