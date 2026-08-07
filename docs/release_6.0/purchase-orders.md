# Release 6.0.3 — Purchase Orders Architecture Freeze

| Contract metadata         | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Status                    | Reviewed implementation contract — ready to freeze                                                       |
| Release                   | 6.0.3 Purchase Orders                                                                                    |
| Branch                    | `feature/6.0.3-purchase-orders`                                                                          |
| Base                      | `develop` after Release 6.0.2 Business Partners                                                          |
| Migration ownership       | `0012_purchase_orders`                                                                                   |
| Canonical parent contract | [`docs/architecture/release-6.0-purchase-to-stock.md`](../architecture/release-6.0-purchase-to-stock.md) |

This document is the complete implementation contract for Release 6.0.3. It specializes the
approved Release 6.0 Purchase-to-Stock architecture for the Purchase Order slice. If this document
and the canonical parent contract appear to disagree, implementation must stop for architecture
review; it must not silently choose or invent behavior.

Release 6.0.3 builds directly on the canonical Release 6.0.2 Business Partner aggregate. It creates,
edits, submits, independently approves, rejects, revises, withdraws, cancels, lists, and displays
Purchase Orders. It does not receive them or affect inventory.

## 1. Scope and exclusions

### 1.1 Included

- Organization- and optional farm-scoped Purchase Order headers.
- Immutable supplier, item, unit, address, price, and currency snapshots.
- Draft line creation, update, replacement, and removal within the aggregate transaction.
- Server-generated organization/year PO numbers.
- Optimistic versioning for draft mutations and serialized lifecycle transitions.
- Independent approval: a creator can never approve their own PO.
- Append-only transition history and bounded domain audit events.
- Cursor-paginated APIs and permission-aware web routes.
- PostgreSQL migration, concurrency proof, regression coverage, and CI gates.
- Release 6.0.2 enforcement preventing removal of a supplier capability while a non-terminal PO
  depends on it.

### 1.2 Explicitly excluded

Release 6.0.3 must not implement, scaffold, or expose:

- Goods Receipts, Goods Receipt Numbers, or receipt sequences;
- Purchase Receipts, receipt headers, receipt lines, or receipt idempotency;
- receiving endpoints, `/receive` pages, receipt lists, or receipt links;
- inventory balances, lots, ledger transactions, stock movements, or inventory updates;
- Accounts Payable, supplier invoices, accounting entries, tax calculation, or valuation;
- payments, bank details, settlement status, or payment terms automation;
- receipt-service over-receipt logic, receipt reversal, supplier returns, or landed cost (the
  frozen line-accumulator database checks remain in migration 0012 for 6.0.4 safety);
- Release 6.0.4 migrations, permissions, audit events, UI, services, or placeholders.

The PO status enum includes `PARTIALLY_RECEIVED`, `RECEIVED`, and `CANCELLED_WITH_RECEIPTS` because
the frozen cross-release database contract assigns the complete enum to migration 0012. In Release
6.0.3 no public API or service may enter those states, and all received accumulators remain zero.

### 1.3 Canonical decision ledger

| Canonical decision          | Release 6.0.3 normalization                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Independent approval        | Required before future receiving; creator can never approve, including owner/admin                                             |
| General Business Partner    | PO references the 6.0.2 aggregate; no supplier-only identity/schema                                                            |
| Supplier governance         | Supplier capability and approved qualification required at submission; preference is display-only                              |
| Monetary intent             | Every line has `unit_price`; zero requires a non-empty explanatory line note                                                   |
| Currency                    | One uppercase ISO 4217 currency per PO; no mixed currency or organization backfill                                             |
| Decimal arithmetic          | `NUMERIC(18,6)` quantities, `NUMERIC(20,6)` money, server/client decimal arithmetic only                                       |
| Tax and FX                  | No tax fields/calculation and no exchange rates/conversion/base-currency reporting                                             |
| Purchase requests/RFQ       | No tables, endpoints, permissions, UI, or placeholder abstractions                                                             |
| Receipt ownership           | GRN, Purchase Receipt, receipt idempotency, warehouse receiving, stock effects, and inventory mutation remain 6.0.4            |
| Future over-receipt         | Line accumulator checks are created now; only 6.0.4 may mutate them under locks, never above ordered quantity                  |
| Future partial cancellation | `CANCELLED_WITH_RECEIPTS` means receipts remain valid and only the remainder closes; enum exists now but 6.0.3 cannot enter it |
| Returns/reversal            | Supplier returns and purchase-receipt reversal remain excluded                                                                 |
| Accounting                  | No AP, invoices, payments, valuation, or authoritative total beyond subtotal                                                   |

## 2. Dependency on Business Partners

The supplier is a Release 6.0.2 `BusinessPartner`; no supplier-only identity table or compatibility
layer is allowed.

A supplier may be selected on a new draft only when the partner belongs to the PO organization, is
not administratively deleted, is active, and has the `supplier` capability. Draft selection does not
require approved qualification: a buyer may prepare a draft while supplier governance is pending.

A draft may be submitted only when all of the following are true in the PO's organization:

1. the partner exists and is not administratively deleted;
2. the partner is active;
3. it has the `supplier` capability;
4. it has a supplier profile; and
5. `qualification_status == approved`.

`preference_tier=preferred` changes display and ordering hints only. It never bypasses validation or
authorization. Supplier contacts remain in the Business Partner aggregate and may be displayed for
reference, but a contact is not required on a PO and no contact FK is stored in 6.0.3.

The exclusive qualification enum means `blocked` and `unqualified` both fail the approved check;
`business_partner_blocked` remains the more specific conflict for blocked suppliers.

Supplier lifecycle behavior is frozen as follows:

- After draft creation, an inactive, deleted, unqualified, blocked, or no-longer-supplier partner
  does not erase the draft or its snapshots, but the draft cannot be submitted until eligibility is
  restored or another eligible supplier is selected.
