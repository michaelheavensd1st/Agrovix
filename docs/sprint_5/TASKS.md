# Sprint 5 Tasks

## Sprint 5.5 — Production Unit creation

Status: **implemented; ready for validation and manual UAT.**
Branch: `feature/sprint-5-5-production-unit-frontend`.

| # | Task | State |
| --- | --- | --- |
| UAT-PROD-001 | Permission-aware site header and empty-state creation actions | ✅ |
| UAT-PROD-001 | Accessible validated creation dialog and visible unit-type states | ✅ |
| UAT-PROD-001 | API error handling, single-flight submission, immediate render, and refresh | ✅ |
| UAT-PROD-001 | Frontend integration coverage for acceptance and accessibility behavior | ✅ |
| UAT-PROD-001 | Production Engine and Sprint 5 documentation | ✅ |

This document tracks task-level progress per Sprint 5 slice. Only
completed and in-flight tasks are recorded here — the rest of the
Sprint 5 backlog remains in `SPRINT_PLAN.md` under "Deliverables".

## Sprint 5.1 — Inventory Dashboard

Status: **implemented, under review in PR #6. Not yet merged into
`develop`.**
Branch: `feature/sprint-5-1-inventory-dashboard`.

| #   | Task                                                              | State                                    |
| --- | ----------------------------------------------------------------- | ---------------------------------------- |
| 1   | Design the dashboard information architecture                     | ✅                                       |
| 2   | Enumerate the Sprint 4 endpoints the dashboard can safely use     | ✅                                       |
| 3   | Document backend gaps (no reorder_level, no cross-wh tx feed)     | ✅                                       |
| 4   | Add `apps/web/lib/inventory-dashboard.ts` (types + aggregator)    | ✅                                       |
| 5   | Add `SummaryCards` component                                      | ✅                                       |
| 6   | Add `AttentionPanel` component with out-of-stock/expired/expiring | ✅                                       |
| 7   | Add `RecentActivity` component (initial implementation)           | ⛔ removed in review round — see task 7b |
| 7b  | Replace ranked "Recent lot activity" with deferred placeholder    | ✅                                       |
| 8   | Add `QuickActions` component with deferred-action styling         | ✅                                       |
| 9   | Add `apps/web/app/inventory/dashboard/page.tsx`                   | ✅                                       |
| 10  | Add link from `/inventory` workspace to the new dashboard         | ✅                                       |
| 11  | Add pure aggregation unit tests                                   | ✅                                       |
| 12  | Add per-component render tests (populated + empty)                | ✅                                       |
| 13  | Add page-level integration tests (loading/empty/error/401/403)    | ✅                                       |
| 14  | Update `docs/sprint_5/API_MAPPING.md`                             | ✅                                       |
| 15  | Update `docs/sprint_5/ACCEPTANCE_CRITERIA.md`                     | ✅                                       |
| 16  | Update `docs/sprint_5/TASKS.md` (this file)                       | ✅                                       |

### Sprint 5.1 review round (PR #6 review findings)

| #   | Task                                                                                   | State                         |
| --- | -------------------------------------------------------------------------------------- | ----------------------------- |
| R1  | Preserve selected organization across every workspace link (`?organization_id=…`)      | ✅                            |
| R1a | Validate the URL-supplied `organization_id` against the caller's real org list         | ✅ (dashboard + `/inventory`) |
| R2  | Stale-response guard using a monotonic `useRef` generation counter                     | ✅                            |
| R3  | Preserve 401 / 403 from the warehouse lot fan-out (do not downgrade to a partial warn) | ✅                            |
| R4  | Handle 403 during the organization bootstrap → `ForbiddenBanner`                       | ✅                            |
| R5  | Remove misleading `lot.updated_at`-based recent-activity list; render deferred panel   | ✅                            |
| R6  | Documentation corrections (API_MAPPING / ACCEPTANCE_CRITERIA / TASKS)                  | ✅                            |
| R7  | New tests covering all six review findings                                             | ✅                            |
| R8  | Run `format:check`, `lint`, `typecheck`, `test`, `build` and backend regression        | ✅                            |
| R9  | Push review-fix commit to the existing branch so PR #6 updates                         | ✅ (`ff855b3`)                |
| R10 | Await final Codex review approval before merge                                         | ⏳                            |

### Sprint 5.1 review round #2 — workspace organization-context retention

| #   | Task                                                                                                                                              | State                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| W1  | Clear every piece of org-dependent workspace state immediately when `orgId` changes (warehouses, items, selected wh, lots, selected lot, history) | ✅ (new `useEffect` on `[orgId]`)                                                                                    |
| W2  | Reset every inventory form (Receive, Issue, Transfer, Adjust) on organization change                                                              | ✅ (via `key={orgId}` on each form-bearing panel — React remounts them)                                              |
| W3  | Validate that the selected warehouse + item + lot still belong to the active organization before any write                                        | ✅ (new pure helpers `isWarehouseInCurrentOrg`, `isItemInCurrentOrg`, `isLotInCurrentOrg` guard every form's submit) |
| W4  | Regression tests covering org switches while forms are populated                                                                                  | ✅ (`tests/inventory-workspace-org-context.test.tsx` + guard unit tests in `tests/inventory-dashboard.test.tsx`)     |
| W5  | Leave concurrency optimization, malformed-data handling, and URL reactivity for later slices                                                      | ✅ (not touched)                                                                                                     |

## Sprint 5.2+ (not started)

- Stock Items screen + item detail
- Warehouse list + warehouse detail
- Receive / Issue / Transfer / Adjust / Return workflows
- Cross-warehouse transaction history filters
- Warehouse-scoped search + pagination
- Role-aware CTAs on the dashboard (hide "Receive stock" for read-only roles)
- (Backend) `InventoryItem.reorder_level` field to enable proper low-stock alerts
- (Backend) Cross-warehouse transactions feed endpoint

These are explicitly **out of scope** for Sprint 5.1, including the
review round.
