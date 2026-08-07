# Release 6.0.3 — Purchase Orders — Sprint 1.2 Remediation Report

**Second independent review verdict:** BLOCK MILESTONE 2 — 0 Critical, 2 High, 4 Medium, 2 Low.
**This sprint:** transactional governance and concurrency hardening only.
**Scope:** backend domain/repository/tests; no API, frontend, receipts, inventory mutation, AP,
payments, or Release 6.0.4 implementation. Migration `0012_purchase_orders` is unchanged.

## Finding resolutions

### High 1 — supplier qualification race

The canonical governance order is now partner → supplier profile → capabilities → farm → inventory
items. PO create/update/submit/approve and Business Partner qualification/capability mutation share
that order. Submit and approve lock the supplier-profile row before authoritative qualification
reads. PostgreSQL tests cover qualification downgrade against submit and approve and supplier
deactivation against submit.

### High 2 — authorization revocation race

PO mutations use a PO-specific locked authorization path. It locks the actor, organization,
organization membership, applicable role assignments, roles, role-permission grants, permissions,
and applicable farm memberships before governance validation; the farm aggregate is locked in the
subsequent canonical dependency phase. Authorization is then rebuilt from the locked active rows.
PostgreSQL tests cover organization-membership, role-assignment, farm-membership, and farm-lifecycle
revocation winning against submit.

### Medium 3 — dependency lock ordering

Draft update computes the complete union of current and requested supplier, farm, and inventory-item
identities before acquiring mutable dependency locks. Each set is UUID sorted and each dependency
category is acquired once. An opposing supplier/farm/item swap test executes independent sessions
under a timeout and verifies both final aggregates.

### Medium 4 — decimal correctness

All Numeric ORM attributes are typed `Decimal`. Binary floats are rejected at the domain boundary.
Derived extended amounts and subtotals use a local 64-digit `ROUND_HALF_UP` context and six-decimal
quantization, preventing the process default context from leaking `InvalidOperation`. Tests cover
maximum legal persisted operands, six-decimal result rounding, float rejection, excess scale/range,
and a converted quantity too small for exact six-decimal representation.

### Medium 5 — duplicate PO-number translation

The create service narrowly matches `uq_purchase_order_org_number` (plus SQLite's exact column-list
form) and returns `duplicate_purchase_order_number`. Other integrity errors are re-raised. The domain
test forces the authoritative unique conflict, rolls back, and proves a subsequent allocation works.

### Medium 6 — PostgreSQL concurrency matrix

The PostgreSQL module now collects 25 cases after parameter expansion. New independent-transaction
cases cover qualification submit/approve races, supplier deactivation, organization and role
revocation, farm membership/lifecycle revocation, opposing dependency swaps, and item deactivation
against submit/update. Existing lifecycle, sequence, capability, accumulator, and rollback proofs
remain.

### Low 7 — repository foundations

A direct repository test covers inclusive dates, repeatable statuses, supplier and supplier-reference
search, cursor traversal, deterministic UUID tie-breaking, malformed cursors, the hard 200-row page
ceiling, and transition-history pagination. No endpoint was added.

### Low 8 — audit metadata

Tests now assert line-ID categories and counts, sorted UUIDs, absence of artificial add/remove pairs,
the 50-ID cap, and `line_ids_truncated`.

## Validation evidence

| Gate | Sprint 1.2 local result |
| --- | --- |
| Ruff | pass |
| Black | pass |
| Python compilation | pass |
| PO test collection | 74 collected; 25 PostgreSQL concurrency cases |
| Decimal boundary smoke | pass |
| SQLite full suite | **447 passed, 105 skipped** |
| PostgreSQL full suite | **520 passed, 32 skipped** |
| PO PostgreSQL concurrency | **25 passed**; three consecutive runs **75 passed** |
| Alembic single head | `0012_purchase_orders` |
| Migration 0012 modified | no |
| Alembic upgrade → downgrade base → re-upgrade | pass |
| `app.seed` | pass |
| Scope scan | pass |
| `git diff --check` | pass |

Both database engines and the PostgreSQL migration round trip were rerun independently on this head.

## Remaining known risks

- The locked authorization path is deliberately PO-specific and uses strong row locks. Correctness
  takes precedence for Milestone 1; PostgreSQL CI should monitor contention under concurrent PO
  mutations in one organization.
- PostgreSQL race tests use explicit held transactions and bounded waits; CI should retain the real
  PostgreSQL job and must never infer concurrency correctness from SQLite.

## Handoff

All 2 High and 4 Medium findings have code and test resolutions. Sprint 1.2 stops here and is ready
for a third independent backend-domain review after PostgreSQL/SQLite CI evidence is attached.
Milestone 2 has not begun.