- After submission but before approval, approval revalidates current supplier eligibility under the
  PO lock. If eligibility changed, approval fails with the applicable stable governance conflict;
  the PO remains `SUBMITTED` and may be withdrawn or cancelled.
- After approval, later partner deactivation, deletion, or qualification change does not invalidate,
  rewrite, or cancel the historical approved PO. The canonical future 6.0.4 rule still permits that
  approved PO to be received. New drafts/submissions remain subject to current eligibility.

The PO stores a restrictive live FK for navigation and validation plus supplier snapshots for
history. Later partner edits or deactivation never rewrite existing PO snapshots. Removing the
`supplier` capability is rejected while any PO for that partner is in `DRAFT`, `SUBMITTED`,
`APPROVED`, or `PARTIALLY_RECEIVED`. Release 6.0.3 can create only the first three of those states;
the fourth is included for the future 6.0.4 invariant.

Stable partner-governance conflicts are:

- `business_partner_inactive`
- `business_partner_not_supplier`
- `business_partner_not_approved`
- `business_partner_blocked`
- `business_partner_supplier_capability_in_use`

Foreign-tenant partner IDs are always hidden as 404 and never translated into governance conflicts.

## 3. Domain model and aggregate boundaries

### 3.1 Purchase Order aggregate

`PurchaseOrder` is the aggregate root. Its transactional boundary contains:

- one `purchase_orders` header;
- zero or more draft `purchase_order_lines` (submission requires at least one);
- one append-only `purchase_order_transitions` row per effective lifecycle change;
- the organization/year `purchase_order_sequences` row locked only while allocating a number; and
- the corresponding immutable domain `AuditEvent` rows.

A mutation commits or rolls back the aggregate, transition, version increment, and audit together.
No endpoint writes a line independently of its parent transaction. Lines may be represented as
subresources internally, but the public write contract is aggregate-oriented.

### 3.2 External aggregates

The PO references but does not own:

- `Organization` and optional `Farm` for tenancy and scope;
- `BusinessPartner` and its supplier profile/capability for supplier governance;
- `InventoryItem` for purchasable item identity; and
- `User` for lifecycle attribution.

Those records are never cascade-deleted by a PO. All history-bearing FKs use `RESTRICT`. Release
6.0.3 reads inventory item definitions only; it does not read or write lots, warehouses, storage
locations, balances, or transactions.

### 3.3 Value objects

- `PurchaseOrderStatus`: frozen enum in section 5.
- `CurrencyCode`: exactly three uppercase ASCII letters validated against the repository-owned
  officially assigned ISO 4217 set; no network lookup or runtime dependency.
- `DeliveryAddressSnapshot`: optional bounded object with exactly `line1`, `line2`, `city`, `region`,
  `postal_code`, and `country_code`; extra keys rejected; country is official ISO 3166-1 alpha-2.
- Quantities: decimal strings parsed to `Decimal`, maximum six fractional digits.
- Money: decimal strings parsed to `Decimal`, stored at six fractional digits.
- `ExpectedVersion`: required integer token on Draft PATCH. Named lifecycle operations serialize
  with a database row lock and revalidate the current state; the canonical API does not require a
  client version precondition for those operations.

## 4. Header and line contracts

### 4.1 Header

| Field                       | Type             | Null   | Mutability and rules                                                    |
| --------------------------- | ---------------- | ------ | ----------------------------------------------------------------------- |
| `id`                        | UUID             | No     | Server generated; immutable                                             |
| `organization_id`           | UUID FK          | No     | Immutable; tenant owner                                                 |
| `farm_id`                   | UUID FK          | Yes    | Draft-editable; must be active, visible, and belong to the organization |
| `business_partner_id`       | UUID FK          | No     | Draft-editable; supplier governance required                            |
| `po_number`                 | `VARCHAR(32)`    | No     | Server generated `PO-YYYY-NNNNNN`; immutable                            |
| `supplier_reference`        | `VARCHAR(120)`   | Yes    | Independent supplier reference; trimmed and bounded                     |
| `status`                    | enum             | No     | Named operations only; default `DRAFT`                                  |
| `currency_code`             | `CHAR(3)`        | No     | Uppercase official ISO 4217; draft-editable                             |
| `order_date`                | date             | No     | Required input; draft-editable                                          |
| `expected_delivery_date`    | date             | Yes    | Draft-editable; cannot precede `order_date`                             |
| `delivery_address`          | JSONB            | Yes    | Bounded snapshot; draft-editable                                        |
| `notes`                     | `VARCHAR(4000)`  | Yes    | Draft-editable; never copied into audit metadata                        |
| supplier snapshots          | bounded strings  | No/Yes | Refreshed from selected partner during draft; frozen on submit          |
| `version`                   | integer          | No     | Starts at 1; increments on each effective mutation/transition           |
| lifecycle actor/time fields | UUID/timestamptz | Yes    | Server controlled                                                       |
| `created_at`, `updated_at`  | timestamptz      | No     | Server controlled                                                       |

Supplier snapshots are `supplier_code`, `supplier_legal_name`, and optional
`supplier_trading_name`. The create response includes a generated PO number even while the document
is a draft.

These are the complete frozen header facts. Separate tax, discount, freight, invoice, payment,
warehouse, GRN, receipt, approval-threshold, soft-delete, and accounting-status fields are
unnecessary and prohibited. A separate `approved` boolean is also prohibited because status and
server-controlled approval attribution are authoritative.

### 4.2 Lines

