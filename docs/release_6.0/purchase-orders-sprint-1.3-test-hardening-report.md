# Release 6.0.3 — Purchase Orders — Sprint 1.3 Test Hardening Report

**Third independent review verdict:** BLOCK MILESTONE 2 — one Medium concurrency-test finding.
**Sprint outcome:** deterministic concurrency coverage completed; two High production defects exposed
by the stricter PostgreSQL proofs and fixed under explicit production-freeze exceptions.
**Scope:** PO/compatible supplier-governance locking, domain/concurrency tests, and documentation
only. No API, frontend, receipts, inventory mutation, AP, payments, or Release 6.0.4 implementation.
Migration `0012_purchase_orders` is unchanged.

## Production defects discovered and resolved

### 1. Stale current-farm validation during `update_draft`

`test_farm_deactivation_wins_against_update_draft` originally returned `updated` after the farm
deactivation transaction had won and committed. Dependency locking included the current farm, but
`update_draft` only performed authoritative farm eligibility validation when `farm_id` changed.
This violated the farm-governance race rule in contract §12.4.

The minimal fix revalidates the authoritative, already-locked current farm during every farm-bound
Draft update. It acquires no second farm lock and preserves tenant-hidden `not_found` semantics.
Failed mutations leave the PO `DRAFT`, version 1, assigned to the same farm, with one initial
transition/audit and no header, line, version, transition, or audit residue.

Regression coverage includes header-only and line-only mutations against an inactive current farm,
an unrelated-field mutation, an active-farm update, valid farm A → farm B replacement, and foreign
farm tenant hiding.

### 2. Actor-before-organization deadlock

The strengthened opposing supplier/farm/item swap proof exposed a real PostgreSQL
`DeadlockDetectedError`. The prior prefix locked actor A before the shared organization anchor.
Another transaction could lock actor B and the organization, then require an FK-compatible lock on
a creator row held by the first transaction, completing a cycle.

The canonical prefix is now:

1. organization anchor;
2. actor/authorization identity;
3. membership, assignment, role, and permission rows;
4. PO aggregate where applicable;
5. business partner;
6. supplier profile;
7. capability rows;
8. farm;
9. inventory items.

The PO authorization anchor and compatible Business Partner supplier-governance helper both use
organization → actor. Supplier deactivation enters that helper only when the partner currently has
the supplier capability, avoiding unrelated Business Partner lock broadening. Actor row-lock mode
was not weakened.

The opposing-swap proof now requires bounded completion, two successful contract-valid updates,
coherent supplier/farm/item relationships, version 2 on both aggregates, one initial transition per
PO, and exactly one create plus one update audit per PO.

## Test-determinism remediation

- Submit vs cancel accepts only `(submitted, cancelled)` or
  `(invalid_purchase_order_transition, cancelled)` and always reads back `CANCELLED`.
- Approve vs cancel accepts only `(approved, cancelled)` or
  `(invalid_purchase_order_transition, cancelled)` and always reads back `CANCELLED`.
- Concurrent self-approval requires the creator to receive
  `purchase_order_self_approval_forbidden` and the independent approver to succeed.
- Edit vs submit distinguishes aggregate version increments from lifecycle transition count; Draft
  update does not create a lifecycle transition.
- Approve vs reject and supplier-capability races enumerate their exact legal outcome pairs.
- Role-assignment revocation vs approval is covered with independent held transactions.
- Governance losers read back authoritative status, version, transition, audit, and dependency state.
- Duplicate PO-number proof verifies constraint translation, sequence rollback, unique persisted
  numbers, and a subsequent successful allocation.
- Unrelated error proof now triggers a real PostgreSQL NOT NULL constraint violation and confirms it
  is not mislabeled as `duplicate_purchase_order_number`.
- Repository limit tests cover default, zero/negative normalization, normal limits, the hard ceiling,
  coercible input, and invalid input.

## Validation evidence

| Gate                                  | Sprint 1.3 result           |
| ------------------------------------- | --------------------------- |
| Confirmed farm/update PostgreSQL race | **1 passed**                |
| Required PostgreSQL regression subset | **12 passed**               |
| Targeted PO domain suite              | **54 passed**               |
| SQLite full suite                     | **452 passed, 107 skipped** |
| PostgreSQL full suite                 | **527 passed, 32 skipped**  |
| PO PostgreSQL concurrency             | **27 passed**               |
| Three consecutive PO concurrency runs | **81 passed**               |
| Ruff                                  | pass                        |
| Black                                 | pass                        |
| `git diff --check`                    | pass                        |
| Alembic single head                   | `0012_purchase_orders`      |
| Upgrade → downgrade base → re-upgrade | pass                        |
| `app.seed` after re-upgrade           | pass                        |
| Migration 0012 modified               | no                          |
| Scope scan                            | pass                        |

The temporary PostgreSQL environment was reprovisioned for the fix proofs and used for the complete
PostgreSQL suite and migration/seed gate.

## Production-freeze accounting

The production-code exception was limited to the two defects directly exposed by Sprint 1.3:

- `apps/api/app/services/purchase_order.py`: current-farm revalidation and organization-first PO
  authorization anchor;
- `apps/api/app/services/business_partner.py`: organization-first compatible supplier-governance
  prefix and supplier-only deactivation participation.

No repository, model, migration, state-machine, numbering, authorization-policy, API, or frontend
behavior was otherwise changed.

## Remaining risks

- The organization anchor deliberately serializes same-organization governance mutations. This is
  correct and bounded for Milestone 1, but remains a Low contention-monitoring concern.
- Real PostgreSQL concurrency coverage must remain mandatory; SQLite cannot validate row-lock order.

## Handoff

No Critical, High, or Medium finding remains known after Sprint 1.3 validation. Milestone 2 has not
begun. The branch is ready for a fourth independent backend-domain review before API implementation.
