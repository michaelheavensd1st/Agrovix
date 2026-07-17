# Sprint 4.1 — Inventory Hardening (P2) + Codex Review Gate Medium Findings

Branch: `fix/inventory-hardening-p2` → `develop`
Scope: **strictly** Sprint 4.1 hardening + the two Medium findings from Codex Review Gate 03.
Codex Low / Informational findings are **deferred** to a dedicated follow-up.
No Sprint 5 scope. No new features. No schema, migration, or frontend changes.

---

## Summary of fixes

### Sprint 4.1 P2 — original four hardening tasks

1. **FEEDING may only consume `category == feed`.**
   `InventoryService.consume_for_event` refuses to draw down a lot whose
   item is not of category `feed`. Returns 409 `inventory_item_not_feed`
   with the offending `item_category` echoed for the in-tenant caller.
   No CONSUMPTION ledger row is written on rejection.

2. **Cursor pagination on `/api/v1/lots/{id}/transactions` actually
   paginates.**
   Opaque composite cursor `base64("<performed_at_iso>|<uuid>")`,
   applied as a strict tuple inequality so ordering is stable across
   pages (`performed_at DESC, id DESC`). Garbage cursor → 400
   `invalid_cursor`.

3. **Receipt and Transfer refuse a storage location owned by a
   different warehouse.**
   `_assert_location_belongs_to_warehouse` guards BOTH `inventory:receive`
   (source-side bin) and `inventory:transfer` (destination-side bin).
   Cross-warehouse storage location → 409 `storage_location_wrong_warehouse`.
   Transfer never persists a destination lot on rejection.

4. **Concurrent receipts on the same `(warehouse, item, lot_code)` no
   longer raise `IntegrityError`.**
   `_get_or_create_lot_safe` wraps the INSERT in
   `async with session.begin_nested()` (SAVEPOINT). On the loser's
   UNIQUE-violation it `contextlib.suppress(InvalidRequestError)`-
   expunges the transient lot (so autoflush cannot retry the failing
   INSERT) and re-selects the winner's lot under `session.no_autoflush`.
   Sequential retries verified on SQLite; the parallel-race regression
   is `@_postgres_only` (SQLite StaticPool cannot reproduce
   cross-session mid-transaction visibility — same rationale as the
   existing `test_concurrent_issues_never_overshoot` marker in
   `test_sprint_4_inventory.py`).

### Codex Review Gate Medium findings

**M1 — Tenant / farm authorization moved BEFORE FEED-category validation.**
Previously `consume_for_event` performed the category check first, then
the tenant / farm check, so an unauthorized cross-tenant caller could
distinguish item categories via differential 409 codes
(`inventory_item_not_feed` for non-feed vs `cross_org_lot_reference` for
feed) — a category and existence oracle across tenants. Fix: the
warehouse lookup + `cross_org_lot_reference` + `cross_farm_lot_reference`
guards now run first. Cross-tenant callers observe a single uniform
response for **every** target-lot category, and `item_category` is
never echoed to unauthorized callers. In-tenant callers still receive
the precise `inventory_item_not_feed` error — Task 1 contract preserved.

**M2 — Malformed cursor decoding consistently returns `400 invalid_cursor`.**
`_decode_cursor` now catches `(ValueError, TypeError, LookupError,
binascii.Error)`. All Unicode-related errors (`UnicodeError`,
`UnicodeEncodeError`, `UnicodeDecodeError`) are subclasses of
`ValueError` and are therefore covered. The response message is now a
static `Malformed pagination cursor.` — no exception details are
echoed to the client. Traceback is preserved server-side via
`raise HTTPException(...) from exc`.

---

## Files changed

```
apps/api/app/services/inventory.py
apps/api/app/repositories/inventory.py
apps/api/tests/test_sprint_4_1_hardening.py     (created — 31 tests)
memory/PRD.md                                    (Sprint 4.1 section appended)
```

No changes to Alembic migrations, ORM models, Pydantic schemas,
routers, other services, frontend, environment variables, seed data,
permissions, or dependencies.

---

## Regression tests added

`apps/api/tests/test_sprint_4_1_hardening.py` — 31 tests total, 1
Postgres-only. Grouped by concern:

**Task 1 — FEEDING category guard (5 tests)**

- `test_feeding_rejects_non_feed_category[medicine|chemical|supply]`
- `test_feeding_succeeds_on_feed_category`
- `test_feeding_rejection_writes_no_ledger_rows`