| Field                         | Type            | Null   | Rules                                                |
| ----------------------------- | --------------- | ------ | ---------------------------------------------------- |
| `id`                          | UUID            | No     | Stable server-generated line identity                |
| `purchase_order_id`           | UUID FK         | No     | Immutable, `ON DELETE RESTRICT`                      |
| `line_number`                 | integer         | No     | Positive, unique per PO, deterministic request order |
| `inventory_item_id`           | UUID FK         | No     | Same organization, active, not deleted               |
| item snapshots                | bounded strings | No/Yes | Code/name and optional SKU frozen on submit          |
| `description`                 | `VARCHAR(500)`  | No     | Defaults from item name; non-blank                   |
| `line_note`                   | `VARCHAR(1000)` | Yes    | Required and non-blank when price is zero            |
| `ordered_quantity`            | `NUMERIC(18,6)` | No     | Greater than zero                                    |
| `ordered_unit`                | `VARCHAR(32)`   | No     | Snapshot; must be valid for the item                 |
| `canonical_unit`              | `VARCHAR(32)`   | No     | Snapshot from item definition                        |
| `ordered_quantity_canonical`  | `NUMERIC(18,6)` | No     | Positive exact repository unit conversion            |
| `received_quantity`           | `NUMERIC(18,6)` | No     | Default zero; immutable in 6.0.3                     |
| `received_quantity_canonical` | `NUMERIC(18,6)` | No     | Default zero; immutable in 6.0.3                     |
| `unit_price`                  | `NUMERIC(20,6)` | No     | Greater than or equal to zero                        |
| timestamps                    | timestamptz     | No     | Server controlled                                    |

Duplicate inventory items on separate lines are allowed because price, description, delivery intent,
or notes may differ. Line numbers are unique and positive. Reordering a draft deterministically
renumbers the submitted replacement list `1..N`; clients cannot create gaps or duplicate numbers.
The explanatory text for a zero price is the existing `line_note`; no second zero-price-reason or
accounting field is added.

Release 6.0.3 reuses `InventoryItem.canonical_unit`, the closed `StockUnit` enum, and
`app.inventory.units` exactly; it creates no purchasing-item or UOM table. `ordered_unit` may be the
item's canonical unit or an existing compatible unit: `kg <-> g` and `L <-> mL` convert exactly;
`count`, `bag`, and `pack` convert only to themselves. Cross-dimension and distinct count-like unit
conversion returns `unit_incompatible`. The item FK and frozen code/name/SKU/canonical-unit snapshots
provide history without creating a parallel catalog.

### 4.3 Totals and decimal behavior

Each extended amount is `ordered_quantity * unit_price`, calculated with `Decimal` and retained at
six decimal places. `subtotal` is derived server-side as the exact sum and is not an authoritative
database column. There is no tax, discount allocation, freight charge, grand total, exchange rate,
or base-currency total.

API quantities and money are JSON strings. The web client retains strings and uses a decimal
library; JavaScript binary floating-point arithmetic is prohibited. Display rounding uses the
currency's ISO minor units with `ROUND_HALF_UP`; stored/API facts remain six-decimal values.

## 5. Status state machine

Frozen enum values:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `PARTIALLY_RECEIVED` (reserved for 6.0.4)
- `RECEIVED` (reserved for 6.0.4)
- `CANCELLED`
- `CANCELLED_WITH_RECEIPTS` (reserved for 6.0.4)

Release 6.0.3 effective operations are:

| Operation    | Source                                                     | Target      | Permission               | Reason   | Version precondition | Replay                                                 |
| ------------ | ---------------------------------------------------------- | ----------- | ------------------------ | -------- | -------------------- | ------------------------------------------------------ |
| Create       | none                                                       | `DRAFT`     | `purchase_order.create`  | No       | N/A                  | Never                                                  |
| Draft update | `DRAFT`                                                    | `DRAFT`     | `purchase_order.update`  | No       | Required             | No-op returns unchanged version                        |
| Submit       | `DRAFT`                                                    | `SUBMITTED` | `purchase_order.submit`  | No       | No                   | `SUBMITTED` returns current PO                         |
| Withdraw     | `SUBMITTED`                                                | `DRAFT`     | `purchase_order.update`  | Required | No                   | `DRAFT` only if last effective transition was withdraw |
| Approve      | `SUBMITTED`                                                | `APPROVED`  | `purchase_order.approve` | Optional | No                   | `APPROVED` returns current PO                          |
| Reject       | `SUBMITTED`                                                | `REJECTED`  | `purchase_order.reject`  | Required | No                   | `REJECTED` returns current PO                          |
| Revise       | `REJECTED`                                                 | `DRAFT`     | `purchase_order.update`  | Required | No                   | `DRAFT` only if last effective transition was revise   |
| Cancel       | `DRAFT`, `SUBMITTED`, `REJECTED`, or unreceived `APPROVED` | `CANCELLED` | `purchase_order.cancel`  | Required | No                   | `CANCELLED` returns current PO                         |

Withdraw/revise replay is identified from append-only transition history; a generic `DRAFT` is not
enough to infer which operation previously occurred. A replay returns `X-Idempotent-Replay: true`,
does not increment `version`, and emits neither duplicate transition nor duplicate audit rows.

Every other source/operation combination returns 409 `invalid_purchase_order_transition`. There is
no arbitrary status PATCH or generic transition endpoint. Receipt-reserved states are unreachable in
6.0.3 and transitions into them are rejected.

Submission validates the complete document and freezes all commercial fields and lines. Approved
and terminal documents cannot be amended. An approved PO cannot be cancelled if either received
accumulator is nonzero; although 6.0.3 cannot create that condition, the rule is included so 6.0.4
does not weaken the aggregate.

The canonical transition table omits `REJECTED` from one cancel-source cell, while its state-centric
table and invalid-transition matrix both allow rejection-to-cancellation. This release normalizes
the repeated canonical decision: `REJECTED -> CANCELLED` is allowed with `purchase_order.cancel` and
a required reason.

