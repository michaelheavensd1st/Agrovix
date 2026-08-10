# Release 6.0.3 — Purchase Orders — Sprint 3.2 Report

**Scope:** Draft creation and Draft editing only

**Baseline:** `490a8bdadc7c9cba408710fd64bdb72081549869`

**Contract:** `docs/release_6.0/purchase-orders.md`

## Routes and form architecture

Sprint 3.2 adds `/purchase-orders/new?organization_id=...` and
`/purchase-orders/[purchaseOrderId]/edit`. Both routes use one `PurchaseOrderForm`, with a
responsive line editor and an explicit stale-version conflict panel. Creation is pessimistic,
prevents duplicate submission, retains entered values after failure, and navigates only from the
canonical create response. Editing loads a route-bound canonical Purchase Order, exposes the form
only for `DRAFT`, and uses the existing `purchase_order.create` and `purchase_order.update`
permission model as a UX guard while leaving authorization authoritative on the backend.

The supplier selector is organization-bound, requests active supplier-capable Business Partners,
supports server search, and displays the published qualification state without inventing approval
rules. The farm selector uses the accessible organization farm collection. The inventory selector
uses active organization item definitions and shows item code, name, SKU when available, and
canonical unit; it does not expose stock, warehouse, or lot state. Selector results are committed
only for their exact organization and search identity. Abort and generation guards prevent late
organization results from becoming renderable after browser-history or route changes.

Create mutations also retain the exact organization identity under which their POST began. A
synchronously updated current-organization ref is checked before every completion-side error,
state, or navigation action. Pending ownership is tracked per organization, so a valid server
create remains untouched while a completion for an old URL organization is ignored by the current
UI and a later create in the new organization continues normally.

Final pending-state remediation separates request bookkeeping from route-visible side effects.
Active creates are stored as organization-to-token request records, and pending UI is derived only
from a currently active record for the rendered organization. Matching-token cleanup always removes
the completed request, regardless of the current URL identity; navigation, errors, and visible state
updates remain guarded by the synchronous organization identity. An older organization request
therefore cannot clear a newer request token or reappear as pending after history navigation.

## Decimal, lines, and PATCH semantics

Ordered quantity and unit price remain canonical strings from control to request body. Client
validation uses the Sprint 3.1 Decimal helper for syntax, six-place scale, strict contract bounds,
and zero-price note requirements; it never converts canonical business values through `Number` or
`parseFloat`. Currency input is bounded to three ASCII letters and normalized to uppercase.

Persisted lines use their server UUID as part of a stable React row key and retain that UUID across
edits, deletion of siblings, and reordering. New rows receive only a client row key and omit an ID
from create/update transport. Line collection order is sent deliberately.

Edit payloads always contain `expected_version` and otherwise contain only fields that differ from
the loaded Draft. Unchanged fields are omitted, nullable values explicitly cleared in the form are
sent as `null`, and non-nullable values are rejected before submission. A no-op edit disables Save
and does not call PATCH.

## Conflict and error behavior

A stale-version 409 is never retried. Local dirty form state stays mounted while the latest
canonical Purchase Order is fetched separately. `PurchaseOrderConflictPanel` presents original and
latest versions, latest status, continued editability, Review latest, and explicit discard/reload
actions. If the latest state is no longer Draft, saving is disabled and the user returns to detail.
Other governance conflicts retain safe input, surface backend messages by field/line where context
permits, and refresh selector choices without silently changing selections.

FastAPI/Pydantic 422 locations map to header, address, and indexed line controls. Inline errors use
labels, `aria-invalid`, and `aria-describedby`; the first invalid control receives focus. Pending
and conflict states have accessible semantics, and line add/remove/reorder controls are keyboard
operable. Unexpected 5xx details use the existing generic sanitized PO message. The implementation
does not add a custom global dirty-navigation hook because the application has no established safe
router interception convention; failed API operations nevertheless retain all form state.

Create and edit share one bounded PO error normalizer. In addition to indexed Pydantic locations,
it recognizes authoritative domain codes and contexts for currency, delivery date, supplier,
delivery-address aliases, country, and unambiguous indexed line fields. Unknown or ambiguous
contexts remain summary-only rather than being assigned to an unrelated control.

## Tests and validation

Focused coverage verifies exact maximum Decimal-string payloads, minimal version-aware patches,
explicit nulls, no-op edits, stable persisted line IDs, new-ID omission, deletion/reordering,
validation and accessible errors, qualification display, selector organization races, permission
denial, duplicate-click prevention, canonical redirects, route identity races, non-Draft blocking,
sanitized failures, and stale-version reconciliation without automatic retry.

Remediation regressions hold an organization A create POST open across a synchronous URL/history
change to organization B, prove the late A success cannot navigate, and then prove B can create
normally. Rendered-control tests cover domain currency, delivery country, delivery line 1, indexed
Pydantic line errors, first-invalid focus, ARIA relationships, shared create/edit route mapping,
and ambiguous summary fallback.

The final history regression starts an A create, switches to B, completes A under B, navigates back
to A, proves the form is enabled with no active request, and successfully creates again under A. A
separate concurrent A/B token-isolation regression proves completion of the older A request cannot
release B's active pending state.

- Focused Sprint 3.2 tests: **27 passed / 2 files**
- Full web suite: **328 passed / 26 files**
- ESLint: passed with no warnings or errors
- TypeScript `tsc --noEmit`: passed
- Scoped Prettier check: passed
- Production Next.js build: passed; all four PO routes generated
- `git diff --check`: passed

## Scope and remaining work

No backend, mobile, migration, or dependency change is included. Sprint 3.2 adds no lifecycle
buttons or dialogs: submit, withdraw, approve, reject, revise, and cancel remain Sprint 3.3 work.
Receipts, GRNs, receiving, stock mutation, AP, payments, RFQ, purchase requests, and Release 6.0.4
remain excluded.
