# Release 6.0.3 — Purchase Orders — Sprint 3.1 Report

**Scope:** Frontend foundation and read flows only
**Baseline:** `6108c2bf359d607b20910eaf284b5411ed444048`
**Contract:** `docs/release_6.0/purchase-orders.md`

## Implementation

Sprint 3.1 adds the `/purchase-orders?organization_id=...` list route and the
`/purchase-orders/[purchaseOrderId]` detail route. The list provides organization and farm-aware
permission UX, published API filters, opaque cursor pagination, semantic desktop tables, compact
narrow-screen cards, and explicit loading, empty, forbidden, and recoverable-error states. The
detail renders frozen supplier and item snapshots and loads transition history independently.

The typed client in `apps/web/lib/purchase-orders.ts` maps all 11 published REST operations so later
sprints can use the same transport contract. Sprint 3.1 calls read operations only. Repeated status
filters remain repeated query parameters, cursors are never decoded, business decimals remain
strings, and lifecycle response metadata preserves access to `X-Idempotent-Replay` without adding
client idempotency keys.

## Decimal and race safety

`decimal.js` is now an explicit web dependency. The PO decimal helper uses a local 64-digit
`ROUND_HALF_UP` constructor, accepts plain decimal strings through six fractional places, retains
canonical six-place strings, avoids scientific notation for normal display, and does not use native
floating-point values as the canonical representation. Server totals remain authoritative.

List, detail, selector, and transition requests use mounted guards, generation IDs, and request
cancellation where supported. Generation checks are authoritative: a response for an old
organization, filter set, farm, route ID, or transition cursor cannot replace current state.
Committed list, detail, and transition results also retain the exact identity that produced them.
Identity matching is enforced during render, so browser-history and dynamic-route changes make old
data ineligible synchronously rather than waiting for passive effect cleanup.

Currency display derives ISO 4217 minor-unit precision from the platform internationalization
runtime without converting the Decimal value through `Number`. Currency identifiers must be three
ASCII letters and present in the runtime's supported currency metadata before minor-unit rounding is
applied. The `Intl.supportedValuesOf` capability is detected before use so older supported browsers
cannot fail during module initialization. Runtimes without that enumeration API use inspected
`Intl.NumberFormat` metadata only for a bounded trusted legacy set; other identifiers fall back
without invented precision. Malformed and unsupported identifiers use a neutral display that
retains the normalized identifier, when present, and the untouched canonical decimal string.
Unknown internal 5xx payload details are replaced by a bounded generic PO error, while canonical
authentication, permission, hidden resource, validation, and expected application errors retain
their established handling.

The list's session Previous stack is stored with a stable scope identity containing organization,
farm, supplier, ordered repeated statuses, both order-date bounds, both expected-delivery bounds,
normalized search, and limit. The current cursor is intentionally excluded. Render and navigation
use the stack only when its identity exactly matches the current URL-derived scope, so browser
history changes synchronously make stale cursors ineligible.

## Tests and validation

Focused Vitest/React Testing Library coverage verifies the client route matrix, exact Decimal
handling, list states and filters, repeated statuses, cursor traversal and recovery, URL/history
scope changes with identity-bound Previous behavior, permission UX, organization/farm resets,
stale-response rejection, snapshot rendering, transition isolation and pagination, malformed and
unsupported currency fallback, missing-`Intl.supportedValuesOf` compatibility, and 401/403/404
behavior.

- Focused Sprint 3.1 tests: **31 passed**
- Full web suite: **301 passed**
- ESLint: passed with no warnings or errors
- TypeScript `tsc --noEmit`: passed
- Prettier check: passed
- Production Next.js build: passed; both PO read routes generated
- `git diff --check`: passed

## Scope and remaining work

No backend production code or migration is changed. Sprint 3.1 does not add create/edit routes,
Draft forms, line editors, or lifecycle mutation UI. Receipts, GRNs, receiving, stock mutation, AP,
payments, RFQ, purchase requests, mobile UI, and Release 6.0.4 remain excluded.

Sprint 3.2 remains responsible for create/edit Draft UX. Later work must continue treating backend
permissions and lifecycle/domain validation as authoritative. Session-aware Previous navigation is
available within a list visit; a deep link to an opaque cursor intentionally falls back to Next and
Return to first page because cursors are not reversible.
