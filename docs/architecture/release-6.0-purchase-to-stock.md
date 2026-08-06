# Release 6.0 Purchase-to-Stock Architecture Freeze

| Contract metadata | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Status            | Approved implementation contract                              |
| Baseline          | `develop` at `090d9186d7cd28c1fb03814029b24b237c4c1d48`       |
| Scope             | Release 6.0 Purchase-to-Stock MVP                             |
| Audience          | Codex, Emergent, reviewers, maintainers, and future engineers |

This document is the authoritative Release 6.0 purchasing contract. Implementation must conform
to it. A deviation requires architecture approval before code or migrations are changed.

## 1. Product decisions

### 1.1 Independent approval

- Every purchase order (PO) requires approval before receiving.
- No user may approve a PO they created. Approval permission never overrides this rule.
- The prohibition applies to organization owners, platform administrators, and all other roles.
- A one-user organization must add a second authorized user to complete purchase-to-stock.
- Submission, approval, and receipt are separate permissions.

### 1.2 Mandatory monetary intent

- Every PO line requires a non-null unit price.
- Zero price is allowed only with a non-empty explanatory line note. It may represent a donation,
  warranty replacement, promotion, allocation, or other non-cash procurement.
- Money uses fixed-precision decimals. Floating-point money is prohibited.
- Release 6.0 does not provide accounting, accounts payable (AP), payments, tax, or valuation.

### 1.3 General Business Partner architecture

- Release 6.0 implements a general Business Partner aggregate, not a supplier-only schema.
- The Release 6.0 product language and UI are supplier-oriented.
- Capabilities are multi-valued and initially include `supplier`, `customer`, `transporter`,
  `contractor`, `veterinary_service`, `laboratory`, `consultant`, and `other`.
- Only the `supplier` capability is operationally consumed by Release 6.0 purchasing.
- A partner may hold several capabilities without duplicating its identity.

### 1.4 Partial cancellation

The terminal state for a partially received PO whose remainder is intentionally cancelled is
`CANCELLED_WITH_RECEIPTS`.

This name is deliberately explicit: `CANCELLED` means nothing was received, while
`CANCELLED_WITH_RECEIPTS` means posted receipts and their stock effects remain valid but no more
receiving is allowed. Cancellation does not alter received quantities, receipt history, lots, or
inventory transactions.

### 1.5 Purchase requests

Purchase requests are excluded. No request tables, endpoints, permissions, or placeholder
abstractions are allowed. A future release may add an optional `source_type`/`source_id` association
to a PO without changing the PO aggregate.

### 1.6 Over-receipt

- Cumulative receipt quantity may never exceed ordered quantity at line level.
- Release 6.0 has no tolerance setting.
- Service logic, locked accumulators, database checks, and PostgreSQL concurrency tests enforce the
  rule.

### 1.7 Currency

- Currency is mandatory per PO and uses an uppercase ISO 4217 code.
- Release 6.0 has no exchange rates, conversion, base-currency reporting, or FX accounting.
- No organization-wide currency migration or backfill is required.
- Money columns use `NUMERIC(20, 6)`. Calculations use `Decimal` only.

### 1.8 Tax

Tax is deferred entirely. There are no structured tax fields, calculated tax amounts, or tax
components in authoritative totals. If an operator needs to retain supplier tax context, it may be
written in ordinary notes and is unstructured, informational, and non-authoritative. This avoids
implying statutory accounting support.

### 1.9 Receipt reversal and supplier returns

- Purchase-receipt reversal and supplier returns are deferred.
- Purchasing UI must not call generic inventory reversal for a purchasing-linked transaction.
- A correction requires an explicit inventory adjustment and an operational incident record.
- The PO, goods receipt, received accumulators, and purchase history remain unchanged.

## 2. Architecture scope

Release 6.0 is the **Purchase-to-Stock MVP**:

```text
Business Partner
    -> Purchase Order
    -> Submit
    -> Independent Approval
    -> Partial or Complete Receipt
    -> Inventory Lot
    -> Immutable Inventory Ledger
    -> Audit and Traceability
```

Release 6.0 explicitly excludes:

- accounting, AP, supplier invoices, and payment processing;
- tax calculation, exchange rates, inventory valuation, and landed cost;
- requests for quotation (RFQs), quote comparison, and purchase requests;
- configurable approvals, thresholds, and custom roles;
- supplier returns and receipt reversals;
- attachments, notifications, and background jobs;
- sales, mobile purchasing, and barcode scanning.

## 3. Existing architecture that must be reused

Purchasing extends, rather than replaces, these patterns:

- organization/farm ownership and tenant-hiding dependencies in `app/deps.py`;
- memberships, role assignments, scoped permission resolution, and organization authorization
  locks;
- permission codes and idempotent seeded-role definitions in `app/security/permissions.py`;
- immutable audit records and request context in `app/models/audit.py` and
  `app/repositories/audit_repo.py`;
- request-scoped commit/rollback in `app/db/session.py`;
- inventory items, warehouses, storage locations, lots, and immutable inventory transactions;
- exact `Decimal` unit conversion in `app/inventory/units.py`;
- deterministic bulk row locking and transfer authorization hardening in the inventory service;
- named production lifecycle operations and append-only transition history;
- cursor pagination used by production events and inventory transactions;
- web scoped-permission checks, refresh-safe idempotent mutations, stale-response guards, API error
  parsing, accessible dialogs, tables, loading, empty, and forbidden states;
