# Release 6.0.3 — Purchase Orders — Sprint 3.3 Report

**Scope:** Frontend lifecycle, transitions, and permission-aware actions only

**Baseline:** `8a4d36e22a3e21e48dfe3672369ac01016a98f33`

**Contract:** `docs/release_6.0/purchase-orders.md`

## Lifecycle experience

Sprint 3.3 adds permission- and canonical-status-aware controls for Submit, Withdraw, Approve,
Reject, Revise, and Cancel to the existing Purchase Order detail route. The controls use the
published scoped permission helper and never inspect role names. Creator self-approval is hidden
with an independent-approval explanation, while the backend continues to revalidate identity,
permission, scope, lifecycle legality, and governance at mutation time.

Every operation uses an accessible confirmation dialog. Withdraw, Reject, Revise, and Cancel require
a trimmed reason of at most 500 characters; Approve accepts an optional reason; Submit sends no
fabricated body. Required-reason errors are linked to and focus the textarea. All controls remain
keyboard operable, pending state is announced through button text and disabled controls, and
destructive actions use non-color labels as well as destructive styling.

The published typed lifecycle client is reused unchanged. No client idempotency key is introduced
and no mutation is automatically retried. `X-Idempotent-Replay` is preserved: a replay receives an
informational refresh message rather than a second successful-transition message.

## Authoritative refresh and race protection

Active lifecycle writes are tracked by Purchase Order ID and a unique request token. A duplicate
event for the same active PO cannot dispatch a second write, while a different route identity may
own its own request. Completion cleanup removes only the matching token. Navigation, error writes,
toasts, canonical response writes, and refresh triggers additionally require the initiating PO to
still be the current synchronous route identity.

After an effective success or replay, the server response is accepted as authoritative and fresh
detail and transition GETs are started. Their generations supersede pre-mutation requests. History
returns to a deterministic first opaque-cursor page and remains chronological as defined by the
backend. A 409 likewise refreshes canonical detail/history without retrying or overriding the
server decision. Older mutation, detail, or transition completions cannot overwrite a newer route
or post-mutation generation.

Lifecycle errors retain tenant and authorization boundaries: 401 follows the established login
flow, 403 reports revoked permission without resource leakage, 404 uses the generic unavailable
state, 409 reports a bounded stale/governance explanation, 422 retains the reason dialog, and
unexpected failures use the sanitized generic Purchase Order message.

## Independent-review remediation

Safely attributable lifecycle 422 responses are normalized into a bounded reason-field result.
FastAPI locations containing `reason`, the published `reason_required` code, and structured
`context.field=reason` are accepted; arbitrary or ambiguous details remain a sanitized general
error. The dialog preserves the entered reason, marks and describes the textarea, focuses it, and
waits for a deliberate corrected resubmission without retrying automatically.

The dialog retains the exact action button that opened it and restores focus after Cancel or Escape
when that control remains mounted and enabled. Effective success and replay do not target an action
that may disappear. Instead, after the authoritative detail refresh completes, focus moves to a
stable live status announcement containing the refreshed canonical status.

## Tests

`purchase-orders-lifecycle.test.tsx` adds 31 tests covering:

- all six lifecycle operations and their exact reason semantics;
- the complete status/action matrix and scoped permission behavior;
- creator self-approval UX;
- accessible confirmation, inline reason errors, ARIA linkage, and focus;
- duplicate-submit prevention and per-PO request-token ownership;
- effective success, replay metadata, and authoritative detail/history refresh;
- bounded 401, 403, tenant-safe 404, and 409 behavior;
- attributable and ambiguous 422 behavior, preserved correction, and deliberate retry;
- Cancel/Escape trigger restoration and post-success status focus;
- stale PO A mutation completion while PO B owns a newer active request.

Existing detail tests continue to prove transition actor/status/reason/time rendering, opaque cursor
pagination, independent history failure, and route-bound detail/history generations. Existing client
tests continue to prove all six paths, bodies, replay headers, and absence of invented idempotency
keys.

## Validation

- Focused lifecycle/client/detail tests: **43 passed / 3 files**
- Full web suite: **359 passed / 27 files**
- ESLint: passed with no warnings or errors
- TypeScript `tsc --noEmit`: passed
- Scoped Prettier: passed
- Production Next.js build: passed
- `git diff --check`: passed

The generated Purchase Order routes remain exactly:

- `/purchase-orders`
- `/purchase-orders/new`
- `/purchase-orders/[purchaseOrderId]`
- `/purchase-orders/[purchaseOrderId]/edit`

## Scope exclusions

No backend code, API schema, endpoint, permission, migration, mobile code, or dependency is changed.
Sprint 3.3 adds no receipt, GRN, receiving, stock, warehouse receipt, AP, supplier invoice, payment,
credit, RFQ, purchase-request, approval-threshold, configurable workflow, tax, FX, attachment,
notification, or Release 6.0.4 behavior. Existing exact Decimal-string transport and display remain
unchanged.
