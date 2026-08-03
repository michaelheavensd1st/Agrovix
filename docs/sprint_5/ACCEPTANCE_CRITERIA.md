# Acceptance Criteria

This document tracks the acceptance criteria per Sprint 5 slice.
Only slices that have shipped are recorded here — the rest of the
Sprint 5 scope keeps its criteria in `SPRINT_PLAN.md` until the
corresponding slice is delivered.

## Sprint 5.1 — Inventory Dashboard

Status: **implemented, in review under PR #6 (branch
`feature/sprint-5-1-inventory-dashboard`). Not yet shipped or merged
into `develop`.**

### AC-5.1.1 — Route exists and renders under the app shell

- **Given** the user is authenticated and belongs to at least one organization,
- **When** they navigate to `/inventory/dashboard`,
- **Then** the page renders inside the standard app shell with the
  heading "Inventory dashboard" and the current organization's name.

### AC-5.1.2 — Summary cards are derived from real data

- The dashboard renders six summary cards driven by
  `buildDashboardProjection` over the real API responses:
  - Active items (from `is_active` on the item catalog).
  - Warehouses (total; active count in the hint).
  - Tracked lots.
  - Out-of-stock lots (`balance <= 0`).
  - Expiring soon (`expiry_date` within 30 days).
  - Already expired (`expiry_date` before now).
- No metric is fabricated — every value is derivable from
  `GET /organizations/{org}/warehouses`,
  `GET /organizations/{org}/inventory-items`, and
  `GET /warehouses/{wh}/lots`.

### AC-5.1.3 — Attention panel lists lots that need action

- Lots classified as `out_of_stock`, `expired`, or `expiring_soon`
  are surfaced in a table with columns: item, warehouse, lot code,
  balance, expiry, status.
- Rows are ordered: `out_of_stock` first, then `expired`, then
  `expiring_soon` (nearest to expiry first).
- List is capped at 20 rows; the summary card exposes the true total.
- **Empty state:** When no lots need attention, an "Everything looks
  healthy" card is rendered instead of a table.

### AC-5.1.4 — Recent activity is an honest deferral

- Sprint 5.1 does **not** render a ranked "recent lot activity" list.
  Backend tracing confirmed that receipts, issues, transfers,
  adjustments and reversals do NOT update `InventoryLot.updated_at`,
  so ordering by that field would have been misleading.
- Instead the dashboard renders an explicit deferred panel with the
  copy:
  > _"A cross-warehouse transaction feed is not yet available. Open
  > transaction history in the inventory workspace to review
  > lot-level records."_
- The panel links to
  `/inventory?organization_id=<orgId>&tab=history`, preserving the
  currently selected organization.

### AC-5.1.5 — Quick actions never break navigation

- The following actions link to existing routes and each carries the
  currently selected `organization_id` as a query parameter:
  - View inventory items → `/inventory?organization_id=<orgId>&tab=items`
  - View warehouses → `/inventory?organization_id=<orgId>&tab=warehouses`
  - Receive stock → `/inventory?organization_id=<orgId>&tab=receive`
  - Issue stock → `/inventory?organization_id=<orgId>&tab=issue`
  - Transfer stock → `/inventory?organization_id=<orgId>&tab=transfer`
  - Transaction history → `/inventory?organization_id=<orgId>&tab=history`
- The header "Open workspace" link uses
  `/inventory?organization_id=<orgId>`.
- The empty-state CTA uses
  `/inventory?organization_id=<orgId>&tab=warehouses`.
- Actions whose destination screen is deferred (Suppliers, Purchases)
  are rendered as non-interactive `div`s with `aria-disabled="true"`
  and a visible "Coming later in Sprint 5" badge.

### AC-5.1.6 — Loading, empty, error and access-denied states

- **Loading:** During the initial data fetch, the shared
  `Loading` primitive from `@/components/ape-ui` is displayed.
- **Empty:** When the organization has zero warehouses AND zero
  items, an `EmptyStateCard` with an org-scoped CTA to create a
  warehouse is rendered instead of the panels.
- **Error (non-fatal):** If one or more warehouses fail to return
  lots with a **non-authentication** error (e.g. 5xx or network),
  the dashboard still renders and shows an `ErrorBanner`:
  _"One or more warehouses could not be loaded. Some totals may be
  understated."_
- **401 unauthenticated:** Any 401 during dashboard load — including
  a 401 raised from within the lot fan-out — redirects to `/login`
  and does not surface a partial projection.
- **403 forbidden:** A 403 — including one raised from within the
  lot fan-out or from the organization bootstrap — renders the
  shared `ForbiddenBanner` primitive and does not surface a partial
  projection.