- non-production, idempotent UAT bootstrap conventions; and
- linear Alembic revisions with explicit PostgreSQL enum handling.

The current public inventory receipt endpoint is not the purchase-receipt orchestration boundary:
it handles one lot, scopes idempotency to a lot, and lacks PO state. Purchasing must reuse its
ledger invariants through an internal posting interface described in section 8.

## 4. Business Partner aggregate

### 4.1 Partner identity

`business_partners` is organization-owned and contains:

| Field             | Contract                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | UUID primary key                                                                                                                        |
| `organization_id` | Required ownership FK; immutable                                                                                                        |
| `code`            | Required normalized uppercase code, max 64; immutable after first reference                                                             |
| `legal_name`      | Required, max 255                                                                                                                       |
| `trading_name`    | Optional, max 255                                                                                                                       |
| `primary_address` | Optional structured JSON value limited to `line1`, `line2`, `city`, `region`, `postal_code`, and `country_code`; each string is bounded |
| `email`, `phone`  | Optional primary contact conveniences, not the only contact architecture                                                                |
| `country_code`    | Optional ISO 3166-1 alpha-2                                                                                                             |
| `tax_identifier`  | Optional informational identifier; not interpreted                                                                                      |
| `notes`           | Optional, bounded                                                                                                                       |
| `is_active`       | Required, default true                                                                                                                  |
| `metadata`        | Optional bounded JSONB for non-core presentation metadata                                                                               |
| `deleted_at`      | Administrative soft-delete timestamp                                                                                                    |
| timestamps        | Created and updated                                                                                                                     |

Constraints and indexes:

- unique `(organization_id, code)`, including inactive and deleted partners;
- non-empty trimmed code and legal name checks;
- index `(organization_id, is_active, legal_name, id)` and index `deleted_at`;
- no hard-delete API.

Deactivation is the normal lifecycle operation. Inactive/deleted partners remain visible on
historical POs and cannot be selected for a new PO or resubmitted draft. An approved PO may still be
received if its partner later becomes inactive. Codes are never recycled for another legal entity.

List APIs support active state, capability, qualification, preference, and case-insensitive
code/legal/trading-name search.

### 4.2 Capabilities

`business_partner_capabilities` has a UUID PK, required partner FK, capability code, timestamps,
and unique `(business_partner_id, capability)`. Capability deletion is audited and is prohibited
while an active non-terminal document depends on it.

### 4.3 Supplier governance

Preferred, approved, and blocked are distinct concepts and must not be combined into one boolean.
They belong in a one-to-one `business_partner_supplier_profiles` capability profile:

- `qualification_status`: `unqualified`, `approved`, or `blocked`;
- `preference_tier`: `standard` or `preferred`;
- optional `qualification_note`, `qualified_by_id`, and `qualified_at`;
- unique `business_partner_id` and timestamps.

Only a partner with supplier capability and `qualification_status=approved` may be submitted on a
PO. `blocked` prevents new submission. `preferred` affects search/filter/display only and confers no
authorization or validation bypass. Qualification changes require `business_partner.update` and
audit before/after metadata.

### 4.4 Contacts

Multiple contacts are part of migration `0011_business_partners`; deferring them would preserve the
current one-contact limitation and force an avoidable near-term migration.

`business_partner_contacts` contains a UUID PK, partner FK, name, optional job title, optional email
and phone, `contact_role`, `is_primary`, `is_active`, notes, timestamps, and optional soft deletion.
Initial roles are `accounts`, `warehouse`, `sales`, `driver`, `managing_director`, `technical`, and
`other`. A partial unique index permits at most one active primary contact per partner and role.
Release 6.0 may expose only basic list/create/edit contact UI, but APIs and storage are plural.

Contact fields are mutable while active. Partner ownership is immutable. The partner FK uses
`RESTRICT`; deactivating a partner does not deactivate or erase contacts, although the UI treats all
of them as unavailable for new documents. Index `(business_partner_id, is_active, name, id)` supports
the bounded contact list. Contact email and phone are not globally unique.

### 4.5 Partner audit

Required actions are `business_partner.create`, `.update`, `.deactivate`, `.restore`,
`.capability.add`, `.capability.remove`, `.qualification.update`, and contact create/update/
deactivate. Metadata is bounded to changed field names, capability/status values, and reasons.

## 5. Purchase Order aggregate

### 5.1 Header

`purchase_orders` contains:

- UUID PK; required `organization_id`; optional `farm_id`;
- required Business Partner FK and generated `po_number`;
- optional independent `supplier_reference`;
- required status, currency, order date, creator, and version;
- optional expected-delivery date, delivery-address snapshot, and bounded notes;
- supplier code/legal/trading-name snapshots;
- creator, submitter, approver, rejector, and cancellation actor/time attribution;
- created/updated timestamps.

Unique `(organization_id, po_number)`. Index organization/status/created/id, farm/status/created/id,
partner ID, order date, and expected-delivery date. POs are never deleted; an abandoned draft is
cancelled.

### 5.2 Lines and totals

`purchase_order_lines` contains:

- UUID PK, PO FK, positive line number, and inventory-item FK;
- item code/name/SKU snapshots;
- description and optional line note;
- `ordered_quantity NUMERIC(18,6) > 0` and ordered-unit snapshot;
- canonical-unit snapshot and `ordered_quantity_canonical NUMERIC(18,6) > 0`;
- locked `received_quantity` and `received_quantity_canonical`, default zero;
- mandatory `unit_price NUMERIC(20,6) >= 0`.

Unique `(purchase_order_id, line_number)`. Checks require non-negative received quantities, both
received accumulators not to exceed ordered values, and a non-empty note for zero price.

Line extended amount is `ordered_quantity * unit_price` at six-decimal precision. PO subtotal is
the sum of line extended amounts. There is no tax or authoritative total beyond subtotal in 6.0.
Display rounding uses the ISO currency's minor units and decimal `ROUND_HALF_UP`; stored facts retain
six decimals.

### 5.3 Snapshots

Supplier name/code, item name/code/SKU, ordered and canonical units, unit price, currency, and
delivery address are snapshots. Live FKs support navigation and validation; historical document
rendering uses snapshots so later catalog edits cannot rewrite purchasing history.

### 5.4 Versioning and mutability

- `version` is an integer optimistic concurrency token incremented by every draft mutation and
  lifecycle transition.
- Draft PATCH requires the expected version. A mismatch returns `purchase_order_version_conflict`.
- Only `DRAFT` header and lines are editable.
- Submission freezes partner, farm, currency, dates, addresses, snapshots, prices, quantities, and
  lines.
- Approved orders cannot be amended. No hidden administrative override exists.
- Received accumulators change only inside atomic receipt posting.
- Status changes occur only through named operations, never PATCH.

### 5.5 Sequence state

`purchase_order_sequences` is keyed by `(organization_id, year)` with `last_value >= 0` and
`updated_at`. The format is `PO-{YYYY}-{NNNNNN}`, for example `PO-2026-000381`. It is organization-
scoped, resets annually, is generated by the server, and is immutable. Farm does not affect the
sequence. Gaps after rollback are acceptable.

### 5.6 Transition history

`purchase_order_transitions` is append-only and contains a UUID PK, PO FK, nullable initial
`from_status`, required `to_status`, actor, server timestamp, optional/required reason, bounded
metadata, request ID, and created timestamp. It has no update/delete API and no `updated_at`.

### 5.7 State machine

States are:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `PARTIALLY_RECEIVED`
- `RECEIVED`
- `CANCELLED`
- `CANCELLED_WITH_RECEIPTS`

| Operation        | Source                                         | Target                             | Permission                | Reason   | Editable afterward | Receive afterward | Idempotency/audit                   |
| ---------------- | ---------------------------------------------- | ---------------------------------- | ------------------------- | -------- | ------------------ | ----------------- | ----------------------------------- |
| Create           | none                                           | `DRAFT`                            | `purchase_order.create`   | No       | Header/lines yes   | No                | New record; `purchase_order.create` |
| Submit           | `DRAFT`                                        | `SUBMITTED`                        | `purchase_order.submit`   | No       | No                 | No                | Same target replays; `.submit`      |
| Withdraw         | `SUBMITTED`                                    | `DRAFT`                            | `purchase_order.update`   | Required | Yes                | No                | Same target replays; `.withdraw`    |
| Approve          | `SUBMITTED`                                    | `APPROVED`                         | `purchase_order.approve`  | Optional | No                 | Yes               | Same target replays; `.approve`     |
| Reject           | `SUBMITTED`                                    | `REJECTED`                         | `purchase_order.reject`   | Required | No                 | No                | Same target replays; `.reject`      |
| Revise           | `REJECTED`                                     | `DRAFT`                            | `purchase_order.update`   | Required | Yes                | No                | Same target replays; `.revise`      |
| First receipt    | `APPROVED`                                     | `PARTIALLY_RECEIVED` or `RECEIVED` | `purchase_receipt.create` | No       | No                 | If partial        | Receipt idempotency; `.transition`  |
| Later receipt    | `PARTIALLY_RECEIVED`                           | same or `RECEIVED`                 | `purchase_receipt.create` | No       | No                 | If partial        | Receipt idempotency; `.transition`  |
| Cancel           | `DRAFT`, `SUBMITTED`, or unreceived `APPROVED` | `CANCELLED`                        | `purchase_order.cancel`   | Required | No                 | No                | Same target replays; `.cancel`      |
| Cancel remainder | `PARTIALLY_RECEIVED`                           | `CANCELLED_WITH_RECEIPTS`          | `purchase_order.cancel`   | Required | No                 | No                | Same target replays; `.cancel`      |

`RECEIVED`, `CANCELLED`, and `CANCELLED_WITH_RECEIPTS` are terminal. Approval checks the approver ID
against `created_by_id` regardless of role. A receipt transition is calculated by the server and is
not a general transition endpoint.

All other source/target combinations return `409 invalid_purchase_order_transition`. Repeating an
already-completed named transition returns the current PO without adding history or audit and sets
`X-Idempotent-Replay: true`. A conflicting operation from another state returns 409.

State-centric behavior is therefore:

| State                     | Header/lines editable | Named outbound transitions                        | Receiving | Cancellation                                  |
| ------------------------- | --------------------: | ------------------------------------------------- | --------: | --------------------------------------------- |
| `DRAFT`                   |                   Yes | submit, cancel                                    |        No | To `CANCELLED`, reason required               |
| `SUBMITTED`               |                    No | withdraw, approve, reject, cancel                 |        No | To `CANCELLED`, reason required               |
| `APPROVED`                |                    No | receipt-driven partial/full, cancel if no receipt |       Yes | To `CANCELLED` only before first receipt      |
| `REJECTED`                |                    No | revise, cancel                                    |        No | To `CANCELLED`, reason required               |
| `PARTIALLY_RECEIVED`      |                    No | receipt-driven partial/full, cancel remainder     |       Yes | To `CANCELLED_WITH_RECEIPTS`, reason required |
| `RECEIVED`                |                    No | None                                              |        No | Prohibited                                    |
| `CANCELLED`               |                    No | None                                              |        No | Already terminal/idempotent same operation    |
| `CANCELLED_WITH_RECEIPTS` |                    No | None                                              |        No | Already terminal/idempotent same operation    |

Invalid-transition matrix (`X` is always 409; “receipt” is server-calculated, not a public target):

| From / requested operation |  Submit | Withdraw | Approve |  Reject |  Revise |                                 Receipt |                                   Cancel |
| -------------------------- | ------: | -------: | ------: | ------: | ------: | --------------------------------------: | ---------------------------------------: |
| `DRAFT`                    | Allowed |        X |       X |       X |       X |                                       X |                                  Allowed |
| `SUBMITTED`                |  Replay |  Allowed | Allowed | Allowed |       X |                                       X |                                  Allowed |
| `APPROVED`                 |       X |        X |  Replay |       X |       X |                                 Allowed |              Allowed only before receipt |
| `REJECTED`                 |       X |        X |       X |  Replay | Allowed |                                       X |                                  Allowed |
| `PARTIALLY_RECEIVED`       |       X |        X |       X |       X |       X |                                 Allowed | Allowed to partial-cancellation terminal |
| `RECEIVED`                 |       X |        X |       X |       X |       X | Replay only through receipt idempotency |                                        X |
| `CANCELLED`                |       X |        X |       X |       X |       X |                                       X |                                   Replay |
| `CANCELLED_WITH_RECEIPTS`  |       X |        X |       X |       X |       X |                                       X |                                   Replay |

## 6. Goods Receipt Number architecture

Every posted purchase receipt gets an immutable Goods Receipt Number (GRN), distinct from the PO
number and supplier delivery reference.

- Format: `GRN-{YYYY}-{NNNNNN}`, for example `GRN-2026-000044`.
- Scope: unique within organization and calendar year; the visible full value is also unique within
  the organization.
- Annual reset keeps identifiers readable and matches PO numbering.
- `purchase_receipt_sequences` is keyed by `(organization_id, year)` and stores `last_value` and
  `updated_at`.
- Allocation occurs inside the posting transaction after idempotent replay detection and before
  receipt insertion.
- The sequence row is selected `FOR UPDATE`; creation races are resolved by a unique PK and nested
  savepoint/winner reload.
- Exact replay returns the original GRN and does not allocate another number.
- A rolled-back posting leaves no committed receipt and rolls back the row-counter increment, so
  the number remains available. The contract does not require gapless numbering under manual data
  repair or future allocation implementations; uniqueness and immutability are the invariants.
- Supplier delivery-note/reference is a separate optional field and is never used as the GRN.

GRN tables and constraints belong to migration `0013_purchase_receipts`. PostgreSQL tests must prove
parallel allocation uniqueness, replay stability, rollback safety, and organization/year scoping.

## 7. Purchase Receipt aggregate

### 7.1 Header

`purchase_receipts` is an immutable posted record containing:

- UUID PK, organization/farm/PO FKs, and one warehouse FK;
- required immutable GRN;
- optional supplier delivery-note reference;
- required received timestamp and posting actor;
- optional bounded notes;
- mandatory idempotency key and SHA-256 canonical payload hash;
- created timestamp only.

Unique `(organization_id, grn)` and `(organization_id, idempotency_key)`. Index PO/created/id and
warehouse/created/id. There is no receipt status: failure creates no receipt, while success creates
an immutable posted receipt. Draft, patch, delete, reversal, and return endpoints do not exist.

### 7.2 Receipt lines

`purchase_receipt_lines` contains:

- UUID PK, receipt FK, PO-line FK, item ID, warehouse ID, optional storage-location ID;
- required inventory-lot FK and unique inventory-transaction FK;
- lot-code and expiry snapshots;
- positive quantity in ordered unit and ordered-unit snapshot;
- positive canonical quantity and canonical-unit snapshot;
- unit-price and currency snapshots;
- created timestamp only.

One PO line may occur several times when split across lots. Each receipt line maps to exactly one
inventory receipt transaction. A PO may span warehouses only through several receipt headers.

### 7.3 Posting behavior

- `Idempotency-Key` is mandatory and scoped to `(organization_id, key)`.
- The canonical hash includes organization, PO, warehouse, delivery reference, received timestamp,
  notes, and all normalized lines in stable client-line order.
- Request IDs, credentials, server timestamps, GRN, and actor display data are excluded.
- Same key and hash returns the original receipt with 200 and `X-Idempotent-Replay: true`.
- Same key and different hash returns 409 `idempotency_key_payload_conflict`.
- New posting returns 201.
- Any line failure rolls back the receipt, lines, new lots, ledger rows, accumulators, PO state,
  transition, and audit.
