# Purchase Orders Sprint 3.4 — Hardening and Full Regression

## Baseline

- Branch: `feature/6.0.3-purchase-orders-implementation`
- Starting commit: `fea3519258fc0b50aebf2d6b9e317bc5ecded64e`
- Starting tree: `1fc74a377fe9e0514fc83a3ef12bcdd77f54b1b5`
- Sprint 3.4 remains uncommitted and unpublished.

## Findings remediated

- Added a scoped, permission-aware Create Purchase Order entry on the list route.
- Restricted create/edit farm choices to the applicable `purchase_order.create` or
  `purchase_order.update` scope.
- Made nested selector and conflict-refresh `401` responses use the established login redirect.
- Added synchronous navigation locks to list and transition-history pagination.
- Contained keyboard focus inside the lifecycle dialog.
- Focused the actionable stale-version conflict alert once per conflict version.
- Replaced ambiguous list/create/edit backend content with bounded frontend-owned errors.
- Added targeted narrow-screen wrapping, grid, and dialog overflow improvements.
- Expanded route-generation regression proof for overlapping detail and history requests.
- Bound lifecycle mutation completion to a route-visit generation so an obsolete first visit to a
  PO cannot become current after navigating away and back to the same ID.
- Separated protected user pagination from internal expired-cursor recovery.
- Replaced recognized domain-code backend messages with fixed frontend-owned mappings.

## Production changes

- `apps/web/app/purchase-orders/page.tsx`: scoped create entry, scoped farm filters, bounded errors,
  and list pagination locks.
- `apps/web/app/purchase-orders/new/page.tsx`: permission context and nested-auth redirect wiring.
- `apps/web/app/purchase-orders/[purchaseOrderId]/edit/page.tsx`: update permission context and
  nested conflict-refresh authentication handling.
- `apps/web/app/purchase-orders/[purchaseOrderId]/page.tsx`: transition pagination locks and
  malformed-cursor recovery, plus route-visit lifecycle mutation ownership.
- `apps/web/components/purchase-orders/PurchaseOrderForm.tsx`: permission-filtered farms,
  selector-auth handling, transient option-error recovery, and structured error sanitization.
- `apps/web/components/purchase-orders/PurchaseOrderConflictPanel.tsx`: deliberate, route-safe
  conflict alert focus.
- `apps/web/components/purchase-orders/PurchaseOrderLifecycleActions.tsx`: Tab/Shift+Tab focus
  containment and bounded tall-dialog layout.
- `apps/web/components/purchase-orders/PurchaseOrderList.tsx`: long-value wrapping and compact
  narrow-screen card layout.
- `apps/web/components/purchase-orders/PurchaseOrderDetail.tsx`: long-value wrapping and responsive
  metadata/summary grids.
- `apps/web/components/purchase-orders/PurchaseOrderLineEditor.tsx`: wrapping header/action rows.
- `apps/web/components/purchase-orders/PurchaseOrderTransitionHistory.tsx`: navigation busy/disabled
  semantics and long-reason wrapping.

No backend, API schema, permission-definition, migration, dependency, or Decimal production code
changed.

## Regression coverage

The five existing rendered Purchase Order suites were extended. Coverage now includes:

- create entry visibility for organization-wide, applicable farm, wrong-organization, wrong-farm,
  and revoked/empty permission scopes;
- create/edit farm-choice suppression across applicable and inapplicable scopes;
- nested selector and conflict-refresh authentication redirects without raw error exposure;
- hostile list/form error payload sanitization while retaining approved structured mappings;
- hostile messages paired with recognized domain codes, proving frontend-owned mapped text;
- rapid double Next/Previous activation and cursor-history integrity for both paginators;
- locked expired-cursor recovery and deterministic three-page Previous traversal;
- transition page boundaries and request overlap;
- wrong-organization and wrong-farm lifecycle action suppression;
- lifecycle dialog forward and reverse keyboard focus cycling;
- focused stale-version conflict state;
- overlapping `PO A -> PO B -> PO A` detail and transition ownership.
- stale lifecycle success, replay, failure, conflict, refresh, pending-token, and focus suppression
  across `PO A1 -> PO B -> PO A2`;
- edit load and conflict-refresh ownership across `PO A1 -> PO B -> PO A2`;
- stale selector `401`, error-to-success recovery, and stale success/failure isolation;
- same-ID A1/B/A2 transition-history ownership.

Existing coverage continues to prove filter and organization generation guards, opaque cursors,
selector generation guards, PATCH ownership, lifecycle mutation tokens, replay, authoritative
refresh, stale completion suppression, focus restoration, and sanitized lifecycle validation.

## Race and accessibility hardening

Pagination locks are set before URL navigation and are released only by the route-bound request
generation. Internal invalid-cursor recovery can reset the cursor and history without weakening
the user-activation lock. Cursor values remain opaque, and organization/filter identity changes
still clear cursor history. Detail, transition, selector, and edit completions remain guarded by
route identity and generation tokens. Lifecycle mutations additionally capture a route-visit
generation; leaving a visit releases its active per-PO token, and obsolete cleanup cannot clear a
newer visit's token or pending state.

The lifecycle dialog traps Tab and Shift+Tab without changing its established initial focus,
Escape, pending-dismissal, restoration, or post-success focus rules. Conflict alerts retain
`role="alert"` and receive deliberate focus without repeated jumps for the same version.

## Responsive review

Static viewport review covered 320 px, 375 px, 768 px, and desktop class behavior. Long PO numbers,
supplier names, and transition reasons break safely; card/detail grids collapse below their bounded
breakpoints; line/dialog actions wrap; and lifecycle content scrolls vertically when tall. No broad
visual redesign was introduced.

## Decimal invariant

Decimal production behavior was not modified. The seven Decimal regression tests continue to pass,
covering canonical numeric strings, six-place precision, maximum values, authoritative totals, and
non-scientific presentation.

## Validation

- Modified focused suites: 5 files, 106 tests passed.
- Complete Purchase Order frontend: 7 files, 117 tests passed.
- Full `@agrovix/web` suite: 27 files, 387 tests passed.
- ESLint: passed with no warnings or errors.
- `tsc --noEmit`: passed.
- Production Next.js build: passed; list, new, detail, and edit routes generated.
- `git diff --check`: passed.

The full test run retained known unrelated stock-operation React warnings and the existing Vite CJS
notice. No Sprint 3.4 Purchase Order warning or failure remains.

## Residual risks and readiness

Responsive verification is static/jsdom-based rather than a new external browser or accessibility
tool, as required by sprint scope. Backend authorization remains authoritative; frontend filtering
is a permission-aware UX boundary. No Critical, High, Medium, or new Low residual Sprint 3.4 issue is
known from the implementation pass. Review Remediation Pass 1 is ready for independent re-review;
this report does not claim the independent finding gate is closed before that re-review occurs.