### AC-5.1.7 — Tenant and farm context, with URL-driven preservation

- The dashboard reads `?organization_id=…` from the URL on landing
  and honours it **only** when it appears in the caller's
  authenticated organizations list. Otherwise it falls back safely
  to the first org.
- The `/inventory` workspace performs the same validation on
  `?organization_id=…`.
- The organization selector (rendered only when the user belongs to
  more than one org) re-fetches the dashboard on change and stale
  responses from a previous organization are ignored.
- Warehouse visibility respects the backend's role-based filter in
  `list_warehouses` — the frontend does not attempt to re-filter.

### AC-5.1.8 — Accessibility

- Every interactive control has a `data-testid`.
- Every panel has a labelled heading (`aria-labelledby` on each section).
- Statuses use both colour AND a text label ("Out of stock",
  "Expiring soon", "Expired") — colour is never the sole signal.
- The organization selector is a native `<select>` linked to a
  visible `<label>`.

### AC-5.1.9 — Test coverage

- Pure aggregation logic (`buildDashboardProjection`, `classifyLot`,
  `parseBalance`, `daysBetween`, `resolveOrganizationId`,
  `buildWorkspaceHref`) has deterministic unit tests.
- Each dashboard component has a rendering test covering both the
  populated and the empty branch, plus the activity-placeholder link
  behaviour.
- The page has integration tests covering:
  - loading, empty, populated;
  - honouring a valid `?organization_id=`;
  - falling back safely on an unknown `?organization_id=`;
  - propagating the selected org into every functional quick action;
  - re-projecting links when the selector changes;
  - **stale-response protection** when the user switches org
    mid-flight (org A's response cannot overwrite org B's state);
  - fan-out 401 → `/login`;
  - fan-out 403 → `ForbiddenBanner` (no partial projection);
  - fan-out non-auth partial failure → "understated totals" warning;
  - bootstrap 401 → `/login`;
  - bootstrap 403 → `ForbiddenBanner`;
  - bootstrap 500 → generic `ErrorBanner`;
  - the deferred activity placeholder is rendered and its link
    preserves the organization; no ranked lot list is ever rendered.

### AC-5.1.10 — Scope confinement

- No new backend endpoints, schemas, models or migrations were added.
- No writes are performed by the dashboard.
- No transfer lifecycle states (draft, submitted, in-transit,
  received) were introduced — transfers remain immediate.
- No supplier / procurement / purchase-order code was introduced.
- Frontend `prettier --check`, `next lint`, `tsc --noEmit`,
  `vitest --run`, and `next build` all pass on the branch. Backend
  regression `pytest` remains green (no backend files were touched
  during this slice).

# Sprint 5.5 — Production Unit creation (UAT-PROD-001)

- Authorized users see **Create Unit** in the site header and the no-units empty state; users
  without `production_unit.create` see neither action.
- The dialog loads system and organization-visible unit types and exposes required type, name,
  and code fields, optional non-negative integer capacity, and an active default status.
- Submission uses `POST /api/v1/sites/{siteId}/units`, is single-flight, maps `422` errors inline,
  and follows established handling for `401`, `403`, `404`, `409`, and network failures.
- Success closes the dialog, restores focus, displays success feedback, renders the unit
  immediately, and refreshes the site-scoped list without losing route context.
- Frontend coverage includes both CTAs, permission hiding, type loading/empty states, success and
  refresh, pending submission, `401`, `403`, `409`, `422`, network failure, and focus restoration.

# Sprint 5.6 — Production Batch creation (UAT blocker completion)

- The Manual UAT blocker—no frontend path to create the first batch from a Production Unit—is
  recorded and resolved on the unit detail page.
- Authorized users see **Create Batch** in the unit header and no-batches empty state; callers
  without `production_batch.create` see neither action.
- Actions are disabled when the parent site or unit is not active, matching backend lifecycle
  policy without bypassing server enforcement.
- The dialog supports required code and optional species, planned date/time, expected quantity,
  and notes. The server-owned initial state is `planned`; unsupported metadata input is omitted.
- Submission is single-flight and handles `401`, `403`, tenant-safe `404`, duplicate-code and
  lifecycle `409`, field-level `422`, and network failure.
- Success closes the dialog, restores focus, shows feedback, renders a linked batch immediately,
  and refreshes the unit-scoped list.
- Integration coverage verifies actions and permissions, lifecycle disabling, initial state,
  validation, every required API error, pending/double submission, immediate render and refresh,
  batch navigation, and focus restoration.