| Status                    | Meaning                                             | Allowed operations                                                                         | Editable | Cancellation                     | Classification                     |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------: | -------------------------------- | ---------------------------------- |
| `DRAFT`                   | Mutable working document                            | update, submit, cancel                                                                     |      Yes | `CANCELLED`, reason required     | Non-terminal                       |
| `SUBMITTED`               | Frozen and awaiting independent decision            | withdraw, approve, reject, cancel                                                          |       No | `CANCELLED`, reason required     | Non-terminal                       |
| `APPROVED`                | Independently approved future receiving authority   | cancel only while both received accumulators are zero; receipt transitions belong to 6.0.4 |       No | `CANCELLED` before any receipt   | Non-terminal                       |
| `REJECTED`                | Frozen rejected submission                          | revise, cancel                                                                             |       No | `CANCELLED`, reason required     | Non-terminal                       |
| `PARTIALLY_RECEIVED`      | Some quantity posted; 6.0.4-owned state             | no 6.0.3 operation except the already-frozen future cancel-remainder rule                  |       No | Future `CANCELLED_WITH_RECEIPTS` | Non-terminal, unreachable in 6.0.3 |
| `RECEIVED`                | All ordered quantity posted                         | none                                                                                       |       No | Prohibited                       | Terminal, unreachable in 6.0.3     |
| `CANCELLED`               | Closed with no posted receipts                      | none; cancel replay only                                                                   |       No | Already terminal                 | Terminal                           |
| `CANCELLED_WITH_RECEIPTS` | Remainder closed while posted receipts remain valid | none; cancel replay only                                                                   |       No | Already terminal                 | Terminal, unreachable in 6.0.3     |

Each effective operation emits its same-named audit action; lifecycle operations also append the
transition row and `purchase_order.transition` audit described in section 8.

### 5.1 Independent approval

Approval is rejected with 409 `purchase_order_self_approval_forbidden` whenever
`current_user.id == purchase_order.created_by_id`. This invariant applies to organization owners,
platform administrators, and wildcard permissions. Submitter identity does not replace creator
identity for this check. No override, delegation, threshold, or emergency bypass exists.

- The same user may create and submit, but their later approval attempt is rejected server-side.
- Approval locks the PO and atomically revalidates permission, active scope, `SUBMITTED` state,
  supplier eligibility, and creator identity before writing status, actor/time, version, transition,
  and audit.
- Two concurrent approvals serialize. The winner performs the transition; a later same-target
  request by another eligible non-creator is an idempotent replay with no duplicate history/audit.
- A concurrent conflicting reject/cancel wins or loses by lock order; the loser receives
  `invalid_purchase_order_transition`, never silent last-write-wins.
- Draft edits cannot race an approval because approval is legal only after submission and submitted
  content is immutable. Edit versus submit serializes; the edit either commits before submission or
  receives a version/state conflict afterward.
- Supplier eligibility is validated at submission and again at approval. Governance changes between
  those operations prevent approval but never mutate the PO implicitly.

## 6. Permissions and authorization

Frozen permission codes:

- `purchase_order.read`
- `purchase_order.create`
- `purchase_order.update`
- `purchase_order.submit`
- `purchase_order.approve`
- `purchase_order.reject`
- `purchase_order.cancel`

No `delete`, `transition`, `receive`, or administrative override permission is added.

| Permission               | Org owner | Farm director | Farm manager | Supervisor | Storekeeper | Accountant | Viewer |                 Platform admin |
| ------------------------ | --------: | ------------: | -----------: | ---------: | ----------: | ---------: | -----: | -----------------------------: |
| `purchase_order.read`    |       Yes |           Yes |       Scoped |     Scoped |      Scoped |        Yes |    Yes |                       Wildcard |
| `purchase_order.create`  |       Yes |           Yes |       Scoped |         No |          No |         No |     No |                       Wildcard |
| `purchase_order.update`  |       Yes |           Yes |       Scoped |         No |          No |         No |     No |                       Wildcard |
| `purchase_order.submit`  |       Yes |           Yes |       Scoped |         No |          No |         No |     No |                       Wildcard |
| `purchase_order.approve` |       Yes |           Yes |           No |         No |          No |         No |     No | Wildcard, except self-approval |
| `purchase_order.reject`  |       Yes |           Yes |           No |         No |          No |         No |     No |                       Wildcard |
| `purchase_order.cancel`  |       Yes |           Yes |           No |         No |          No |         No |     No |                       Wildcard |

Authorization is permission-driven; services never inspect role names. Organization grants apply to
all POs in the organization. Farm grants apply only when the PO has that exact farm and the role
assignment, organization membership, farm membership, organization, and farm are active and not
deleted. Stale or revoked grants confer no access.

For organization-owned unassigned POs (`farm_id IS NULL`), farm-scoped grants do not apply. Only an
organization-scoped grant may read or mutate them. A farm-scoped creator must supply their authorized
farm at create time and cannot move the draft to another farm.

Authorization is revalidated inside the transaction after locking the PO for every mutation. This
closes races where membership, assignment, farm lifecycle, or organization lifecycle changes after
the endpoint's initial dependency check. Read paths use the established active-scope resolver.

Tenant behavior:

- foreign organization, partner, farm, item, or PO: tenant-hidden 404;
- visible tenant but missing permission: 403 with stable permission detail;
- visible same-tenant invalid lifecycle/governance input: stable 409/422 as appropriate;
- platform administrators retain wildcard access but not self-approval.

No warehouse, storage location, production site, or receiving site is referenced by the 6.0.3 PO
contract. A client-supplied field or query parameter for one is rejected as an unknown field (422),
not resolved or authorized. Warehouse tenancy begins only at the 6.0.4 receipt boundary.

List queries must constrain organization and effective farm scope in SQL; they must not load a broad
tenant list and filter it in application memory.

## 7. Validation rules and stable errors

### 7.1 Create and draft update

- A draft may be created with zero or more lines. Submission requires at least one line. This keeps
  Draft genuinely editable without weakening submission validation.
- Organization, farm, supplier, and every item are resolved tenant-hidden before semantic errors.
- Farm must be active, not deleted, and belong to the organization.
- Supplier must satisfy the draft-selection rules in section 2 on create/change and the stricter
  approved-qualification rules on submit and approve.