- Clients never submit received accumulators or PO receipt state.

After posting, the server sets `RECEIVED` if every canonical line accumulator equals its ordered
canonical quantity; otherwise it sets/retains `PARTIALLY_RECEIVED`.

## 8. Internal inventory posting contract

Purchasing uses an internal inventory service boundary equivalent to:

```python
post_receipt_under_locks(
    *, actor, warehouse, item, lot, quantity_canonical,
    reference_type="purchase_receipt_line",
    reference_id=receipt_line_id,
    reason, request_ctx, metadata,
) -> InventoryTransaction
```

The interface must:

- reuse existing exact unit conversion, warehouse lifecycle policy, lot uniqueness, and immutable
  ledger insertion;
- create a `RECEIPT` transaction in the item's canonical unit;
- use `reference_type=purchase_receipt_line` and the receipt-line UUID as `reference_id`;
- write bounded, compatible audit metadata;
- never commit, begin an independent transaction, or own request idempotency;
- assume its caller owns the session, transaction, authoritative authorization decision, and all
  required locks;
- avoid re-authorizing against stale pre-lock objects; and
- return the inserted transaction for the unique receipt-line FK.

It is not responsible for PO lifecycle, approval, received accumulators, GRN allocation, purchase
receipt idempotency, multi-line rollback, or purchasing audit. No second inventory balance, lot, or
ledger model may be created.

## 9. Warehouse, lot, and transaction rules

### 9.1 Warehouse policy

- `ACTIVE`: receipt allowed.
- `MAINTENANCE`: inbound receipt allowed, matching existing inventory policy.
- `CLOSED`: 409 `warehouse_unavailable`.
- Deleted/inaccessible: tenant-hidden 404.
- Warehouse and PO must belong to the same organization.
- A farm-pinned warehouse must match a farm-scoped PO.
- An organization-shared warehouse is allowed for a farm PO.
- A warehouse pinned to another farm is rejected with
  `warehouse_farm_scope_mismatch` when both resources are legitimately visible.

### 9.2 Lot policy

- Uniqueness remains `(warehouse_id, item_id, lot_code)`.
- An existing lot is reusable only for the same item and warehouse and compatible storage location
  and expiry attributes.
- A different non-null expiry returns 409 `lot_attribute_conflict`.
- A supplied storage location must belong to the receipt warehouse.
- Missing-lot creation and receipt posting share one transaction and resolve creation races through
  the unique constraint and a nested savepoint.

### 9.3 Atomicity and locking

One request transaction covers locked authorization, idempotency, GRN, receipt, receipt lines, PO
accumulators/state, lots, ledger, transition history, and audit.

Canonical lock order is:

1. transaction-scoped organization authorization advisory lock;
2. target warehouse;
3. referenced farm, if any;
4. organization;
5. inventory items sorted by UUID;
6. storage locations sorted by UUID;
7. PO;
8. PO lines sorted by UUID;
9. existing lots sorted by UUID;
10. missing-lot inserts under nested savepoints.

Bulk sets use one ordered `SELECT ... FOR UPDATE` and `populate_existing`. No authorization decision
may trust a pre-lock ORM object. The locked PO serializes receipts for the aggregate; line checks and
database constraints provide defense in depth.

`received_quantity` and `received_quantity_canonical` are locked authoritative accumulators, not
client-editable totals. Checks require both to remain between zero and their ordered counterpart.
Immutable receipt lines and ledger references provide reconciliation evidence.

## 10. Database migrations and table contract

There must be one Alembic head at all times. Migrations are additive, old application versions
ignore the new tables, and competing migration branches are prohibited.

### 10.1 `0011_business_partners`

Creates:

- `business_partners`;
- `business_partner_capabilities`;
- `business_partner_supplier_profiles`;
- `business_partner_contacts`;
- required enums, checks, partial unique indexes, and search indexes; and
- partner permissions and idempotent seeded-role grants.

Partner and child FKs are restrictive for history. Partners use inactive/soft-delete behavior;
capabilities/profiles/contacts follow the lifecycle rules in section 4. Downgrade removes children,
parent, then enums after verifying dependencies.

### 10.2 `0012_purchase_orders`

Creates:

- `purchase_order_sequences`;
- `purchase_orders`;
- `purchase_order_lines`;
- `purchase_order_transitions`;
- PO status enum, monetary/quantity checks, uniqueness, and indexes; and
- PO permissions and seeded-role updates.

PO history uses restrictive FKs and has no soft deletion. Initial `DRAFT` transition is recorded by
the application. Sequence and status data are immutable except through named services.

### 10.3 `0013_purchase_receipts`

Creates:

- `purchase_receipt_sequences`;
- `purchase_receipts`;
- `purchase_receipt_lines`;
- GRN/idempotency/ledger-link uniqueness and indexes; and
- receipt permissions and seeded-role updates.

Receipt tables are append-only, have no soft deletion, and use restrictive FKs. Any additional index
on the existing inventory reference columns must be additive and justified by query plans.

### 10.4 Rollback

Fresh upgrade, upgrade from `0010_sprint_5_4_12_reconcile_ddl`, and development downgrade are tested.
After real purchasing data exists, schema downgrade is not an operational rollback: restore the
pre-deployment database backup. A downgrade must never rewrite or silently detach existing inventory
ledger rows.