**Task 2 — Cursor pagination (3 tests)**

- `test_cursor_pagination_walks_through_all_rows`
- `test_cursor_pagination_stable_ordering`
- `test_cursor_pagination_rejects_garbage_cursor`

**Task 3 — Storage-location warehouse ownership (3 tests)**

- `test_receipt_accepts_matching_storage_location`
- `test_receipt_rejects_foreign_storage_location`
- `test_transfer_rejects_foreign_dst_storage_location`

**Task 4 — Concurrent receipt lot creation (3 tests)**

- `test_duplicate_receipts_reuse_the_same_lot`
- `test_concurrent_receipts_same_lot_code_do_not_raise` _(Postgres-only)_
- `test_idempotent_replay_still_holds_after_race`

**Sprint-5 scope creep guard (1 test)**

- `test_feed_category_enum_still_present_and_unchanged`

**Codex Medium #1 — cross-tenant FEEDING oracle (5 tests)**

- `test_cross_tenant_feeding_hides_item_category[feed|medicine|chemical|supply]`
- `test_same_tenant_feeding_still_reports_category_error`

**Codex Medium #2 — cursor decoder hardening (12 tests)**

- `test_cursor_decode_returns_400_for_all_malformed_inputs[…]`
  parametrised over: `café`, `日本語`, `🚀`, `!!!not-base64!!!`, `AAA`,
  `gA==`, `_____w==`, `aGVsbG8=`, bad-timestamp, bad-uuid, empty string
- `test_cursor_decode_error_message_does_not_leak_internals`

---

## Validation results

| Gate                                     | Result                                       |
| ---------------------------------------- | -------------------------------------------- |
| Sprint 4.1 target suite                  | **31 passed, 1 skipped** (`@_postgres_only`) |
| Full backend suite                       | **213 passed, 31 skipped, 0 failures**       |
| `ruff check .`                           | all checks passed                            |
| `black --check --target-version=py311 .` | 110 files unchanged                          |
| Frontend `next lint`                     | no ESLint warnings or errors                 |
| Frontend `tsc --noEmit`                  | clean                                        |
| Frontend `vitest --run`                  | 7 / 7 passed                                 |
| Alembic upgrade / downgrade round-trip   | N/A — no schema changes                      |
| `testing_agent_v3_fork` iter-13 (P2)     | 100% backend, 0 issues, 0 action items       |
| `testing_agent_v3_fork` iter-14 (Codex)  | 0 bugs, adversarial probing clean            |

Skipped test breakdown (31): 23 live-server suites unreachable in
hermetic CI (`test_crg03_live.py`, `test_crg03_iter8_live.py`,
`test_sprint4_e2e_curl.py` — all target `127.0.0.1:8055`), 5
Postgres-only concurrency tests, plus 3 legacy Postgres-only markers.

---

## Explicit scope confirmations

- ✅ **Codex Low / Informational findings deferred.** Only the two
  Medium findings (M1, M2) were addressed in this iteration. Any Low /
  Informational recommendations from Codex Review Gate 03 remain
  open and can be picked up in a dedicated follow-up sprint if desired.
- ✅ **No schema changes.** Zero touches to `apps/api/alembic/versions/`,
  zero touches to `apps/api/app/models/`.
- ✅ **No migration changes.** Alembic upgrade / downgrade round-trip
  is not required for this PR.
- ✅ **No frontend changes.** `apps/web/` is untouched; frontend gates
  were re-run only to prove non-regression.
- ✅ **No Sprint 5 work introduced.** Procurement, equipment / asset
  management, water resources, sales, finance, adjustment-approval
  workflow, barcode / QR scanning, and bulk import all remain in the
  backlog as originally planned.
- ✅ **Append-only ledger invariant preserved.** `InventoryTransaction`
  remains immutable; no PATCH / DELETE endpoints were added.

---

## Next steps (do NOT skip)

1. **Final Codex Review Gate approval** on this PR description + diff.
2. **Save to GitHub** via the Emergent chat input to push
   `fix/inventory-hardening-p2` to the remote.
3. **Verify branch contents** on GitHub match the local diff.
4. **Open PR** into `develop`. Do **not** merge until CI is green on
   the real Postgres runner (which will exercise the
   `@_postgres_only` concurrent-race test).