- Items must be active, not deleted, and owned by the PO organization.
- Currency is a real uppercase ISO 4217 code.
- Expected delivery date cannot precede order date.
- Text fields are trimmed, length-bounded, and reject blank values where required.
- Address keys and sizes are bounded; country codes reuse the strict 6.0.2 ISO validator.
- Quantities are positive, finite decimal values with at most six fractional digits.
- Unit price is finite, non-negative, and has at most six fractional digits.
- Zero unit price requires a non-empty line note.
- Ordered unit must be supported by the item and exactly convertible to its canonical unit through
  the repository unit conversion rules.
- Duplicate line IDs, unknown line IDs, duplicate line numbers, and client-supplied snapshot or
  received fields are rejected.
- PATCH distinguishes omitted values from explicit null for nullable header fields.
- An effective draft mutation increments `version` exactly once; semantic no-op does not.

### 7.2 Submission

Submission repeats all governance and line validation under locks. It requires at least one valid
line, recomputes snapshots/conversions/totals from authoritative records, and rejects stale or
changed dependencies. No submitted value is trusted merely because draft creation validated it.

### 7.3 Error contract

Errors use the existing envelope:

```json
{
  "detail": {
    "code": "purchase_order_version_conflict",
    "message": "The Purchase Order was changed by another request.",
    "context": { "current_version": 4 }
  }
}
```

Canonical frozen PO conflict codes used by 6.0.3 are:

- `invalid_purchase_order_transition`
- `duplicate_purchase_order_number`
- `purchase_order_version_conflict`
- `purchase_order_self_approval_forbidden`
- `business_partner_inactive`
- `business_partner_not_supplier`
- `business_partner_not_approved`
- `business_partner_blocked`
- `unit_incompatible`
- `ordered_unit_mismatch`

`duplicate_purchase_order_number` translates the authoritative unique-constraint race. Supplier
capability removal while a non-terminal PO depends on it returns the release-specific 409
`business_partner_supplier_capability_in_use` with bounded dependency context. It adds no permission
or purchasing lifecycle state and implements the canonical prohibition on removing a capability in
use. Immutable-state, empty-line, zero-price-note, farm, item, date, range, and shape failures use the
standard 409/422 envelope without inventing additional canonical Release 6.0 conflict codes.

Validation shape/type/range errors are 422. Missing authentication is 401; absent permission is 403;
tenant-hidden references are 404; state, version, governance, sequence, and known uniqueness races
are 409. Error context is bounded and never exposes foreign-tenant IDs or request payloads.

## 8. Audit and transition history

### 8.1 Domain audit events

Every effective mutation emits exactly one bounded domain audit event:

- `purchase_order.create`
- `purchase_order.update`
- `purchase_order.submit`
- `purchase_order.withdraw`
- `purchase_order.approve`
- `purchase_order.reject`
- `purchase_order.revise`
- `purchase_order.cancel`

Line additions, updates, removals, and reordering are aggregate Draft mutations and are audited as
`purchase_order.update` with bounded `added_line_ids`, `updated_line_ids`, `removed_line_ids`, and
changed-field names. Separate `purchase_order.line.*` audit actions are intentionally not added
because the canonical audit action set does not define them.

Line-change metadata records counts and at most the first 50 sorted UUIDs per category plus a
`line_ids_truncated` flag. This makes the payload bounded even for a large draft; it is not a copy of
the line bodies or commercial values.

Every effective lifecycle change also emits `purchase_order.transition`. Thus a transition operation
atomically creates its named domain event, the generic transition audit event, and one
`purchase_order_transitions` row. Create records an initial transition from null to `DRAFT` plus the
create event.

Audit rows use `entity_type=purchase_order`, the PO ID, organization, optional farm, actor, request
ID, IP, and user agent. Metadata is limited to PO number, old/new status, old/new version, changed
field names, line counts, transition ID, and bounded reason. It must never contain full lines,
addresses, supplier/contact PII, notes, prices, raw request payloads, credentials, or unbounded
before/after documents.

No-op/replayed operations create no new transition or audit event. Failed transactions create no
domain audit row. Permission denials use the existing rate-limited security logging and tenant-hidden
attempts reveal no resource identity.

### 8.2 Transition rows

`purchase_order_transitions` is append-only. There is no update/delete API or repository method.
Each row contains `from_status`, `to_status`, actor, server timestamp, optional reason, bounded JSONB
metadata, request ID, and created timestamp. Reasons are mandatory for withdraw, reject, revise, and
cancel and capped at 500 characters.

## 9. API contract

All routes are under `/api/v1`.

| Method and path                                         | Permission               | Allowed state                                           | Success           | Replay/conflict                                         | Audit                       |
| ------------------------------------------------------- | ------------------------ | ------------------------------------------------------- | ----------------- | ------------------------------------------------------- | --------------------------- |
| `GET /organizations/{organization_id}/purchase-orders`  | `purchase_order.read`    | Any visible                                             | 200 cursor page   | Invalid cursor 422                                      | None                        |
| `POST /organizations/{organization_id}/purchase-orders` | `purchase_order.create`  | New                                                     | 201 `DRAFT`       | New number; known uniqueness race 409                   | create + initial transition |
| `GET /purchase-orders/{purchase_order_id}`              | `purchase_order.read`    | Any visible                                             | 200 detail        | Foreign/inaccessible 404                                | None                        |
| `PATCH /purchase-orders/{purchase_order_id}`            | `purchase_order.update`  | `DRAFT`                                                 | 200 updated draft | Expected-version conflict 409; immutable state 409      | update                      |
| `POST /purchase-orders/{purchase_order_id}/submit`      | `purchase_order.submit`  | `DRAFT`                                                 | 200 `SUBMITTED`   | Same target replay; otherwise transition/governance 409 | submit + transition         |
| `POST /purchase-orders/{purchase_order_id}/withdraw`    | `purchase_order.update`  | `SUBMITTED`                                             | 200 `DRAFT`       | Proven same-operation replay; otherwise transition 409  | withdraw + transition       |
| `POST /purchase-orders/{purchase_order_id}/approve`     | `purchase_order.approve` | `SUBMITTED`                                             | 200 `APPROVED`    | Same target replay; self/governance/transition 409      | approve + transition        |
| `POST /purchase-orders/{purchase_order_id}/reject`      | `purchase_order.reject`  | `SUBMITTED`                                             | 200 `REJECTED`    | Same target replay; otherwise transition 409            | reject + transition         |
| `POST /purchase-orders/{purchase_order_id}/revise`      | `purchase_order.update`  | `REJECTED`                                              | 200 `DRAFT`       | Proven same-operation replay; otherwise transition 409  | revise + transition         |
| `POST /purchase-orders/{purchase_order_id}/cancel`      | `purchase_order.cancel`  | `DRAFT`, `SUBMITTED`, `REJECTED`, unreceived `APPROVED` | 200 `CANCELLED`   | Same target replay; otherwise transition 409            | cancel + transition         |
| `GET /purchase-orders/{purchase_order_id}/transitions`  | `purchase_order.read`    | Any visible                                             | 200 cursor page   | Invalid cursor 422                                      | None                        |

