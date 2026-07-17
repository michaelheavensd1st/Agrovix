"""Sprint 4.1 P2 — Inventory hardening regression tests.

Four hardening items from Codex Review Gate 03:

1. Task 1 — FEEDING may only consume items of category ``feed``.
2. Task 2 — Cursor pagination on lot transactions actually paginates.
3. Task 3 — Receipt / transfer refuses a storage location owned by a
   different warehouse.
4. Task 4 — Two concurrent receipts creating the same
   ``(warehouse, item, lot_code)`` do not raise IntegrityError; the
   loser reuses the winner's lot and idempotent replay still works.

No application-code behaviour outside these four items is tested here
- the existing Sprint 4 suite continues to cover ordinary CRUD,
lifecycle, tenancy, ledger accuracy, and audit rows.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from decimal import Decimal
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.inventory import InventoryItemCategory, InventoryLot, InventoryTransaction

from ._helpers import create_org, create_verified_user, switch_user
from .test_production_engine import (
    _create_batch as _create_prod_batch,
)
from .test_production_engine import (
    _create_unit as _create_prod_unit,
)
from .test_production_engine import (
    _pick_system_unit_type_id,
)
from .test_sprint_4_inventory import (
    _create_feed_item,
    _create_warehouse,
    _new_owner_org_farm,
    _receipt,
)

# Concurrency tests that need real DB-level concurrency semantics.
# SQLite's shared-connection StaticPool test harness cannot expose
# cross-session row visibility mid-transaction the way Postgres does,
# so the race-condition regression is Postgres-only. This mirrors the
# established Sprint 4 ``_postgres_only`` pattern.
_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serializes writers.",
)


# --------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------- #
async def _create_item(
    client: AsyncClient, org_id: str, *, category: str, canonical_unit: str = "kg"
) -> str:
    r = await client.post(
        f"/api/v1/organizations/{org_id}/inventory-items",
        json={
            "code": f"{category.upper()}-{uuid4().hex[:6]}",
            "name": f"{category.title()} SKU",
            "category": category,
            "canonical_unit": canonical_unit,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_lot_for(
    client: AsyncClient, warehouse_id: str, item_id: str, *, quantity: float = 25.0
) -> str:
    r = await _receipt(
        client,
        warehouse_id,
        item_id,
        quantity=quantity,
        lot_code=f"LOT-{uuid4().hex[:6]}",
        idempotency_key=f"seed-{uuid4().hex[:8]}",
    )
    assert r["status"] == 201, r["body"]
    return r["body"]["lot_id"]


async def _create_batch(client: AsyncClient, org_id: str, farm_id: str) -> str:
    """Minimal batch scaffold for FEEDING regression tests.

    ``_new_owner_org_farm`` auto-creates a default site, but this
    helper explicitly builds a fresh site → unit → batch tree so each
    test remains independent from that side-effect (and so the tests
    don't accidentally depend on the auto-site fixture behaviour).
    """
    r = await client.post(
        f"/api/v1/farms/{farm_id}/sites",
        json={"code": f"S-{uuid4().hex[:4]}", "name": "Site A"},
    )
    assert r.status_code == 201, r.text
    site_id = r.json()["id"]
    unit_type_id = await _pick_system_unit_type_id(client, org_id)
    unit_id = await _create_prod_unit(client, site_id, unit_type_id)
    return await _create_prod_batch(client, unit_id)


async def _post_feeding_event(
    client: AsyncClient, batch_id: str, lot_id: str, *, quantity: float = 1.0
) -> dict:
    r = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={
            "event_type": "FEEDING",
            "occurred_at": "2026-02-01T00:00:00Z",
            "data": {
                "inventory_lot_id": lot_id,
                "quantity": quantity,
                "unit": "kg",
            },
        },
        headers={"Idempotency-Key": f"feed-{uuid4().hex[:8]}"},
    )
    return {"status": r.status_code, "body": r.json() if r.text else None}


# --------------------------------------------------------------------- #
# Task 1 — FEEDING may only consume ``category == feed``.
# --------------------------------------------------------------------- #
@pytest.mark.parametrize("category", ["medicine", "chemical", "supply"])
async def test_feeding_rejects_non_feed_category(client: AsyncClient, category: str) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_item(client, ctx["org_id"], category=category)
    lot_id = await _create_lot_for(client, wh_id, item_id)
    batch_id = await _create_batch(client, ctx["org_id"], ctx["farm_id"])

    resp = await _post_feeding_event(client, batch_id, lot_id, quantity=1.0)
    assert resp["status"] == 409, resp["body"]
    assert resp["body"]["detail"]["code"] == "inventory_item_not_feed"
    assert resp["body"]["detail"]["item_category"] == category


async def test_feeding_succeeds_on_feed_category(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_id = await _create_lot_for(client, wh_id, item_id, quantity=50)
    batch_id = await _create_batch(client, ctx["org_id"], ctx["farm_id"])

    resp = await _post_feeding_event(client, batch_id, lot_id, quantity=2.0)
    assert resp["status"] == 201, resp["body"]


async def test_feeding_rejection_writes_no_ledger_rows(client: AsyncClient, db_session) -> None:
    """A rejected FEEDING must NOT leave any consumption tx on the lot."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_item(client, ctx["org_id"], category="medicine")
    lot_id = await _create_lot_for(client, wh_id, item_id)
    batch_id = await _create_batch(client, ctx["org_id"], ctx["farm_id"])

    resp = await _post_feeding_event(client, batch_id, lot_id)
    assert resp["status"] == 409

    tx_count = (
        (
            await db_session.execute(
                select(InventoryTransaction).where(InventoryTransaction.lot_id == uuid.UUID(lot_id))
            )
        )
        .scalars()
        .all()
    )
    # Only the seed RECEIPT should exist — no CONSUMPTION row.
    assert all(t.transaction_type.value == "receipt" for t in tx_count)


# --------------------------------------------------------------------- #
# Task 2 — cursor pagination on lot transactions.
# --------------------------------------------------------------------- #
async def _seed_ledger_rows(
    client: AsyncClient, warehouse_id: str, item_id: str, count: int
) -> str:
    """Post ``count`` receipts on the same lot and return the lot id."""
    lot_code = f"LOT-P-{uuid4().hex[:6]}"
    lot_id: str | None = None
    for _ in range(count):
        r = await _receipt(
            client,
            warehouse_id,
            item_id,
            quantity=1.0,
            lot_code=lot_code,
            idempotency_key=f"seed-{uuid4().hex[:8]}",
        )
        assert r["status"] == 201, r["body"]
        lot_id = r["body"]["lot_id"]
    assert lot_id is not None
    return lot_id


async def test_cursor_pagination_walks_through_all_rows(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_id = await _seed_ledger_rows(client, wh_id, item_id, count=7)

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params = {"limit": 3}
        if cursor is not None:
            params["cursor"] = cursor
        r = await client.get(f"/api/v1/lots/{lot_id}/transactions", params=params)
        assert r.status_code == 200, r.text
        body = r.json()
        rows = body["items"]
        seen.extend(row["id"] for row in rows)
        pages += 1
        cursor = body.get("next_cursor")
        if cursor is None:
            break
        assert pages < 6, "cursor did not advance — pagination is broken"

    # 7 rows over pages of 3 → 3 + 3 + 1 = 3 pages.
    assert pages == 3, pages
    assert len(seen) == 7
    assert len(set(seen)) == 7, "pagination produced duplicates"


async def test_cursor_pagination_stable_ordering(client: AsyncClient) -> None:
    """performed_at DESC, id DESC must hold across pages."""
    from datetime import datetime as _dt

    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_id = await _seed_ledger_rows(client, wh_id, item_id, count=5)

    all_rows: list[dict] = []
    cursor: str | None = None
    while True:
        params = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        r = await client.get(f"/api/v1/lots/{lot_id}/transactions", params=params)
        assert r.status_code == 200, r.text
        body = r.json()
        all_rows.extend(body["items"])
        cursor = body.get("next_cursor")
        if cursor is None:
            break

    from itertools import pairwise

    # Sorted-DESC by performed_at, then by id.
    for a, b in pairwise(all_rows):
        ta, tb = _dt.fromisoformat(a["performed_at"]), _dt.fromisoformat(b["performed_at"])
        assert (ta, a["id"]) > (tb, b["id"]), (a, b)


async def test_cursor_pagination_rejects_garbage_cursor(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_id = await _seed_ledger_rows(client, wh_id, item_id, count=1)

    r = await client.get(
        f"/api/v1/lots/{lot_id}/transactions", params={"limit": 5, "cursor": "not-a-cursor"}
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_cursor"


# --------------------------------------------------------------------- #
# Task 3 — storage-location must belong to the target warehouse.
# --------------------------------------------------------------------- #
async def _create_storage_location(client: AsyncClient, warehouse_id: str) -> str:
    r = await client.post(
        f"/api/v1/warehouses/{warehouse_id}/storage-locations",
        json={"code": f"BIN-{uuid4().hex[:4]}", "name": "Bin A"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_receipt_accepts_matching_storage_location(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    loc_id = await _create_storage_location(client, wh_id)

    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:receive",
        json={
            "item_id": item_id,
            "lot_code": f"LOT-{uuid4().hex[:6]}",
            "quantity": 5.0,
            "unit": "kg",
            "storage_location_id": loc_id,
        },
        headers={"Idempotency-Key": f"r-{uuid4().hex[:8]}"},
    )
    assert r.status_code == 201, r.text


async def test_receipt_rejects_foreign_storage_location(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    src_wh = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"], code="SRC")
    dst_wh = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"], code="DST")
    item_id = await _create_feed_item(client, ctx["org_id"])
    foreign_loc = await _create_storage_location(client, dst_wh)

    r = await client.post(
        f"/api/v1/warehouses/{src_wh}/inventory:receive",
        json={
            "item_id": item_id,
            "lot_code": f"LOT-{uuid4().hex[:6]}",
            "quantity": 5.0,
            "unit": "kg",
            "storage_location_id": foreign_loc,  # belongs to dst_wh
        },
        headers={"Idempotency-Key": f"r-{uuid4().hex[:8]}"},
    )
    assert r.status_code == 409, r.text
    body = r.json()["detail"]
    assert body["code"] == "storage_location_wrong_warehouse"


async def test_transfer_rejects_foreign_dst_storage_location(
    client: AsyncClient, db_session
) -> None:
    ctx = await _new_owner_org_farm(client)
    src_wh = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"], code="A")
    dst_wh = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"], code="B")
    third_wh = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"], code="C")
    item_id = await _create_feed_item(client, ctx["org_id"])
    src_lot_id = await _create_lot_for(client, src_wh, item_id, quantity=20)
    foreign_loc = await _create_storage_location(client, third_wh)

    r = await client.post(
        f"/api/v1/warehouses/{src_wh}/inventory:transfer",
        json={
            "lot_id": src_lot_id,
            "destination_warehouse_id": dst_wh,
            "quantity": 5.0,
            "unit": "kg",
            "destination_storage_location_id": foreign_loc,  # bin lives on third_wh
        },
        headers={"Idempotency-Key": f"x-{uuid4().hex[:8]}"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "storage_location_wrong_warehouse"

    # No dst lot must have been created.
    dst_lots = (
        (
            await db_session.execute(
                select(InventoryLot).where(InventoryLot.warehouse_id == uuid.UUID(dst_wh))
            )
        )
        .scalars()
        .all()
    )
    assert dst_lots == []


# --------------------------------------------------------------------- #
# Task 4 — concurrent receipt lot creation.
# --------------------------------------------------------------------- #
async def test_duplicate_receipts_reuse_the_same_lot(client: AsyncClient) -> None:
    """Sequential retries on ``(warehouse, item, lot_code)`` reuse the lot."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_code = f"LOT-DUP-{uuid4().hex[:6]}"

    r1 = await _receipt(
        client, wh_id, item_id, quantity=10, lot_code=lot_code, idempotency_key="k1"
    )
    r2 = await _receipt(
        client, wh_id, item_id, quantity=15, lot_code=lot_code, idempotency_key="k2"
    )
    assert r1["status"] == 201, r1["body"]
    assert r2["status"] == 201, r2["body"]
    # Same lot on both receipts.
    assert r1["body"]["lot_id"] == r2["body"]["lot_id"]


@_postgres_only
async def test_concurrent_receipts_same_lot_code_do_not_raise(client: AsyncClient) -> None:
    """Fire two receipts on ``(warehouse, item, lot_code)`` in parallel.

    The savepoint-wrapped ``_get_or_create_lot_safe`` must catch the
    unique-constraint conflict of the loser, re-select the winner's
    lot, and complete a valid RECEIPT ledger row. Both HTTP responses
    must be 201 and both must reference the same lot id.
    """
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_code = f"LOT-RACE-{uuid4().hex[:6]}"

    r1, r2 = await asyncio.gather(
        _receipt(client, wh_id, item_id, quantity=3, lot_code=lot_code, idempotency_key="ra"),
        _receipt(client, wh_id, item_id, quantity=7, lot_code=lot_code, idempotency_key="rb"),
    )
    assert r1["status"] == 201, r1["body"]
    assert r2["status"] == 201, r2["body"]
    assert r1["body"]["lot_id"] == r2["body"]["lot_id"], (r1, r2)


async def test_idempotent_replay_still_holds_after_race(client: AsyncClient) -> None:
    """Retrying the SAME idempotency key on the same lot returns
    the same tx id whether or not a race just resolved."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    lot_code = f"LOT-IR-{uuid4().hex[:6]}"

    key = f"idem-{uuid4().hex[:8]}"
    r1 = await _receipt(client, wh_id, item_id, quantity=2, lot_code=lot_code, idempotency_key=key)
    r2 = await _receipt(client, wh_id, item_id, quantity=2, lot_code=lot_code, idempotency_key=key)
    assert r1["status"] == 201
    assert r2["status"] == 200  # replay
    assert r2["headers"].get("x-idempotent-replay") == "true"
    assert r1["body"]["id"] == r2["body"]["id"]


# Guard against accidental Sprint 5 scope creep.
def test_feed_category_enum_still_present_and_unchanged() -> None:
    assert InventoryItemCategory.FEED.value == "feed"
    assert {c.value for c in InventoryItemCategory} == {"feed", "medicine", "chemical", "supply"}


# --------------------------------------------------------------------- #
# Codex Review Gate — Medium finding #1: tenant / farm authorization
# MUST run BEFORE the FEEDING category guard so cross-tenant callers
# cannot distinguish item categories via differential error codes.
# --------------------------------------------------------------------- #
async def _new_second_owner_org_farm(client: AsyncClient) -> dict:
    """Create a fully independent (user, org, farm) belonging to a
    different tenant. Used to prove cross-tenant callers see the
    tenant-boundary response, never the category-specific one.
    """
    email = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(email)
    await switch_user(client, email)
    org_id = await create_org(client, slug=f"out-{uuid4().hex[:6]}")
    from ._helpers import create_farm

    farm_id = await create_farm(client, org_id)
    r = await client.get(f"/api/v1/farms/{farm_id}/sites")
    assert r.status_code == 200, r.text
    sites = r.json()
    return {"owner": email, "org_id": org_id, "farm_id": farm_id, "site_id": sites[0]["id"]}


@pytest.mark.parametrize("category", ["feed", "medicine", "chemical", "supply"])
async def test_cross_tenant_feeding_hides_item_category(client: AsyncClient, category: str) -> None:
    """Codex Review Gate (Medium) — cross-tenant callers must observe
    the SAME error code regardless of the target lot's category.

    Setup: victim (org V) has a lot of every category. Outsider (org O)
    owns their own batch and posts a FEEDING event referencing the
    victim's lot. Before the fix, the outsider saw
    ``inventory_item_not_feed`` for non-feed lots and
    ``cross_org_lot_reference`` for feed lots — a category oracle.
    After the fix, both cases surface the tenant-boundary error
    (``cross_org_lot_reference``), leaking neither category nor
    existence details.
    """
    # Victim org creates a warehouse + lot with the parametrised category.
    victim = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, victim["org_id"], farm_id=victim["farm_id"])
    if category == "feed":
        item_id = await _create_feed_item(client, victim["org_id"])
    else:
        item_id = await _create_item(client, victim["org_id"], category=category)
    lot_id = await _create_lot_for(client, wh_id, item_id, quantity=25)

    # Outsider org creates its own batch on its own farm.
    outsider = await _new_second_owner_org_farm(client)
    unit_type_id = await _pick_system_unit_type_id(client, outsider["org_id"])
    outsider_site_id = outsider["site_id"]
    outsider_unit_id = await _create_prod_unit(client, outsider_site_id, unit_type_id)
    outsider_batch_id = await _create_prod_batch(client, outsider_unit_id)

    # Cross-tenant FEEDING attempt.
    resp = await _post_feeding_event(client, outsider_batch_id, lot_id, quantity=1.0)

    # The response MUST be the tenant-boundary error — NEVER the
    # category-specific one — so no category / existence oracle exists.
    assert resp["status"] == 409, resp["body"]
    assert resp["body"]["detail"]["code"] == "cross_org_lot_reference", resp["body"]
    # And crucially, the item_category MUST NOT be echoed back to the
    # unauthorized caller under any of the four categories.
    assert "item_category" not in resp["body"]["detail"]
    assert resp["body"]["detail"]["code"] != "inventory_item_not_feed"


async def test_same_tenant_feeding_still_reports_category_error(client: AsyncClient) -> None:
    """Ensure fix #1 did not regress the in-tenant contract: a caller
    within the correct org / farm still receives the precise
    ``inventory_item_not_feed`` error (Task 1). The category oracle is
    only silenced for cross-tenant callers.
    """
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_item(client, ctx["org_id"], category="medicine")
    lot_id = await _create_lot_for(client, wh_id, item_id)
    batch_id = await _create_batch(client, ctx["org_id"], ctx["farm_id"])

    resp = await _post_feeding_event(client, batch_id, lot_id, quantity=1.0)
    assert resp["status"] == 409, resp["body"]
    assert resp["body"]["detail"]["code"] == "inventory_item_not_feed"
    assert resp["body"]["detail"]["item_category"] == "medicine"


# --------------------------------------------------------------------- #
# Codex Review Gate — Medium finding #2: cursor decoding must
# funnel every malformed input into 400 ``invalid_cursor``.
# --------------------------------------------------------------------- #
async def _lot_for_cursor_tests(client: AsyncClient) -> str:
    """Bare-minimum lot so ``/lots/{id}/transactions`` is reachable."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    return await _seed_ledger_rows(client, wh_id, item_id, count=1)


@pytest.mark.parametrize(
    "bad_cursor,label",
    [
        # Non-ASCII characters — must NOT crash on ``encode('ascii')``.
        ("café", "unicode-latin"),
        ("日本語", "unicode-cjk"),
        ("🚀", "unicode-emoji"),
        # Invalid base64 alphabet / padding.
        ("!!!not-base64!!!", "invalid-base64-alphabet"),
        ("AAA", "base64-bad-padding"),
        # Valid base64 that decodes to non-UTF-8 bytes.
        ("gA==", "base64-non-utf8"),
        ("_____w==", "base64-invalid-utf8-multibyte"),
        # Valid base64 + UTF-8 but no '|' delimiter.
        ("aGVsbG8=", "no-delimiter"),
        # Valid delimiter but malformed timestamp.
        ("bm90LWEtdGltZXwxMjM0NTY3OA==", "bad-timestamp"),
        # Valid timestamp but malformed UUID.
        ("MjAyNi0wMS0wMVQwMDowMDowMHxub3QtYS11dWlk", "bad-uuid"),
        # Empty string.
        ("", "empty"),
    ],
)
async def test_cursor_decode_returns_400_for_all_malformed_inputs(
    client: AsyncClient, bad_cursor: str, label: str
) -> None:
    """Every client-controlled malformed cursor MUST return 400
    ``invalid_cursor`` — never 500, never a raw ``ValueError`` /
    ``UnicodeEncodeError`` traceback. This is the documented contract
    for the pagination endpoint.
    """
    lot_id = await _lot_for_cursor_tests(client)
    r = await client.get(
        f"/api/v1/lots/{lot_id}/transactions",
        params={"limit": 5, "cursor": bad_cursor},
    )
    assert r.status_code == 400, (label, r.status_code, r.text)
    body = r.json()
    assert body["detail"]["code"] == "invalid_cursor", (label, body)
    # Guard against the previous behaviour of leaking the raw parser
    # exception message back to the client.
    assert "message" in body["detail"]
    assert body["detail"]["message"] == "Malformed pagination cursor."


async def test_cursor_decode_error_message_does_not_leak_internals(
    client: AsyncClient,
) -> None:
    """Regression: the error message must be a static, generic string
    and must never echo the raw ``ValueError`` / ``binascii.Error`` /
    ``UnicodeEncodeError`` details from the decoder (which could reveal
    the cursor format or Python internals to a probing client).
    """
    lot_id = await _lot_for_cursor_tests(client)
    r = await client.get(
        f"/api/v1/lots/{lot_id}/transactions",
        params={"limit": 5, "cursor": "café"},
    )
    assert r.status_code == 400, r.text
    msg = r.json()["detail"]["message"]
    # No traceback fragments, no Python exception class names, no
    # bytes objects, no reference to base64 / ascii / codec internals.
    for forbidden in ("Traceback", "ascii", "codec", "b64decode", "0x", "UnicodeE"):
        assert forbidden not in msg, (forbidden, msg)


# Silence the linter about the imported `Decimal`.
_ = Decimal("1")