Password recovery is outside these migrations and this purchasing contract unless independently
approved for Release 6.0 hardening.

## 11. API contract

### 11.1 Standard behavior

All new list endpoints use opaque cursor pagination, default limit 50, maximum 200, deterministic
ordering, and a UUID tie-breaker. Invalid cursors return 422 `invalid_cursor`.

An inaccessible tenant/farm/resource returns 404 without revealing existence. An authenticated
member who lacks an action permission receives 403.

Errors use:

```json
{
  "detail": {
    "code": "stable_machine_code",
    "message": "Human-readable message.",
    "context": {}
  }
}
```

Context never exposes foreign-tenant identifiers.

### 11.2 Business Partners

| Method and path                                              | Permission                    | Result                                                                 |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| `GET /v1/organizations/{organization_id}/business-partners`  | `business_partner.read`       | Cursor page; capability/status/qualification/preference/search filters |
| `POST /v1/organizations/{organization_id}/business-partners` | `business_partner.create`     | 201 partner                                                            |
| `GET /v1/business-partners/{partner_id}`                     | `business_partner.read`       | Partner detail                                                         |
| `PATCH /v1/business-partners/{partner_id}`                   | `business_partner.update`     | 200 updated partner                                                    |
| `POST /v1/business-partners/{partner_id}/deactivate`         | `business_partner.deactivate` | 200; reason; same-state idempotent                                     |
| `POST /v1/business-partners/{partner_id}/restore`            | `business_partner.deactivate` | 200 reactivate; reason; same-state idempotent                          |

Contact/capability/profile subresources may be included in the 6.0.2 API but must follow the same
permissions, tenancy, pagination, and audit contracts.

### 11.3 Purchase Orders

| Method and path                                            | Permission               | Result                                                   |
| ---------------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `GET /v1/organizations/{organization_id}/purchase-orders`  | `purchase_order.read`    | Cursor page with farm/partner/status/date/search filters |
| `POST /v1/organizations/{organization_id}/purchase-orders` | `purchase_order.create`  | 201 draft                                                |
| `GET /v1/purchase-orders/{po_id}`                          | `purchase_order.read`    | PO detail                                                |
| `PATCH /v1/purchase-orders/{po_id}`                        | `purchase_order.update`  | 200 draft update with expected version                   |
| `POST /v1/purchase-orders/{po_id}/submit`                  | `purchase_order.submit`  | 200                                                      |
| `POST /v1/purchase-orders/{po_id}/withdraw`                | `purchase_order.update`  | 200; reason                                              |
| `POST /v1/purchase-orders/{po_id}/approve`                 | `purchase_order.approve` | 200; self-approval forbidden                             |
| `POST /v1/purchase-orders/{po_id}/reject`                  | `purchase_order.reject`  | 200; reason                                              |
| `POST /v1/purchase-orders/{po_id}/revise`                  | `purchase_order.update`  | 200; reason                                              |
| `POST /v1/purchase-orders/{po_id}/cancel`                  | `purchase_order.cancel`  | 200; reason; target calculated                           |
| `GET /v1/purchase-orders/{po_id}/transitions`              | `purchase_order.read`    | Cursor page                                              |
| `GET /v1/purchase-orders/{po_id}/receipts`                 | `purchase_receipt.read`  | Cursor page                                              |

No endpoint accepts an arbitrary target status.

### 11.4 Purchase Receipts

| Method and path                             | Permission                | Result                                                   |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `POST /v1/purchase-orders/{po_id}/receipts` | `purchase_receipt.create` | 201 new or 200 exact replay; mandatory `Idempotency-Key` |
| `GET /v1/purchase-receipts/{receipt_id}`    | `purchase_receipt.read`   | Receipt/GRN detail and ledger links                      |
| `GET /v1/purchase-orders/{po_id}/receipts`  | `purchase_receipt.read`   | Cursor page                                              |

Receipt creation accepts one warehouse, optional delivery reference/received timestamp/notes, and
non-empty lines with PO-line ID, lot code, ordered-unit quantity, optional storage location, and
optional expiry.

### 11.5 Stable conflict codes

- `invalid_purchase_order_transition`
- `duplicate_purchase_order_number`
- `duplicate_goods_receipt_number`
- `goods_receipt_sequence_conflict`
- `business_partner_inactive`
- `business_partner_not_supplier`
- `business_partner_not_approved`
- `business_partner_blocked`
- `purchase_order_self_approval_forbidden`
- `purchase_order_over_receipt`
- `purchase_order_version_conflict`
- `purchase_order_not_receivable`
- `unit_incompatible`
- `ordered_unit_mismatch`
- `warehouse_unavailable`
- `warehouse_farm_scope_mismatch`
- `lot_attribute_conflict`
- `idempotency_key_payload_conflict`

Missing receipt idempotency key returns 400 `idempotency_key_required`. A cross-tenant reference is
normally a tenant-hidden 404; use a 409 only when both resources are legitimately visible in the
same organization.

## 12. Permission matrix

Frozen codes are:

- `business_partner.read`, `.create`, `.update`, `.deactivate`;
- `purchase_order.read`, `.create`, `.update`, `.submit`, `.approve`, `.reject`, `.cancel`;
- `purchase_receipt.create`, `.read`.