Every resource endpoint resolves tenancy before permission: foreign/inaccessible is 404 and a
correct-tenant user lacking the listed permission is 403. There is no DELETE endpoint, line-specific
write endpoint, arbitrary transition endpoint, receipt endpoint, or received-quantity mutation.
Responses use strings for decimals and include the current
`version`. Draft PATCH carries `expected_version`; missing values are 422. Named lifecycle operations
do not require a version field and instead lock/revalidate current state atomically.

List ordering is deterministic `created_at DESC, id DESC`. Its opaque cursor contains those keys.
Filters are `farm_id`, `business_partner_id`, repeatable `status`, `order_date_from`, `order_date_to`,
`expected_delivery_from`, `expected_delivery_to`, and bounded `search` over PO number, supplier
reference, and frozen supplier names/code. Default and maximum page sizes are 50 and 200. Malformed
cursors return 422 `invalid_cursor`.

Create accepts the header fields and an optional complete line list. PATCH accepts only mutable header
fields plus an optional complete line replacement; omitted `lines` leaves lines unchanged. It does
not accept status, number, snapshots, received values, version, attribution, or timestamps.

## 10. PostgreSQL schema

Migration `0012_purchase_orders` is linear after `0011_business_partners` and creates one enum and
four tables.

### 10.1 `purchase_order_status` enum

Values are the exact eight uppercase values in section 5 in PostgreSQL and the public API. Migration,
model, and schema serialization must agree. No later migration may recreate or shadow it.

### 10.2 `purchase_order_sequences`

- `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT`
- `year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999)`
- `last_value BIGINT NOT NULL DEFAULT 0 CHECK (last_value >= 0)`
- `updated_at TIMESTAMPTZ NOT NULL`
- primary key `(organization_id, year)`

Allocation locks/upserts exactly one organization/year row and formats
`PO-{year}-{last_value:06d}`. The canonical six-digit component is zero-padded; this release does not
invent an exhaustion policy or a sequence-conflict code beyond the authoritative unique constraint.
Gaps caused by rollback or failed work are acceptable; reuse is forbidden.

### 10.3 `purchase_orders`

Columns implement section 4.1 with restrictive FKs to organizations, farms, business partners, and
users. Required constraints/indexes:

- primary key `id`;
- unique `(organization_id, po_number)`;
- check `version >= 1`;
- check non-empty PO number, currency, and supplier snapshot names/code;
- check expected delivery is null or not before order date;
- index `(organization_id, status, created_at DESC, id DESC)`;
- index `(farm_id, status, created_at DESC, id DESC)`;
- index `business_partner_id`;
- indexes `order_date` and `expected_delivery_date`;
- no `deleted_at`, delete cascade, or hard-delete lifecycle.

Lifecycle attribution columns are `created_by_id`, `submitted_by_id/at`, `approved_by_id/at`,
`rejected_by_id/at`, and `cancelled_by_id/at`. Withdrawal and revision attribution lives in immutable
transition history; current-header duplication is unnecessary.

### 10.4 `purchase_order_lines`

Columns implement section 4.2. Required constraints/indexes:

- primary key `id`;
- restrictive FKs to the PO and inventory item;
- unique `(purchase_order_id, line_number)`;
- check `line_number > 0`;
- checks ordered quantities `> 0`;
- checks received quantities `>= 0` and `<=` corresponding ordered quantities;
- check `unit_price >= 0`;
- check zero price implies non-blank line note;
- check non-empty snapshot code/name/unit fields;
- index `(purchase_order_id, line_number)` and `inventory_item_id`.

The API prevents direct received-value writes; DB checks provide defense in depth and prepare the
same rows for 6.0.4 without a competing PO migration.

### 10.5 `purchase_order_transitions`

- UUID primary key and restrictive PO/actor FKs;
- nullable `from_status`, required `to_status`;
- `occurred_at TIMESTAMPTZ NOT NULL` from the server;
- optional `reason VARCHAR(500)`;
- bounded `metadata JSONB`, optional request ID, and `created_at`;
- index `(purchase_order_id, occurred_at, id)`;
- no `updated_at`, soft-delete, or mutation API.

### 10.6 Downgrade and portability

Downgrade removes transitions, lines, orders, sequences, then the enum, permissions, and seeded
grants in dependency-safe order. Upgrade/downgrade is deterministic on PostgreSQL. SQLite may use a
non-native enum/JSON variant for fast unit tests, but it is not accepted as migration or concurrency
proof.

## 11. Migration plan

1. Confirm `0011_business_partners` is the sole current Alembic head.
2. Add exactly `0012_purchase_orders` with `down_revision="0011_business_partners"`.
3. Create the status enum once with explicit PostgreSQL-safe existence behavior.
4. Create sequence, header, line, and transition tables in dependency order.
5. Add seven PO permissions idempotently.
6. Seed role grants exactly as section 6; do not seed any receipt permissions.
7. Add no data backfill: the tables are new and existing partners remain unchanged.
8. Extend Business Partner supplier-capability removal checks through service/repository queries;
   do not alter migration 0011.
