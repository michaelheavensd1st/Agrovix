# Acceptance Criteria

This document tracks the acceptance criteria per Sprint 5 slice.
Only slices that have shipped are recorded here — the rest of the
Sprint 5 scope keeps its criteria in `SPRINT_PLAN.md` until the
corresponding slice is delivered.

## Sprint 5.1 — Inventory Dashboard

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

### AC-5.1.4 — Recent activity list

- Uses the top 10 most recently updated lots (from `lot.updated_at`)
  as an honest proxy for cross-warehouse recent activity — the
  limitation is documented in `API_MAPPING.md`.
- Each row deep-links (via the "View full transaction history" link)
  to `/inventory?tab=history` in the existing workspace.
- **Empty state:** "No recent inventory activity" copy when the
  organization has zero lots.

### AC-5.1.5 — Quick actions never break navigation

- The following actions link to existing routes:
  - View inventory items → `/inventory?tab=items`
  - View warehouses → `/inventory?tab=warehouses`
  - Receive stock → `/inventory?tab=receive`
  - Issue stock → `/inventory?tab=issue`
  - Transfer stock → `/inventory?tab=transfer`
  - Transaction history → `/inventory?tab=history`
- Actions whose destination screen is deferred (Suppliers, Purchases)
  are rendered as non-interactive `div`s with `aria-disabled="true"`
  and a visible "Coming later in Sprint 5" badge.

### AC-5.1.6 — Loading, empty, error and access-denied states

- **Loading:** During the initial data fetch, the shared
  `Loading` primitive from `@/components/ape-ui` is displayed.
- **Empty:** When the organization has zero warehouses AND zero
  items, an `EmptyStateCard` with a CTA to create a warehouse is
  rendered instead of the panels.
- **Error (non-fatal):** If one or more warehouses fail to return
  lots, the dashboard still renders and shows an `ErrorBanner`:
  _"One or more warehouses could not be loaded. Some totals may be
  understated."_
- **401 unauthenticated:** Any 401 during dashboard load redirects
  to `/login`.
- **403 forbidden:** A 403 renders the shared `ForbiddenBanner`
  primitive; no data is shown.

### AC-5.1.7 — Tenant and farm context

- The dashboard only ever shows the currently selected organization.
- The organization selector (rendered only when the user belongs to
  more than one org) re-fetches the dashboard on change.
- Warehouse visibility respects the backend's role-based filter in
  `list_warehouses` — the frontend does not attempt to re-filter.

### AC-5.1.8 — Accessibility

- Every interactive control has a data-testid.
- Every panel has a labelled heading (`aria-labelledby` on each section).
- Statuses use both colour AND a text label ("Out of stock",
  "Expiring soon", "Expired") — colour is never the sole signal.
- The organization selector is a native `<select>` linked to a
  visible `<label>`.

### AC-5.1.9 — Test coverage

- Pure aggregation logic (`buildDashboardProjection`, `classifyLot`,
  `parseBalance`, `daysBetween`) has deterministic unit tests.
- Each dashboard component has a rendering test covering both the
  populated and the empty branch.
- The page has integration tests covering: loading, empty,
  populated, 401 redirect, 403 forbidden, and non-fatal error.

### AC-5.1.10 — Scope confinement

- No new backend endpoints, schemas, models or migrations were added.
- No writes are performed by the dashboard.
- No transfer lifecycle states (draft, submitted, in-transit,
  received) were introduced — transfers remain immediate.
- No supplier / procurement / purchase-order code was introduced.
- Frontend lint, type-check, tests and production build all pass.