Platform administrators have wildcard permission but remain subject to self-approval prohibition.

| Permission              | Org owner | Farm director | Farm manager | Supervisor | Storekeeper | Accountant | Viewer |
| ----------------------- | --------: | ------------: | -----------: | ---------: | ----------: | ---------: | -----: |
| Partner read            |       Yes |           Yes |       Scoped |     Scoped |      Scoped |        Yes |    Yes |
| Partner create          |       Yes |           Yes |           No |         No |          No |         No |     No |
| Partner update          |       Yes |           Yes |           No |         No |          No |         No |     No |
| Partner deactivate      |       Yes |            No |           No |         No |          No |         No |     No |
| PO read                 |       Yes |           Yes |       Scoped |     Scoped |      Scoped |        Yes |    Yes |
| PO create/update/submit |       Yes |           Yes |       Scoped |         No |          No |         No |     No |
| PO approve/reject       |       Yes |           Yes |           No |         No |          No |         No |     No |
| PO cancel               |       Yes |           Yes |           No |         No |          No |         No |     No |
| Receipt create          |       Yes |           Yes |       Scoped |         No |      Scoped |         No |     No |
| Receipt read            |       Yes |           Yes |       Scoped |     Scoped |      Scoped |        Yes |    Yes |

- Storekeepers can receive but cannot approve.
- Farm managers cannot approve or cancel.
- Organization-scoped grants operate across farms.
- Farm-scoped grants operate only on POs and eligible warehouses in that farm scope.
- The dedicated receipt permission authorizes the controlled stock effect; generic
  `inventory_transaction.create` is not required.
- UI visibility mirrors these grants but is never authorization.

## 13. Audit and operational logging

Successful domain audit actions are:

- partner actions listed in section 4.5;
- `purchase_order.create`, `.update`, `.submit`, `.withdraw`, `.approve`, `.reject`, `.revise`,
  `.cancel`, and `.transition`;
- `purchase_receipt.post`.

GRN assignment is metadata on `purchase_receipt.post`, not a separate semantic audit action. Each
record includes actor, organization, optional farm, entity and ID, request ID, IP/user agent,
required reason, bounded changed-field metadata, transition ID where relevant, GRN, PO ID, and
receipt inventory-transaction IDs.

Do not store secrets, credentials, full payloads, raw idempotency keys, payload hashes in public
audit metadata, large notes/addresses, or unbounded before/after documents.

- Exact replay creates no duplicate domain audit; emit structured metric/log
  `purchase_receipt.idempotent_replay` with hashed key and receipt ID.
- Failed receipt transactions create no transactional audit because they roll back; emit a
  structured failure log with request ID and stable error code.
- Permission denials use rate-limited security logs. Tenant-hidden attempts must not create tenant
  audit rows or reveal resource identity.

## 14. Frontend contract

### 14.1 Routes

- `/business-partners?organization_id=...&capability=supplier`
- `/business-partners/new?organization_id=...`
- `/business-partners/[partnerId]`
- `/business-partners/[partnerId]/edit`
- `/purchase-orders?organization_id=...`
- `/purchase-orders/new?organization_id=...`
- `/purchase-orders/[purchaseOrderId]`
- `/purchase-orders/[purchaseOrderId]/edit`
- `/purchase-orders/[purchaseOrderId]/receive`
- `/purchase-receipts/[receiptId]`

The partner UI labels supplier-capable records as suppliers while preserving the general API model.
Partner pages expose active, qualification, blocked, preferred, capability, contact, and history
states according to permission.

PO detail displays snapshots, status, subtotal/currency, ordered/received/remaining quantities,
creator/submitter/approver, lifecycle timeline, receipts, GRNs, and inventory links. Actions are
state- and permission-aware. The receipt workflow selects one warehouse, supports PO-line lot
splits, validates remaining quantities, and shows a confirmation summary.

### 14.2 Client behavior

- Tenant switches invalidate in-flight state and clear tenant-specific data.
- Generation/identity guards prevent stale requests from mutating a new route or tenant.
- 401 uses the existing single-flight refresh; idempotent mutations may retry with the same key.
- 403 renders an explicit forbidden state; tenant-hidden 404 uses a generic unavailable message.
- Stable 409 codes map to state refresh, field correction, or explicit operator review.
- An idempotency conflict never silently generates a replacement key.
- One UUID key is retained for an unchanged canonical receipt payload across refresh/network retry,
  regenerated after any payload change, and cleared only after confirmed success.
- Decimal quantities and money remain strings/decimal values through validation and formatting;
  JavaScript floating-point totals are prohibited.

Forms provide semantic labels, error summaries and field errors, focus trapping/restoration,
keyboard operation, `aria-live` status, non-color state cues, 44px touch targets, and responsive
line cards on narrow screens. Existing API client, permission helper, errors, banners, tables,
filters, badges, dialogs, stale guards, and stock-operation idempotency patterns should be reused.

## 15. Test contract

### 15.1 Backend

Tests cover:

- every valid lifecycle transition and every invalid source/operation combination;
- immutable submitted/approved documents and version conflicts;
- cross-tenant hiding, farm scope, all permissions, owner/admin self-approval rejection;
- partner capability, qualification, blocked/preferred governance, deactivation, contacts, and
  historical snapshots;