9. Prove upgrade from the current `develop`, downgrade to 0011, and re-upgrade.
10. Verify one Alembic head and schema/model constraint parity.

No schema change belongs in `0011_business_partners`. No `0013` artifact may appear in this branch.

## 12. Concurrency and transaction strategy

### 12.1 Draft mutations

PATCH performs a conditional version check under a `SELECT ... FOR UPDATE` lock on the PO. A stale
expected version returns `purchase_order_version_conflict` with the current version. The service
revalidates authorization and state after acquiring the lock, applies header/line changes, increments
version once, appends audit, and commits atomically.

Line replacement locks the PO first, then reads item dependencies in sorted UUID order. This gives a
single lock order for competing requests. Known unique and check races are translated to stable
409/422 envelopes; raw `IntegrityError` never escapes as 500, and the failed transaction is rolled
back before further session use.

### 12.2 Lifecycle transitions

Named transitions lock the PO, revalidate active scope, reload state, validate
the operation, update attribution/status/version, append transition and audit rows, and commit as one
transaction. Concurrent approve/reject/cancel or update/submit operations serialize on the PO; one
wins and the other receives replay or version/transition conflict according to the resulting state.

The independent-approval check occurs after the lock and compares the authenticated actor to the
immutable creator ID.

### 12.3 Sequence allocation

PO number allocation uses an atomic PostgreSQL upsert/row lock keyed by `(organization_id, year)`.
Concurrent creates in one tenant/year receive distinct increasing numbers. Different organizations
or years do not contend on the same row. The unique PO constraint is authoritative, and a known race
returns a stable conflict. No `MAX(po_number)+1` query is allowed.

### 12.4 Dependency races

Submit and approve lock or re-read the partner/profile/capability and farm after locking the PO;
submit also locks/re-reads items in deterministic UUID order. Partner capability removal checks
non-terminal PO existence in its own transaction. Tests must prove that concurrent submit or approve
versus partner deactivation, qualification change, capability removal, farm deactivation, or
membership/assignment revocation cannot accept stale governance or authorization.

## 13. Frontend routes and UX

### 13.1 Routes shipped in 6.0.3

- `/purchase-orders?organization_id=...`
- `/purchase-orders/new?organization_id=...`
- `/purchase-orders/[purchaseOrderId]`
- `/purchase-orders/[purchaseOrderId]/edit`

There is no `/receive` route and no `/purchase-receipts` route in this release.

### 13.2 List flow

The list provides organization selection, scoped farm, supplier, status, order/delivery date, and
search filters; cursor pagination; loading, empty, forbidden, and unavailable states; and a create
action only when authorized. Rows show PO number, supplier snapshot, farm, status, order date,
expected delivery, subtotal/currency, and creator.

Organization/farm switches synchronously invalidate the request generation and clear prior-tenant
rows/errors. Late successes and failures are ignored. Scoped users cannot select or infer farms
outside their active scope.

### 13.3 Create/edit flow

The editor is a responsive header plus line-card/table form:

1. choose organization and, when applicable, an authorized farm;
2. select an active supplier-capable Business Partner and display its qualification separately;
3. set currency, dates, optional supplier reference, delivery address, and notes;
4. add one or more active organization inventory items;
5. enter ordered unit/quantity, unit price, description, and optional note;
6. display decimal-safe line extensions and subtotal;
7. save as draft, then navigate to detail.

Supplier search is supplier-oriented. New-draft selection includes active supplier-capable partners;
qualification and preference are shown distinctly. Unqualified/blocked suppliers may be retained in
a draft but submission is disabled with the applicable reason. Edit loads only a `DRAFT`; immutable states redirect to
detail with a stable explanation. PATCH sends the loaded version. A version conflict retains local
input, fetches current server state, and offers explicit reload/reconcile rather than silent overwrite.

Nullable fields distinguish untouched, cleared, and populated values. Keyboard operation, semantic
labels, error summary/field linkage, focus management, `aria-live`, non-color state cues, and 44px
targets are required.

### 13.4 Detail and lifecycle flow

Detail renders frozen supplier/item/address/unit/price snapshots, exact subtotal/currency, current
version, creator and lifecycle attribution, and transition timeline. Received/remaining columns may
display ordered and zero received quantities for forward-compatible document layout, but no receive
action or inventory link is shown.

Actions are both state- and permission-aware:

- edit and submit for eligible draft users;
- withdraw for eligible submitted users;
- approve/reject for authorized non-creators;
- revise for eligible rejected users;
- cancel where the state and permission allow it.

Reason-required operations use accessible confirmation dialogs. The UI hides self-approval but the
API remains authoritative. Replayed operations refresh detail without duplicate success history.

### 13.5 Client safety and errors

- Reuse the shared 401 single-flight refresh path.
- 403 displays forbidden without redirect loops.
- Tenant-hidden 404 displays a generic unavailable state.
- Generation, route identity, tenant identity, mutation token, mounted state, and expected version
  guard every load and post-mutation refresh.
- Route/organization/farm changes synchronously invalidate earlier loads and mutations.
- Stale success, 403, 404, 409, and generic errors are no-ops for the new route/tenant.
- StrictMode double effects cannot duplicate mutations.
- Stable 409 codes map to explicit lifecycle refresh, version reconciliation, or field correction.

No new global state library is introduced. Existing API, error, permission, dialog, table, badge,
decimal, and stale-response patterns are reused.

## 14. Regression test plan

### 14.1 Backend integration

Tests must cover:

- create with generated number, snapshots, exact decimals, lines, initial transition, and audit;
- list filters, deterministic cursor pagination, scoped farm visibility, and search;
- detail snapshot stability after supplier/item edits and deactivation;
- draft header/line update, add/remove/reorder, explicit-null clearing, no-op, and version increments;
- every allowed transition, required reasons, attribution, version, transition, and audit;
- every invalid source/operation combination including all receipt-reserved states;
- replay behavior with header, version, transition count, audit count, and replay header assertions;
- immutable submitted/approved/cancelled documents;
- creator self-approval rejection for owner, farm director, platform admin, and wildcard actors;
- supplier active/capability/profile/qualification/blocked/preferred rules;
- supplier capability removal blocked by non-terminal POs and allowed after terminal states;
- farm/item lifecycle and organization ownership validation;
- official currency/country validation, date ordering, bounds, extra fields, and malformed decimals;
- zero-price note, unit compatibility, conversion precision, derived totals, and six-decimal retention;
- all seven permissions, role matrix, active farm scopes, revoked/stale memberships/assignments/farms;
- foreign-tenant PO/partner/farm/item 404 versus correct-tenant permission 403;
- bounded audit metadata without notes, addresses, prices, PII, or full payloads;
- known uniqueness/check races translated to stable errors and clean rollback;
- no delete, receipt, arbitrary status, inventory, AP, or payment endpoint.

### 14.2 PostgreSQL-only concurrency

Tests against real PostgreSQL must prove:

- concurrent sequence allocation yields unique monotonic numbers per organization/year;
- different organizations/years remain independently scoped;
- concurrent PATCH with the same expected version has one winner and one stable version conflict;
- concurrent submit/update, approve/reject, approve/cancel, and submit/cancel serialize deterministically;
- self-approval remains forbidden under concurrency;
- submit or approve racing partner deactivation, qualification change, supplier capability removal,
  farm deactivation, or membership/assignment revocation cannot accept stale governance/scope;
- submit racing item deactivation cannot accept stale item data; approval uses the already-frozen
  submitted item snapshots;
- opposing request line order does not deadlock because dependencies lock in sorted order;
- losing transactions roll back cleanly and leave one coherent state, version, history, and audit set;
- migration constraints reject received values above ordered values even though 6.0.3 cannot write them.

SQLite tests are useful for schema/service speed but do not satisfy these concurrency requirements.

### 14.3 Frontend route-level tests

Tests must cover:

- list render/filter/pagination and permission-gated create action;
- organization and farm switches with late prior-scope success and error;
- create/edit decimal-safe totals, line workflows, validation, explicit null, and API envelopes;
- supplier governance displays for approved, unqualified, blocked, inactive, and preferred;
- detail snapshot/address rendering, attribution, timeline, and all state badges;
- edit/submit/withdraw/approve/reject/revise/cancel visibility and successful flows;
- self-approval action hidden and server rejection handled;
- version conflict reconciliation without losing unsaved input;
- stale detail/edit loads and route/tenant changes during every mutation class;
- stale success, 401 recovery, 403, tenant-hidden 404, 409, generic error, and unmount behavior;
- StrictMode mutation safety and shared auth refresh behavior;
- accessibility: labels, error summary, focus, keyboard dialogs, `aria-live`, and non-color status;
- explicit absence of receive, receipt, inventory, AP, and payment actions/routes.

### 14.4 Regression suites

The full API, tenant-isolation, authorization, Business Partner, inventory, frontend, and Alembic
suites must remain green. Business Partner contact/country/audit behavior must not regress. Existing
inventory semantics must be byte-for-byte behaviorally unaffected because this release performs no
inventory write.

## 15. Implementation order

1. Add model/schema enums and migration 0012 with permissions/grants.
2. Add repositories for sequence, header/lines, transition history, and scoped reads.
3. Add service invariants, decimal/unit validation, snapshots, versioning, audit, and error mapping.
4. Extend Business Partner supplier-capability removal protection.
5. Add permission/tenant dependencies and Purchase Order endpoints.
6. Land backend integration and PostgreSQL concurrency proof before frontend work.
7. Add typed web client and decimal-safe helpers.
8. Add list, create, detail, and edit routes with stale-state guards and accessible lifecycle dialogs.
9. Add targeted frontend tests, full regression runs, migration round-trip, and documentation checks.

No implementation step may add a Release 6.0.4 artifact.

## 16. CI acceptance criteria

Release 6.0.3 is acceptable only when the current PR head passes all of the following:

- Ruff and Black checks for the entire API tree;
- targeted Purchase Order backend tests;
- full API suite on PostgreSQL with no flaky rerun required;
- targeted PostgreSQL sequence, lifecycle, version, authorization-race, and rollback tests;
- tenant-isolation, permission, Business Partner, and inventory regression suites;
- Prettier, ESLint, and TypeScript checks;
- targeted Purchase Order Vitest route tests;
- full frontend Vitest suite;
- production web build;
- Alembic current-head check and PostgreSQL upgrade/downgrade/re-upgrade round-trip;
- one and only one Alembic head;
- Mongo Guard and repository security audit under existing policy;
- `git diff --check`, no generated/temp test artifacts, and no unrelated changes;
- architecture scope scan proving no receipt, GRN, inventory mutation, AP, payment, or 6.0.4 code;
- migration diff proving 0011 is unchanged and 0012 is the only new migration.

Required checks must pass on the final head and again on `develop` after merge. A rerun may diagnose
an established unrelated flake, but Release 6.0.3 is not accepted on unexplained or release-related
flakiness.

## 17. Definition of done

Release 6.0.3 is complete only when:

- the architecture in this document is implemented without deviation;
- a user can create and edit a valid draft with exact decimal lines and historical snapshots;
- authorized users can submit, withdraw, independently approve, reject, revise, and cancel through
  named operations only;
- creator self-approval is impossible for every role including platform administrator;
- tenant/farm scope, stale grant, governance, version, and concurrency rules are proven on PostgreSQL;
- sequence, transition, audit, snapshot, and immutable-submission contracts are complete;
- web routes are permission-aware, accessible, tenant-safe, route-safe, and decimal-safe;
- all CI acceptance criteria pass; and
- no Goods Receipt, Purchase Receipt, inventory update, stock movement, AP, payment, or Release 6.0.4
  behavior exists in the branch.

Any proposed deviation requires architecture approval before source code or migration work begins.