- decimal precision, currency validation, exact unit conversion, and zero-price note checks;
- partial, cumulative, multi-lot, multi-warehouse-across-receipts, and complete receiving;
- one-request and cumulative over-receipt;
- exact idempotent replay and same-key/different-payload conflict;
- whole-receipt rollback at each failure point;
- warehouse lifecycle/scope, storage location, lot expiry/location conflicts, and creation races;
- GRN/PO sequence generation, uniqueness, annual/organization scope, replay, and rollback;
- receipt-line-to-lot-to-ledger-to-PO traceability and accumulator reconciliation;
- transition history and audit completeness/boundedness.

### 15.2 PostgreSQL-only

PostgreSQL tests prove deterministic row locking; concurrent PO and GRN sequence allocation;
concurrent same-key receipt; concurrent different-key cumulative receipt limits; warehouse/farm/org/
membership/permission mutation races; missing-lot creation; accumulator checks; full rollback; and
deadlock avoidance when request lines arrive in opposite orders. SQLite is not concurrency proof.

### 15.3 Frontend

Tests cover partner CRUD/governance/contacts, PO drafting and decimal-safe lines, all lifecycle
actions, permission/self-approval gating, partial receiving and lot splits, tenant switching,
stale-response guards, 401 refresh, 403, tenant-hidden 404, each 409 mapping, idempotent replay, and
accessible/responsive behavior.

### 15.4 Migration and browser E2E

Migration CI validates fresh upgrade, upgrade from `0010`, each development downgrade, enum and
constraint behavior, idempotent permission seeding, and exactly one Alembic head.

The first mandatory Playwright scenario, to be implemented later, is:

```text
login
-> create supplier-oriented Business Partner
-> create PO
-> submit
-> verify no self-approval
-> independent approval
-> partial receipt
-> open GRN/receipt
-> verify inventory transaction
-> verify stock increased once
-> replay same receipt
-> verify no duplicate stock
```

New purchasing modules must be fully typed without broad suppressions. Repository-wide strict mypy
is not part of this documentation task.

## 16. Emergent guardrails

Emergent must not:

- invent statuses, permissions, inventory models, or alternate state machines;
- add approval thresholds or self-approval exceptions;
- invent tax, accounting, valuation, reporting, notification, asynchronous job, or mobile behavior;
- add purchase requests, RFQs, receipt reversal, or supplier returns;
- alter or bypass existing inventory-ledger semantics or tenant-hiding behavior;
- create competing Alembic heads; or
- bundle unrelated dependency upgrades.

Any deviation requires architecture approval before implementation.

## 17. Sprint and PR strategy

No implementation branch is created by this architecture document.

| Release                       | Branch                               | Migration ownership             | PR boundaries and gates                                                                                                                  |
| ----------------------------- | ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 6.0.2 Business Partners       | `feature/6.0.2-business-partners`    | `0011_business_partners`        | Domain/API/migration/tests first; supplier UI may be a second PR. Gate: tenancy, governance, contacts, audit, pagination, migration CI.  |
| 6.0.3 Purchase Orders         | `feature/6.0.3-purchase-orders`      | `0012_purchase_orders`          | Lifecycle/API/concurrency tests before UI. Gate: independent approval, snapshots, decimals, transitions, sequence, immutable submission. |
| 6.0.4 Receipts                | `feature/6.0.4-purchase-receiving`   | `0013_purchase_receipts`        | Locked backend integration and PostgreSQL proof first; UI/E2E follow. Gate: atomicity, over-receipt, GRN, replay, traceability.          |
| 6.0.5 Administration/Recovery | `feature/6.0.5-admin-recovery`       | Separate only if approved       | Separate recovery and administration PRs. Purchasing does not depend on password reset schema.                                           |
| 6.0.6 Operational Reporting   | `feature/6.0.6-operations-dashboard` | Additive if required            | Summary API before UI; query-count/performance and tenant scope gates.                                                                   |
| 6.0.7 Hardening               | `release/6.0-hardening`              | Reconciliation only if required | Small focused PRs for E2E, deployment, security, docs, and UAT; no feature expansion.                                                    |

Only one migration-bearing branch may advance against a given Alembic head at a time. Domain
integrity lands before dependent UI. Receipt UI cannot merge before PostgreSQL concurrency tests.

## 18. Definition of done

Release 6.0 implementation is done only when:

- all approved decisions, aggregates, state machine, `CANCELLED_WITH_RECEIPTS`, and GRN behavior are
  implemented exactly as frozen;
- suppliers can be managed and a PO can be drafted, independently approved, partially/fully
  received, or partially closed without changing received history;
- no receipt over-posts, duplicates stock, partially commits, or bypasses tenant/farm scope;
- each receipt line and inventory transaction uniquely trace to one another;
- received accumulators reconcile with immutable receipt and ledger history;
- all new lists are bounded/cursor-paginated and all named errors are stable;
- audit, frontend, backend, PostgreSQL, migration, and browser contracts pass;
- one Alembic head remains; and
- documentation and UI make every non-goal explicit.

## 19. Unresolved decisions

There are no unresolved Release 6.0 business-policy decisions in this contract. Field-length tuning,
index query-plan tuning, and UI composition are implementation details only when they do not change
the frozen behavior. Any proposed policy or semantic change must return to architecture review.
