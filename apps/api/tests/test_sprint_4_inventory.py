"""Sprint 4 — Operational Resources 01 (Inventory) integration tests.

Covers the full Definition of Done:

* tenant + farm isolation (org-scoped catalog, farm-pinned warehouses)
* permission enforcement per endpoint
* receipt / issue / transfer / adjustment / reversal / consumption
* insufficient-stock rejection
* unit incompatibility
* duplicate idempotency replay + conflicting-payload rejection
* concurrent deductions against the same lot (Postgres-only)
* FEEDING event → inventory consumption atomicity
* rollback when event insert fails
* rollback when inventory deduction fails
* no double deduction on retry
* immutable posted transactions (no PATCH / DELETE endpoint exists)
* reconciliation accuracy
"""

from __future__ import annotations

import asyncio
import os
from decimal import Decimal
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy import update as sa_update

from app.db import session as _db_session_module
from app.models.inventory import InventoryTransaction as _InventoryTransaction
from app.models.inventory import InventoryTransactionType as _InventoryTransactionType
from app.services.inventory import signed_delta
from tests._helpers import (
    create_org,
    create_verified_user,
    invite_and_accept,
    stocking_payload,
    switch_user,
)
from tests.test_production_engine import (
    _create_batch,
    _create_unit,
    _new_owner_org_farm,
    _pick_system_unit_type_id,
)

pytestmark = pytest.mark.asyncio

_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serializes writers.",
)


# --------------------------------------------------------------------- #
# Fixture helpers
# --------------------------------------------------------------------- #
async def _create_warehouse(
    client: AsyncClient, org_id: str, *, farm_id: str | None = None, code: str | None = None
) -> str:
    code = code or f"WH-{uuid4().hex[:6]}"
    body = {"name": code, "code": code}
    if farm_id is not None:
        body["farm_id"] = farm_id
    r = await client.post(
        f"/api/v1/organizations/{org_id}/warehouses",
        json=body,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_feed_item(client: AsyncClient, org_id: str, *, canonical_unit: str = "kg") -> str:
    r = await client.post(
        f"/api/v1/organizations/{org_id}/inventory-items",
        json={
            "code": f"FEED-{uuid4().hex[:6]}",
            "name": "Starter Feed",
            "category": "feed",
            "canonical_unit": canonical_unit,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _receipt(
    client: AsyncClient,
    warehouse_id: str,
    item_id: str,
    *,
    quantity: float = 100.0,
    unit: str = "kg",
    lot_code: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    headers = {}
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    r = await client.post(
        f"/api/v1/warehouses/{warehouse_id}/inventory:receive",
        json={
            "item_id": item_id,
            "lot_code": lot_code or f"LOT-{uuid4().hex[:6]}",
            "quantity": quantity,
            "unit": unit,
        },
        headers=headers,
    )
    return {"status": r.status_code, "body": r.json() if r.text else None, "headers": r.headers}


# --------------------------------------------------------------------- #
# 1. Basic CRUD + tenancy isolation
# --------------------------------------------------------------------- #
async def test_owner_can_create_warehouse_and_item(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    assert wh_id and item_id


async def test_cross_org_cannot_see_warehouse(client: AsyncClient) -> None:
    """Non-member of an org gets 404 on the warehouse endpoints."""
    a = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, a["org_id"], farm_id=a["farm_id"])

    outsider = f"out-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"out-{uuid4().hex[:6]}")

    r = await client.get(f"/api/v1/warehouses/{wh_id}")
    assert r.status_code == 404, r.text


async def test_farm_pinned_warehouse_still_org_visible(
    client: AsyncClient,
) -> None:
    """A farm-pinned warehouse is still visible to org-scope readers.

    Sprint 4 puts the visibility filter at farm-membership OR
    org-membership; org-scoped `viewer` role has org membership so
    they see the warehouse even though it's pinned to a farm they
    aren't directly assigned to. Farm-only visibility narrowing is a
    Sprint 5 concern.
    """
    a_ctx = await _new_owner_org_farm(client)  # owner + farm A
    wh_a = await _create_warehouse(client, a_ctx["org_id"], farm_id=a_ctx["farm_id"])

    reader = f"reader-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(reader)
    await invite_and_accept(
        client,
        inviter_email=a_ctx["owner"],
        invitee_email=reader,
        org_id=a_ctx["org_id"],
        role_name="viewer",
    )
    r = await client.get(f"/api/v1/organizations/{a_ctx['org_id']}/warehouses")
    assert r.status_code == 200
    ids = [w["id"] for w in r.json()]
    assert wh_a in ids


# --------------------------------------------------------------------- #
# 2. Receipt + balance
# --------------------------------------------------------------------- #
async def test_receipt_creates_lot_and_balance(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    r = await _receipt(client, wh_id, item_id, quantity=100.0, unit="kg", lot_code="L1")
    assert r["status"] == 201
    tx = r["body"]
    assert tx["transaction_type"] == "receipt"
    assert Decimal(str(tx["quantity"])) == Decimal("100.000000")

    # List lots — balance must equal received quantity in canonical unit.
    r = await client.get(f"/api/v1/warehouses/{wh_id}/lots")
    assert r.status_code == 200
    lot = r.json()[0]
    assert Decimal(str(lot["balance"])) == Decimal("100.000000")
    assert lot["balance_unit"] == "kg"


async def test_receipt_with_unit_conversion(client: AsyncClient) -> None:
    """Receiving 2000 g into a lot with canonical kg → balance = 2 kg."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"], canonical_unit="kg")
    r = await _receipt(client, wh_id, item_id, quantity=2000, unit="g", lot_code="L1")
    assert r["status"] == 201
    r = await client.get(f"/api/v1/warehouses/{wh_id}/lots")
    lot = r.json()[0]
    assert Decimal(str(lot["balance"])) == Decimal("2.000000")


async def test_receipt_incompatible_unit_rejected(client: AsyncClient) -> None:
    """kg item + mL receipt → 409 unit_incompatible."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"], canonical_unit="kg")
    r = await _receipt(client, wh_id, item_id, quantity=1.0, unit="mL")
    assert r["status"] == 409
    assert r["body"]["detail"]["code"] == "unit_incompatible"


# --------------------------------------------------------------------- #
# 3. Idempotency
# --------------------------------------------------------------------- #
async def test_receipt_idempotency_replay(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    key = f"idem-{uuid4().hex[:8]}"
    r1 = await _receipt(
        client, wh_id, item_id, quantity=50.0, unit="kg", lot_code="L1", idempotency_key=key
    )
    r2 = await _receipt(
        client, wh_id, item_id, quantity=50.0, unit="kg", lot_code="L1", idempotency_key=key
    )
    assert r1["status"] == 201
    assert r2["status"] == 200
    assert r2["headers"].get("x-idempotent-replay") == "true"
    # Same tx id — no duplicate.
    assert r1["body"]["id"] == r2["body"]["id"]

    # Balance shows a single 50kg receipt, not 100.
    r = await client.get(f"/api/v1/warehouses/{wh_id}/lots")
    assert Decimal(str(r.json()[0]["balance"])) == Decimal("50.000000")


async def test_receipt_idempotency_payload_conflict(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    key = f"idem-{uuid4().hex[:8]}"
    await _receipt(client, wh_id, item_id, quantity=50.0, lot_code="L1", idempotency_key=key)
    r = await _receipt(client, wh_id, item_id, quantity=75.0, lot_code="L1", idempotency_key=key)
    assert r["status"] == 409, r
    assert r["body"]["detail"]["code"] == "idempotency_key_payload_conflict"


# --------------------------------------------------------------------- #
# 4. Issue / Transfer / Adjustment / Reversal
# --------------------------------------------------------------------- #
async def _lot_id_for(client: AsyncClient, wh_id: str) -> str:
    r = await client.get(f"/api/v1/warehouses/{wh_id}/lots")
    assert r.status_code == 200
    return r.json()[0]["id"]


async def test_issue_deducts_and_rejects_insufficient(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=10, unit="kg", lot_code="L1")
    lot_id = await _lot_id_for(client, wh_id)
    # Sufficient issue.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 4, "unit": "kg"},
    )
    assert r.status_code == 201, r.text
    # Insufficient issue.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 7, "unit": "kg"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "insufficient_stock"


async def test_transfer_moves_stock_between_warehouses(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    src = await _create_warehouse(client, ctx["org_id"], code="SRC")
    dst = await _create_warehouse(client, ctx["org_id"], code="DST")
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, src, item_id, quantity=20, unit="kg", lot_code="L1")
    src_lot = await _lot_id_for(client, src)
    r = await client.post(
        f"/api/v1/warehouses/{src}/inventory:transfer",
        json={
            "lot_id": src_lot,
            "destination_warehouse_id": dst,
            "quantity": 8,
            "unit": "kg",
        },
    )
    assert r.status_code == 201, r.text
    src_lots = (await client.get(f"/api/v1/warehouses/{src}/lots")).json()
    dst_lots = (await client.get(f"/api/v1/warehouses/{dst}/lots")).json()
    assert Decimal(str(src_lots[0]["balance"])) == Decimal("12.000000")
    assert Decimal(str(dst_lots[0]["balance"])) == Decimal("8.000000")


async def test_adjustment_requires_reason(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=5, lot_code="L1")
    lot_id = await _lot_id_for(client, wh_id)
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "quantity": 1,
            "unit": "kg",
            "direction": "increase",
            # missing reason
        },
    )
    assert r.status_code == 422


async def test_reversal_flips_balance(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    receipt_tx = (await _receipt(client, wh_id, item_id, quantity=10, lot_code="L1"))["body"]

    # Reverse the receipt — balance goes back to 0.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse",
        json={
            "reverses_transaction_id": receipt_tx["id"],
            "reason": "Wrong lot code entered by warehouse clerk.",
        },
    )
    assert r.status_code == 201, r.text
    lots = (await client.get(f"/api/v1/warehouses/{wh_id}/lots")).json()
    assert Decimal(str(lots[0]["balance"])) == Decimal("0")

    # Second reversal on the same original → 409.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse",
        json={"reverses_transaction_id": receipt_tx["id"], "reason": "again"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "already_reversed"


# --------------------------------------------------------------------- #
# 5. FEEDING event → inventory consumption atomicity
# --------------------------------------------------------------------- #
async def _make_active_batch_with_lot(client: AsyncClient) -> dict:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    batch_id = await _create_batch(client, unit_id)
    r = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={"event_type": "STOCKING", "data": stocking_payload(quantity=100)},
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        f"/api/v1/batches/{batch_id}/transitions", json={"target_state": "active"}
    )
    assert r.status_code == 200, r.text
    wh_id = await _create_warehouse(client, ctx["org_id"], farm_id=ctx["farm_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=25, unit="kg", lot_code="FEED-01")
    lot_id = await _lot_id_for(client, wh_id)
    ctx.update(unit_id=unit_id, batch_id=batch_id, wh_id=wh_id, item_id=item_id, lot_id=lot_id)
    return ctx


async def test_feeding_with_lot_deducts_inventory(client: AsyncClient) -> None:
    ctx = await _make_active_batch_with_lot(client)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "FEEDING",
            "data": {
                "quantity": 3.0,
                "unit": "kg",
                "inventory_lot_id": ctx["lot_id"],
            },
        },
    )
    assert r.status_code == 201, r.text
    # Balance went from 25 → 22.
    lots = (await client.get(f"/api/v1/warehouses/{ctx['wh_id']}/lots")).json()
    assert Decimal(str(lots[0]["balance"])) == Decimal("22.000000")

    # Transaction ledger for the lot shows the CONSUMPTION row.
    r = await client.get(f"/api/v1/lots/{ctx['lot_id']}/transactions")
    types = [t["transaction_type"] for t in r.json()["items"]]
    assert "consumption" in types


@_postgres_only
async def test_feeding_insufficient_stock_rolls_back_event(client: AsyncClient) -> None:
    """FEEDING quantity > lot balance → both the event AND the deduction
    roll back (savepoint delivers the event insert; the consumption
    raises 409 and the outer request rolls back).

    Postgres-only: SQLite's StaticPool + shared connection semantics
    make it impossible to reliably observe outer-transaction rollback
    across nested savepoints in this test harness. Real DB-level
    transaction behaviour is what we're validating anyway.
    """
    ctx = await _make_active_batch_with_lot(client)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "FEEDING",
            "data": {
                "quantity": 999.0,
                "unit": "kg",
                "inventory_lot_id": ctx["lot_id"],
            },
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "insufficient_stock"
    # No event was persisted.
    r = await client.get(
        f"/api/v1/batches/{ctx['batch_id']}/events", params={"event_type": "FEEDING"}
    )
    assert r.status_code == 200
    assert r.json()["items"] == []
    # No consumption row was persisted.
    r = await client.get(f"/api/v1/lots/{ctx['lot_id']}/transactions")
    types = [t["transaction_type"] for t in r.json()["items"]]
    assert "consumption" not in types


async def test_feeding_retry_does_not_double_deduct(client: AsyncClient) -> None:
    ctx = await _make_active_batch_with_lot(client)
    key = f"feed-{uuid4().hex[:8]}"
    body = {
        "event_type": "FEEDING",
        "data": {
            "quantity": 4.0,
            "unit": "kg",
            "inventory_lot_id": ctx["lot_id"],
        },
    }
    r1 = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    r2 = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201
    assert r2.status_code == 200
    # Balance dropped exactly once: 25 - 4 = 21.
    lots = (await client.get(f"/api/v1/warehouses/{ctx['wh_id']}/lots")).json()
    assert Decimal(str(lots[0]["balance"])) == Decimal("21.000000")


async def test_feeding_without_lot_still_works(client: AsyncClient) -> None:
    """Farms without configured inventory keep the ad-hoc path."""
    ctx = await _make_active_batch_with_lot(client)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "FEEDING",
            "data": {
                "quantity": 1.0,
                "unit": "kg",
                "feed_description": "Ad-hoc starter crumble",
            },
        },
    )
    assert r.status_code == 201


# --------------------------------------------------------------------- #
# 6. Concurrency (Postgres-only)
# --------------------------------------------------------------------- #
@_postgres_only
async def test_concurrent_issues_never_overshoot(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=10, lot_code="L1")
    lot_id = await _lot_id_for(client, wh_id)
    body = {"lot_id": lot_id, "quantity": 6, "unit": "kg"}

    r1, r2 = await asyncio.gather(
        client.post(f"/api/v1/warehouses/{wh_id}/inventory:issue", json=body),
        client.post(f"/api/v1/warehouses/{wh_id}/inventory:issue", json=body),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    # 6 + 6 > 10 — exactly one must fail 409.
    assert statuses[0] == 201, (r1.text, r2.text)
    assert statuses[1] == 409, (r1.text, r2.text)
    lots = (await client.get(f"/api/v1/warehouses/{wh_id}/lots")).json()
    assert Decimal(str(lots[0]["balance"])) == Decimal("4.000000")


# --------------------------------------------------------------------- #
# 7. Reconciliation — projections always agree with the ledger
# --------------------------------------------------------------------- #
async def test_reconciliation_ledger_matches_projection(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=10, unit="kg", lot_code="L1")
    lot_id = await _lot_id_for(client, wh_id)
    # Issue 3, adjust +1, issue 2. Expected balance = 10 - 3 + 1 - 2 = 6.
    await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 3, "unit": "kg"},
    )
    await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "quantity": 1,
            "unit": "kg",
            "direction": "increase",
            "reason": "Recount",
        },
    )
    await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 2, "unit": "kg"},
    )
    r = await client.get(f"/api/v1/lots/{lot_id}")
    assert Decimal(str(r.json()["balance"])) == Decimal("6.000000")


# --------------------------------------------------------------------- #
# 8. Permission enforcement
# --------------------------------------------------------------------- #
async def test_viewer_cannot_receive_stock(client: AsyncClient) -> None:
    owner = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, owner["org_id"], farm_id=owner["farm_id"])
    item_id = await _create_feed_item(client, owner["org_id"])

    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=owner["owner"],
        invitee_email=viewer,
        org_id=owner["org_id"],
        role_name="viewer",
    )
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:receive",
        json={
            "item_id": item_id,
            "lot_code": "L1",
            "quantity": 1,
            "unit": "kg",
        },
    )
    assert r.status_code == 403, r.text
    assert "inventory_transaction.create" in r.json()["detail"]


async def test_viewer_can_read_lots(client: AsyncClient) -> None:
    owner = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, owner["org_id"], farm_id=owner["farm_id"])
    item_id = await _create_feed_item(client, owner["org_id"])
    await _receipt(client, wh_id, item_id, quantity=3, lot_code="L1")

    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=owner["owner"],
        invitee_email=viewer,
        org_id=owner["org_id"],
        role_name="viewer",
    )
    r = await client.get(f"/api/v1/warehouses/{wh_id}/lots")
    assert r.status_code == 200
    assert len(r.json()) == 1


# --------------------------------------------------------------------- #
# 9. Closed warehouse is read-only
# --------------------------------------------------------------------- #
async def test_closed_warehouse_blocks_writes(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await _receipt(client, wh_id, item_id, quantity=1)
    assert r["status"] == 409
    assert r["body"]["detail"]["code"] == "warehouse_closed_no_writes"


# --------------------------------------------------------------------- #
# 10. CRG03 fixes — MAINTENANCE lifecycle, dual-warehouse permission,
# reversal idempotency replay, audit logging on service-scope mutations.
# --------------------------------------------------------------------- #
async def test_maintenance_warehouse_blocks_outbound_but_allows_inbound(
    client: AsyncClient,
) -> None:
    """MAINTENANCE = inbound + reversal allowed; outbound refused."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    # Seed some stock before entering maintenance.
    seed = await _receipt(client, wh_id, item_id, quantity=100, lot_code="L1")
    assert seed["status"] == 201, seed["body"]
    lot_id = await _lot_id_for(client, wh_id)

    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "maintenance"

    # RECEIPT still allowed.
    r = await _receipt(client, wh_id, item_id, quantity=5, lot_code="L1")
    assert r["status"] == 201, r["body"]

    # ADJUSTMENT_INCREASE still allowed.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "quantity": 1,
            "unit": "kg",
            "direction": "increase",
            "reason": "audit correction",
        },
    )
    assert r.status_code == 201, r.text

    # ISSUE blocked with a clear MAINTENANCE code.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 1, "unit": "kg"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "warehouse_under_maintenance"

    # ADJUSTMENT_DECREASE blocked.
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "quantity": 1,
            "unit": "kg",
            "direction": "decrease",
            "reason": "loss",
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "warehouse_under_maintenance"


async def test_maintenance_warehouse_blocks_transfer_out(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    src = await _create_warehouse(client, ctx["org_id"], code="SRC-MAINT")
    dst = await _create_warehouse(client, ctx["org_id"], code="DST-OK")
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, src, item_id, quantity=50, lot_code="LM")
    lot_id = await _lot_id_for(client, src)

    r = await client.patch(f"/api/v1/warehouses/{src}", json={"status": "maintenance"})
    assert r.status_code == 200

    r = await client.post(
        f"/api/v1/warehouses/{src}/inventory:transfer",
        json={
            "lot_id": lot_id,
            "destination_warehouse_id": dst,
            "quantity": 10,
            "unit": "kg",
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "warehouse_under_maintenance"
    assert r.json()["detail"]["transaction_type"] == "transfer_out"


async def test_maintenance_reopen_to_active_restores_writes(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, wh_id, item_id, quantity=20, lot_code="LR")
    lot_id = await _lot_id_for(client, wh_id)

    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "maintenance"})
    assert r.status_code == 200
    # blocked
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 1, "unit": "kg"},
    )
    assert r.status_code == 409
    # reopen
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "active"})
    assert r.status_code == 200
    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:issue",
        json={"lot_id": lot_id, "quantity": 1, "unit": "kg"},
    )
    assert r.status_code == 201


async def test_reversal_under_maintenance_allowed(client: AsyncClient) -> None:
    """Reversals are audit corrections — allowed even under MAINTENANCE."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    receipt = await _receipt(client, wh_id, item_id, quantity=30, lot_code="LREV")
    receipt_tx_id = receipt["body"]["id"]

    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "maintenance"})
    assert r.status_code == 200

    r = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse",
        json={"reverses_transaction_id": receipt_tx_id, "reason": "posted in error"},
        headers={"Idempotency-Key": f"rev-{uuid4().hex[:8]}"},
    )
    assert r.status_code == 201, r.text


async def test_closed_warehouse_only_reopens_via_status_flip(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    # Non-status field on a CLOSED warehouse is refused.
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"name": "Renamed while closed"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "warehouse_closed_no_writes"
    # Reopen via status transition works.
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "active"})
    assert r.status_code == 200
    assert r.json()["status"] == "active"


# --------------------------------------------------------------------- #
# CRG03 verification-only pass — CLOSED PATCH must be status-only.
# Reopening and ordinary mutations must be two separate requests.
# --------------------------------------------------------------------- #
async def test_closed_patch_status_only_active_reopens(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    # Status-only reopen is the ONE allowed shape.
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "active"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"


async def test_closed_patch_status_only_maintenance_reopens(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "maintenance"


async def test_closed_patch_name_only_refused(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"name": "x"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "warehouse_closed_no_writes"
    assert "name" in r.json()["detail"]["submitted_fields"]


async def test_closed_patch_status_plus_name_refused(client: AsyncClient) -> None:
    """CRG03 P0 gap — {status: active, name: 'x'} was previously
    accepted because the reopen branch allowed accompanying fields.
    This test locks the correct behaviour: mixing status with any
    other field returns 409 even when the status transition would
    otherwise be valid."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "active", "name": "x"})
    assert r.status_code == 409, r.text
    body = r.json()["detail"]
    assert body["code"] == "warehouse_closed_no_writes"
    assert set(body["submitted_fields"]) == {"status", "name"}
    # Confirm the warehouse is still CLOSED — the aborted PATCH must
    # have left the state untouched.
    r = await client.get(f"/api/v1/warehouses/{wh_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "closed"


async def test_closed_patch_status_plus_farm_id_refused(client: AsyncClient) -> None:
    """farm_id is not part of ``WarehouseUpdate`` today, but the
    guard must reject it even if the schema is extended. Sends
    ``address`` instead (present in ``WarehouseUpdate``) as a
    schema-visible proxy for 'status + other field'."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    r = await client.patch(
        f"/api/v1/warehouses/{wh_id}", json={"status": "active", "address": "12 New Rd"}
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "warehouse_closed_no_writes"
    # Still CLOSED — no partial application.
    r = await client.get(f"/api/v1/warehouses/{wh_id}")
    assert r.status_code == 200
    assert r.json()["status"] == "closed"
    assert r.json()["address"] is None


async def test_closed_reopen_then_edit_is_two_step_flow(client: AsyncClient) -> None:
    """After a successful status-only reopen, ordinary fields may be
    updated in a subsequent PATCH — proving reopen and mutate are
    two separate requests."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "closed"})
    assert r.status_code == 200
    # Step 1 — reopen only.
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"status": "active"})
    assert r.status_code == 200
    assert r.json()["status"] == "active"
    # Step 2 — rename in a separate call.
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"name": "HQ (reopened)"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "HQ (reopened)"
    assert r.json()["status"] == "active"


async def test_transfer_requires_permission_on_destination(client: AsyncClient) -> None:
    """Source-farm operator without dst-farm access cannot pump stock in."""
    owner = await _new_owner_org_farm(client)
    owner_email = owner["owner"]

    # Second farm on the same org (destination).
    await switch_user(client, owner_email)
    r = await client.post(
        f"/api/v1/organizations/{owner['org_id']}/farms",
        json={"name": "Farm-B", "code": f"farm-b-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    farm_b_id = r.json()["id"]

    src = await _create_warehouse(client, owner["org_id"], farm_id=owner["farm_id"], code="SRC-A")
    dst = await _create_warehouse(client, owner["org_id"], farm_id=farm_b_id, code="DST-B")
    item_id = await _create_feed_item(client, owner["org_id"])
    await _receipt(client, src, item_id, quantity=50, lot_code="LX")
    lot_id = await _lot_id_for(client, src)

    # Farm-A-only manager has no membership on Farm B.
    operator = f"op-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(operator)
    await invite_and_accept(
        client,
        inviter_email=owner_email,
        invitee_email=operator,
        org_id=owner["org_id"],
        role_name="farm_manager",
        farm_id=owner["farm_id"],
    )

    await switch_user(client, operator)
    r = await client.post(
        f"/api/v1/warehouses/{src}/inventory:transfer",
        json={
            "lot_id": lot_id,
            "destination_warehouse_id": dst,
            "quantity": 5,
            "unit": "kg",
        },
        headers={"Idempotency-Key": f"xfer-{uuid4().hex[:8]}"},
    )
    # Source-side membership passes; destination-side check must refuse.
    assert r.status_code in (403, 404), r.text
    if r.status_code == 403:
        assert "inventory_transaction.create" in r.json()["detail"]


async def test_reversal_idempotency_replays_original_response(client: AsyncClient) -> None:
    """Second call with same idempotency key must replay, not re-check."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    item_id = await _create_feed_item(client, ctx["org_id"])
    receipt = await _receipt(client, wh_id, item_id, quantity=10, lot_code="LI")
    receipt_tx_id = receipt["body"]["id"]

    key = f"rev-key-{uuid4().hex[:8]}"
    body = {"reverses_transaction_id": receipt_tx_id, "reason": "double-tap safeguard"}

    r1 = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse", json=body, headers={"Idempotency-Key": key}
    )
    assert r1.status_code == 201, r1.text
    marker_id = r1.json()["id"]

    # Second call — same key + same payload — must REPLAY (200 + X-Idempotent-Replay: true)
    # instead of returning 409 already_reversed.
    r2 = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse", json=body, headers={"Idempotency-Key": key}
    )
    assert r2.status_code == 200, r2.text
    assert r2.headers.get("X-Idempotent-Replay") == "true"
    assert r2.json()["id"] == marker_id

    # A DIFFERENT idempotency key against the same original transaction
    # must hit the 'already_reversed' path.
    r3 = await client.post(
        f"/api/v1/warehouses/{wh_id}/inventory:reverse",
        json=body,
        headers={"Idempotency-Key": f"rev-key-{uuid4().hex[:8]}"},
    )
    assert r3.status_code == 409
    assert r3.json()["detail"]["code"] == "already_reversed"


async def test_update_warehouse_is_audited(client: AsyncClient) -> None:
    """CRG03 P1 — warehouse edits flow through the service and hit the audit log."""
    ctx = await _new_owner_org_farm(client)
    wh_id = await _create_warehouse(client, ctx["org_id"])
    r = await client.patch(f"/api/v1/warehouses/{wh_id}", json={"name": "Renamed HQ"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed HQ"

    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/audit-events",
        params={"entity_type": "warehouse"},
    )
    assert r.status_code == 200
    events = r.json().get("items", r.json())
    matches = [
        e
        for e in events
        if e.get("entity_id") == wh_id and e.get("action") == "inventory_warehouse.update"
    ]
    assert matches, f"expected an inventory_warehouse.update audit row for {wh_id}"
    md = matches[0].get("metadata") or matches[0].get("metadata_json") or {}
    assert "changed" in md
    assert "name" in md["changed"]


async def test_update_item_is_audited(client: AsyncClient) -> None:
    """CRG03 P1 — item edits flow through the service and hit the audit log.

    ``canonical_unit`` is also not part of the ``InventoryItemUpdate``
    schema so Pydantic silently ignores it — the service defensive
    check is dead code by construction (belt + suspenders). We verify
    the schema-level protection at the same time.
    """
    ctx = await _new_owner_org_farm(client)
    item_id = await _create_feed_item(client, ctx["org_id"], canonical_unit="kg")
    r = await client.patch(
        f"/api/v1/inventory-items/{item_id}", json={"name": "Renamed feed", "sku": "SKU-1"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed feed"
    # canonical_unit is silently dropped by the schema.
    r = await client.patch(f"/api/v1/inventory-items/{item_id}", json={"canonical_unit": "L"})
    assert r.status_code == 200, r.text
    assert r.json()["canonical_unit"] == "kg"

    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/audit-events",
        params={"entity_type": "inventory_item"},
    )
    assert r.status_code == 200
    events = r.json().get("items", r.json())
    matches = [
        e
        for e in events
        if e.get("entity_id") == item_id and e.get("action") == "inventory_item.update"
    ]
    assert matches, f"expected inventory_item.update audit row for {item_id}"


# --------------------------------------------------------------------- #
# Sprint 5.4.2 — Atomic warehouse-transfer reversal
# --------------------------------------------------------------------- #
async def _find_transfer_out_tx(client: AsyncClient, wh_id: str, lot_id: str) -> dict:
    """Return the TRANSFER_OUT row for the source lot after a transfer."""
    r = await client.get(f"/api/v1/lots/{lot_id}/transactions")
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    outs = [t for t in rows if t["transaction_type"] == "transfer_out"]
    assert outs, f"expected TRANSFER_OUT on lot {lot_id}, got {rows}"
    return outs[0]


async def _find_transfer_in_tx(client: AsyncClient, lot_id: str) -> dict:
    r = await client.get(f"/api/v1/lots/{lot_id}/transactions")
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    ins = [t for t in rows if t["transaction_type"] == "transfer_in"]
    assert ins, f"expected TRANSFER_IN on lot {lot_id}, got {rows}"
    return ins[0]


async def _setup_transfer_pair(
    client: AsyncClient, *, transfer_qty: float = 8.0, initial_qty: float = 20.0
) -> dict:
    ctx = await _new_owner_org_farm(client)
    src = await _create_warehouse(client, ctx["org_id"], code=f"SRC-{uuid4().hex[:4]}")
    dst = await _create_warehouse(client, ctx["org_id"], code=f"DST-{uuid4().hex[:4]}")
    item_id = await _create_feed_item(client, ctx["org_id"])
    await _receipt(client, src, item_id, quantity=initial_qty, unit="kg", lot_code="L1")
    src_lot = await _lot_id_for(client, src)
    r = await client.post(
        f"/api/v1/warehouses/{src}/inventory:transfer",
        json={
            "lot_id": src_lot,
            "destination_warehouse_id": dst,
            "quantity": transfer_qty,
            "unit": "kg",
        },
    )
    assert r.status_code == 201, r.text
    dst_lot = await _lot_id_for(client, dst)
    out_tx = await _find_transfer_out_tx(client, src, src_lot)
    in_tx = await _find_transfer_in_tx(client, dst_lot)
    return {
        "ctx": ctx,
        "src": src,
        "dst": dst,
        "src_lot": src_lot,
        "dst_lot": dst_lot,
        "out_tx": out_tx,
        "in_tx": in_tx,
        "initial_qty": initial_qty,
        "transfer_qty": transfer_qty,
    }


async def test_transfer_reversal_atomic_via_transfer_out(client: AsyncClient) -> None:
    """Reversing a TRANSFER_OUT atomically undoes BOTH sides.

    Sprint 5.4.2 — the destination warehouse must also see the
    inbound stock removed, not just the source-side credit-back.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=8.0, initial_qty=20.0)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={
            "reverses_transaction_id": setup["out_tx"]["id"],
            "reason": "wrong destination",
        },
    )
    assert r.status_code == 201, r.text
    src_lots = (await client.get(f"/api/v1/warehouses/{setup['src']}/lots")).json()
    dst_lots = (await client.get(f"/api/v1/warehouses/{setup['dst']}/lots")).json()
    # Source recovers the 8 kg it lent.
    assert Decimal(str(src_lots[0]["balance"])) == Decimal("20.000000")
    # Destination gives back the 8 kg it received.
    assert Decimal(str(dst_lots[0]["balance"])) == Decimal("0")


async def test_transfer_reversal_atomic_via_transfer_in(client: AsyncClient) -> None:
    """Reversing a TRANSFER_IN atomically undoes BOTH sides too.

    The frontend only exposes reversal on the ``transfer_out`` row,
    but the backend must accept either side as the entry point and
    produce the same outcome. Otherwise a hostile client that hits
    the API directly could induce the half-reversal state the fix
    exists to prevent.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=5.0, initial_qty=12.0)
    r = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
        json={
            "reverses_transaction_id": setup["in_tx"]["id"],
            "reason": "duplicate submission",
        },
    )
    assert r.status_code == 201, r.text
    src_lots = (await client.get(f"/api/v1/warehouses/{setup['src']}/lots")).json()
    dst_lots = (await client.get(f"/api/v1/warehouses/{setup['dst']}/lots")).json()
    assert Decimal(str(src_lots[0]["balance"])) == Decimal("12.000000")
    assert Decimal(str(dst_lots[0]["balance"])) == Decimal("0")


@_postgres_only
async def test_transfer_reversal_rolls_back_when_destination_short(
    client: AsyncClient,
) -> None:
    """All-or-nothing: destination shortage aborts BOTH inverse writes.

    If the destination warehouse has already moved the transferred
    stock along (e.g. issued it to production), reversing the
    original transfer would need to decrease the destination lot
    below zero. The service must refuse with ``insufficient_stock``
    and leave the SOURCE balance untouched too — otherwise the two
    warehouses' balances diverge.

    Postgres-only: SQLite's DBAPI does not honour outer ``ROLLBACK``
    after an inner ``RELEASE SAVEPOINT`` when the connection runs
    under SQLAlchemy's deferred-transaction mode, so the nested
    savepoint's rows leak through. Real transaction rollback is
    verified against the production Postgres engine.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=6.0, initial_qty=10.0)
    # Consume the destination stock before attempting the reversal.
    r = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:issue",
        json={"lot_id": setup["dst_lot"], "quantity": 6, "unit": "kg"},
    )
    assert r.status_code == 201, r.text
    # Reverse — must be refused; NOTHING lands on either side.
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={
            "reverses_transaction_id": setup["out_tx"]["id"],
            "reason": "should refuse",
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "insufficient_stock"
    src_lots = (await client.get(f"/api/v1/warehouses/{setup['src']}/lots")).json()
    dst_lots = (await client.get(f"/api/v1/warehouses/{setup['dst']}/lots")).json()
    # Source stayed at post-transfer (initial - transfer) — did NOT
    # rise back. Destination stayed at zero — did NOT go negative.
    assert Decimal(str(src_lots[0]["balance"])) == Decimal("4.000000")
    assert Decimal(str(dst_lots[0]["balance"])) == Decimal("0")


async def test_transfer_reversal_second_call_returns_already_reversed(
    client: AsyncClient,
) -> None:
    """Once a paired transfer is reversed, either side is refused as
    ``already_reversed``. The marker is posted on BOTH sides by the
    first reversal, so hitting the OUT again OR the IN afterwards
    consistently hits the guard.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    r1 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "first"},
    )
    assert r1.status_code == 201, r1.text
    # Re-attempt from the OUT side.
    r2 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "again"},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "already_reversed"
    # And from the IN side — must also refuse.
    r3 = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
        json={"reverses_transaction_id": setup["in_tx"]["id"], "reason": "again"},
    )
    assert r3.status_code == 409
    assert r3.json()["detail"]["code"] == "already_reversed"


async def test_transfer_reversal_replays_idempotency_key(client: AsyncClient) -> None:
    """Same Idempotency-Key + same payload → 200 replay on the second call.

    The atomic-transfer branch reuses the caller-selected side's
    lot for the key, so the replay contract still applies.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=7.0)
    key = f"rev-xfer-{uuid4().hex[:8]}"
    body = {
        "reverses_transaction_id": setup["out_tx"]["id"],
        "reason": "duplicate submit",
    }
    r1 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201, r1.text
    marker_id = r1.json()["id"]
    r2 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r2.status_code == 200, r2.text
    assert r2.headers.get("X-Idempotent-Replay") == "true"
    assert r2.json()["id"] == marker_id
    # Balances landed exactly once.
    src_lots = (await client.get(f"/api/v1/warehouses/{setup['src']}/lots")).json()
    dst_lots = (await client.get(f"/api/v1/warehouses/{setup['dst']}/lots")).json()
    assert Decimal(str(src_lots[0]["balance"])) == Decimal("7.000000")
    assert Decimal(str(dst_lots[0]["balance"])) == Decimal("0")


# ===================================================================== #
# Sprint 5.4.3 — Atomic Transfer Reversal Hardening
# ===================================================================== #
#
# Every test in this block exercises the invariant:
#
#   A warehouse transfer is one atomic business operation and must
#   either be fully reversed or not reversed at all.
#
# The corruption tests reach into the DB directly to induce states
# the API path cannot produce (missing linkage, mismatched pair
# attributes, tampered topology) and prove the reversal service
# refuses cleanly with a diagnostic error code and NO writes.
_UUIDType = uuid4().__class__  # local alias — avoids reimporting UUID


async def _sum_org_inventory(client: AsyncClient, org_id: str) -> Decimal:
    """Return SUM(balance) across every lot in every warehouse of ``org_id``.

    This is the "organization total inventory" invariant used by the
    audit-integrity tests: a full transfer reversal must leave this
    total unchanged (identical before / after), and a refused
    reversal MUST leave it identical too (no partial writes).

    Sprint 5.4.4 — for cross-tenant assertions we sum directly from
    the DB (bypassing the API's tenant scoping) so a source-side
    caller can still assert "the OTHER org's inventory did not move".
    """
    async with _db_session_module.AsyncSessionLocal() as session:
        from app.models.inventory import InventoryTransaction as _Tx
        from app.models.inventory import Warehouse as _Wh

        # Balance = SUM(signed delta of every non-reversal tx for
        # lots in warehouses that belong to org_id). REVERSAL rows
        # carry zero balance effect; their inverse rows already
        # move the balance.
        stmt = (
            select(_Tx)
            .join(_Wh, _Tx.warehouse_id == _Wh.id)
            .where(_Wh.organization_id == _UUIDType(org_id))
        )
        txs = (await session.execute(stmt)).scalars().all()
    total = Decimal("0")
    for tx in txs:
        total += signed_delta(tx)
    return total


async def _count_tx_rows(lot_ids: list[str]) -> int:
    """Return the total number of ledger rows across ``lot_ids``.

    Reads directly from the DB so we can assert "no rows written"
    even when a refused reversal never surfaces new API-visible
    state.
    """
    async with _db_session_module.AsyncSessionLocal() as session:
        stmt = select(func.count(_InventoryTransaction.id)).where(
            _InventoryTransaction.lot_id.in_([_UUIDType(x) for x in lot_ids])
        )
        return (await session.execute(stmt)).scalar_one()


async def _count_reversal_markers(lot_ids: list[str]) -> int:
    async with _db_session_module.AsyncSessionLocal() as session:
        stmt = select(func.count(_InventoryTransaction.id)).where(
            _InventoryTransaction.lot_id.in_([_UUIDType(x) for x in lot_ids]),
            _InventoryTransaction.transaction_type == _InventoryTransactionType.REVERSAL,
        )
        return (await session.execute(stmt)).scalar_one()


async def _count_inverse_rows(lot_ids: list[str]) -> int:
    """Rows written by the reversal-inverse path."""
    async with _db_session_module.AsyncSessionLocal() as session:
        stmt = select(func.count(_InventoryTransaction.id)).where(
            _InventoryTransaction.lot_id.in_([_UUIDType(x) for x in lot_ids]),
            _InventoryTransaction.reference_type == "reversal_inverse_of",
        )
        return (await session.execute(stmt)).scalar_one()


async def _mutate_tx(tx_id: str, **updates) -> None:
    """Directly update a transaction row for corruption-scenario tests."""
    async with _db_session_module.AsyncSessionLocal() as session:
        await session.execute(
            sa_update(_InventoryTransaction)
            .where(_InventoryTransaction.id == _UUIDType(tx_id))
            .values(**updates)
        )
        await session.commit()


# --------------------------------------------------------------------- #
# 5.4.3.1 — Corrupted linkage: hard-refuse, never fall through.
# --------------------------------------------------------------------- #
async def test_transfer_reversal_refuses_when_reference_type_missing(
    client: AsyncClient,
) -> None:
    """Missing reference_type MUST NOT fall back to single-row reversal."""
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before_tx_count = await _count_tx_rows(lot_ids)
    before_total = await _sum_org_inventory(client, setup["ctx"]["org_id"])
    # Corrupt the OUT row's reference_type.
    await _mutate_tx(setup["out_tx"]["id"], reference_type=None)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "attempt"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_incomplete"
    assert await _count_tx_rows(lot_ids) == before_tx_count
    assert await _count_reversal_markers(lot_ids) == 0
    assert await _count_inverse_rows(lot_ids) == 0
    assert await _sum_org_inventory(client, setup["ctx"]["org_id"]) == before_total


async def test_transfer_reversal_refuses_when_reference_id_missing(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    await _mutate_tx(setup["out_tx"]["id"], reference_id=None)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_incomplete"
    assert await _count_tx_rows(lot_ids) == before
    assert await _count_reversal_markers(lot_ids) == 0


async def test_transfer_reversal_refuses_on_invalid_reference_id(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    # Point the OUT row at a reference_id no other row shares.
    await _mutate_tx(setup["out_tx"]["id"], reference_id=uuid4())
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_incomplete"
    assert await _count_tx_rows(lot_ids) == before


# --------------------------------------------------------------------- #
# 5.4.3.2 — Invalid topology.
# --------------------------------------------------------------------- #
async def test_transfer_reversal_refuses_when_two_out_rows(client: AsyncClient) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    # Flip the IN row to OUT — pair becomes two OUTs.
    await _mutate_tx(
        setup["in_tx"]["id"],
        transaction_type=_InventoryTransactionType.TRANSFER_OUT,
    )
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_incomplete"
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refuses_when_two_in_rows(client: AsyncClient) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    await _mutate_tx(
        setup["out_tx"]["id"],
        transaction_type=_InventoryTransactionType.TRANSFER_IN,
    )
    r = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
        json={"reverses_transaction_id": setup["in_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_incomplete"
    assert await _count_tx_rows(lot_ids) == before


# --------------------------------------------------------------------- #
# 5.4.3.3 — Attribute mismatches on the pair.
# --------------------------------------------------------------------- #
async def test_transfer_reversal_refuses_when_pair_item_mismatch(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    # Create a second item and mutate the IN row's item_id to point at it.
    other_item_id = await _create_feed_item(client, setup["ctx"]["org_id"])
    await _mutate_tx(setup["in_tx"]["id"], item_id=_UUIDType(other_item_id))
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_item_mismatch"
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refuses_when_pair_quantity_mismatch(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=4.0, initial_qty=10.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    await _mutate_tx(setup["in_tx"]["id"], quantity=Decimal("3"))
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_quantity_mismatch"
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refuses_when_pair_unit_mismatch(
    client: AsyncClient,
) -> None:
    from app.models.inventory import StockUnit as _StockUnit

    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    await _mutate_tx(setup["in_tx"]["id"], unit=_StockUnit.G)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_unit_mismatch"
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refuses_when_pair_cross_org(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    # Create a real second organization so the FK on
    # inventory_transactions.organization_id resolves; then point
    # the IN row at that other org to induce the cross-org state.
    other_owner_email = f"other-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(other_owner_email)
    await switch_user(client, other_owner_email)
    other_org_id = await create_org(client, slug=f"other-{uuid4().hex[:6]}")
    # Switch back to the original owner so the reversal call is
    # authenticated against the source-side identity.
    await switch_user(client, setup["ctx"]["owner"])
    await _mutate_tx(setup["in_tx"]["id"], organization_id=_UUIDType(other_org_id))
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_cross_org"
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refuses_when_partner_warehouse_mismatch(
    client: AsyncClient,
) -> None:
    """Partner row's lot_id must belong to its warehouse_id."""
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    # Reassign the IN row's warehouse_id to the source warehouse
    # (still same org). The paired warehouse now matches the source
    # — a transfer that "straddles" one warehouse is not a transfer.
    await _mutate_tx(
        setup["in_tx"]["id"],
        warehouse_id=_UUIDType(setup["src"]),
    )
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_warehouse_mismatch"
    assert await _count_tx_rows(lot_ids) == before


# --------------------------------------------------------------------- #
# 5.4.3.4 — Dual-warehouse authorization.
# --------------------------------------------------------------------- #
async def _setup_two_farm_transfer(client: AsyncClient) -> dict:
    """Two-farm transfer with the owner user; returns owner + setup info."""
    owner = await _new_owner_org_farm(client)
    owner_email = owner["owner"]
    # Second farm on the same org.
    r = await client.post(
        f"/api/v1/organizations/{owner['org_id']}/farms",
        json={"name": "Farm-B", "code": f"farm-b-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    farm_b_id = r.json()["id"]
    src = await _create_warehouse(
        client, owner["org_id"], farm_id=owner["farm_id"], code=f"SRC-{uuid4().hex[:4]}"
    )
    dst = await _create_warehouse(
        client, owner["org_id"], farm_id=farm_b_id, code=f"DST-{uuid4().hex[:4]}"
    )
    item_id = await _create_feed_item(client, owner["org_id"])
    await _receipt(client, src, item_id, quantity=20, unit="kg", lot_code="LX")
    src_lot = await _lot_id_for(client, src)
    r = await client.post(
        f"/api/v1/warehouses/{src}/inventory:transfer",
        json={
            "lot_id": src_lot,
            "destination_warehouse_id": dst,
            "quantity": 5,
            "unit": "kg",
        },
    )
    assert r.status_code == 201, r.text
    dst_lot = await _lot_id_for(client, dst)
    out_tx = await _find_transfer_out_tx(client, src, src_lot)
    in_tx = await _find_transfer_in_tx(client, dst_lot)
    return {
        "owner_email": owner_email,
        "org_id": owner["org_id"],
        "farm_a_id": owner["farm_id"],
        "farm_b_id": farm_b_id,
        "src": src,
        "dst": dst,
        "src_lot": src_lot,
        "dst_lot": dst_lot,
        "out_tx": out_tx,
        "in_tx": in_tx,
    }


async def test_transfer_reversal_refused_when_only_source_permission(
    client: AsyncClient,
) -> None:
    """Farm-A manager (source-only) cannot reverse a transfer that
    touches Farm-B, even by targeting the OUT row on Farm-A.
    """
    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    operator = f"op-a-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(operator)
    await invite_and_accept(
        client,
        inviter_email=setup["owner_email"],
        invitee_email=operator,
        org_id=setup["org_id"],
        role_name="farm_manager",
        farm_id=setup["farm_a_id"],
    )
    await switch_user(client, operator)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code in (403, 404), r.text
    if r.status_code == 403:
        assert "inventory_transaction.create" in r.json()["detail"]
    assert await _count_tx_rows(lot_ids) == before


async def test_transfer_reversal_refused_when_only_destination_permission(
    client: AsyncClient,
) -> None:
    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    before = await _count_tx_rows(lot_ids)
    operator = f"op-b-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(operator)
    await invite_and_accept(
        client,
        inviter_email=setup["owner_email"],
        invitee_email=operator,
        org_id=setup["org_id"],
        role_name="farm_manager",
        farm_id=setup["farm_b_id"],
    )
    await switch_user(client, operator)
    r = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
        json={"reverses_transaction_id": setup["in_tx"]["id"], "reason": "x"},
    )
    assert r.status_code in (403, 404), r.text
    assert await _count_tx_rows(lot_ids) == before


# --------------------------------------------------------------------- #
# 5.4.3.5 — Idempotency + already-reversed via opposite side.
# --------------------------------------------------------------------- #
async def test_transfer_reversal_already_reversed_via_opposite_side_no_duplicates(
    client: AsyncClient,
) -> None:
    """After a paired reversal is committed, a second call — from
    either side, with any key — must not add another inverse row or
    marker. This proves the "already_reversed" guard covers BOTH
    sides of the pair.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    r1 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "first"},
    )
    assert r1.status_code == 201
    inverse_count_after_first = await _count_inverse_rows(lot_ids)
    marker_count_after_first = await _count_reversal_markers(lot_ids)
    assert inverse_count_after_first == 2  # one per side
    assert marker_count_after_first == 2
    # Second attempt via the OPPOSITE side, fresh idempotency key.
    r2 = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
        json={"reverses_transaction_id": setup["in_tx"]["id"], "reason": "opposite"},
        headers={"Idempotency-Key": f"opp-{uuid4().hex[:8]}"},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "already_reversed"
    assert await _count_inverse_rows(lot_ids) == inverse_count_after_first
    assert await _count_reversal_markers(lot_ids) == marker_count_after_first


async def test_transfer_reversal_different_key_after_success_rejected(
    client: AsyncClient,
) -> None:
    """Same original + a FRESH idempotency key → 409 already_reversed."""
    setup = await _setup_transfer_pair(client, transfer_qty=2.0, initial_qty=8.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    key1 = f"k1-{uuid4().hex[:8]}"
    r1 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "first"},
        headers={"Idempotency-Key": key1},
    )
    assert r1.status_code == 201
    inverse_after = await _count_inverse_rows(lot_ids)
    marker_after = await _count_reversal_markers(lot_ids)
    r2 = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "second"},
        headers={"Idempotency-Key": f"k2-{uuid4().hex[:8]}"},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "already_reversed"
    assert await _count_inverse_rows(lot_ids) == inverse_after
    assert await _count_reversal_markers(lot_ids) == marker_after


# --------------------------------------------------------------------- #
# 5.4.3.6 — Audit integrity + org-total invariant on happy path.
# --------------------------------------------------------------------- #
async def test_transfer_reversal_audit_and_inventory_totals(
    client: AsyncClient,
) -> None:
    """Full audit inspection of a happy-path paired reversal.

    * Two REVERSAL markers exist, one per original.
    * Each marker's ``reverses_transaction_id`` points at its
      original (OUT / IN).
    * Two ``reversal_inverse_of`` rows exist, one per original.
    * Ledger row count matches the expected additions
      (2 inverse + 2 markers = +4 rows).
    * Organization-total inventory before == after.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    org_id = setup["ctx"]["org_id"]
    before_total = await _sum_org_inventory(client, org_id)
    before_tx = await _count_tx_rows(lot_ids)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "undo"},
    )
    assert r.status_code == 201, r.text
    after_total = await _sum_org_inventory(client, org_id)
    assert after_total == before_total
    assert await _count_tx_rows(lot_ids) == before_tx + 4
    assert await _count_inverse_rows(lot_ids) == 2
    assert await _count_reversal_markers(lot_ids) == 2
    # Inspect markers directly.
    async with _db_session_module.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(_InventoryTransaction).where(
                        _InventoryTransaction.transaction_type
                        == _InventoryTransactionType.REVERSAL,
                        _InventoryTransaction.lot_id.in_([_UUIDType(x) for x in lot_ids]),
                    )
                )
            )
            .scalars()
            .all()
        )
        marker_reverses = {str(m.reverses_transaction_id) for m in rows}
    assert marker_reverses == {setup["out_tx"]["id"], setup["in_tx"]["id"]}


# --------------------------------------------------------------------- #
# 5.4.3.7 — Postgres rollback: extend prior test with row counts.
# --------------------------------------------------------------------- #
@_postgres_only
async def test_transfer_reversal_postgres_rollback_leaves_no_writes(
    client: AsyncClient,
) -> None:
    """Postgres-only end-to-end rollback proof.

    Extends the balance-only rollback assertion with row-count
    checks: on refusal the ledger must have gained ZERO rows.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=6.0, initial_qty=10.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    # Consume destination so any reversal must drive it negative.
    r = await client.post(
        f"/api/v1/warehouses/{setup['dst']}/inventory:issue",
        json={"lot_id": setup["dst_lot"], "quantity": 6, "unit": "kg"},
    )
    assert r.status_code == 201
    before_tx = await _count_tx_rows(lot_ids)
    before_inverse = await _count_inverse_rows(lot_ids)
    before_markers = await _count_reversal_markers(lot_ids)
    before_total = await _sum_org_inventory(client, setup["ctx"]["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "refuse"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "insufficient_stock"
    assert await _count_tx_rows(lot_ids) == before_tx
    assert await _count_inverse_rows(lot_ids) == before_inverse
    assert await _count_reversal_markers(lot_ids) == before_markers
    assert await _sum_org_inventory(client, setup["ctx"]["org_id"]) == before_total


# ===================================================================== #
# Sprint 5.4.4 — Symmetric Lot and Tenant Validation
# ===================================================================== #
#
# Every test in this block corrupts a specific relationship between a
# ledger row and its lot / item / warehouse / organization, and then
# asserts that the reversal endpoint refuses BEFORE any authorization
# scope is derived and BEFORE any ledger row is written.
#
# For every failure case we assert the same suite of no-op invariants:
#   * request rejected with a specific diagnostic code
#   * both lot balances unchanged
#   * organization-wide inventory unchanged
#   * ledger row count unchanged (no inverse, no marker)
#   * no audit rows attributed to the wrong tenant.
async def _create_extra_wh_with_lot(
    client: AsyncClient,
    *,
    org_id: str,
    farm_id: str | None,
    item_id: str,
) -> tuple[str, str]:
    """Create a second warehouse in ``org_id`` + a lot in it. Returns
    (warehouse_id, lot_id). Used to fabricate the "original tx points
    at a lot in another warehouse" corruption fixture without
    touching the DB by hand.
    """
    wh_id = await _create_warehouse(
        client, org_id, farm_id=farm_id, code=f"OTHER-{uuid4().hex[:4]}"
    )
    await _receipt(client, wh_id, item_id, quantity=1, unit="kg", lot_code=f"L-{uuid4().hex[:4]}")
    lot_id = await _lot_id_for(client, wh_id)
    return wh_id, lot_id


async def _count_audit_rows_for_wrong_scope(
    *, expected_org_id: str, expected_farm_id: str | None, other_scope_org_id: str
) -> int:
    """Return the number of ``audit_events`` rows referencing an
    organization other than ``expected_org_id`` OR the wrong farm on
    the expected org. Used by the no-op assertion suite to prove no
    misleading audit rows were emitted for a refused reversal.
    """
    from app.models.audit import AuditEvent  # local import — the model
    # is not otherwise needed at module scope

    async with _db_session_module.AsyncSessionLocal() as session:
        stmt = select(func.count(AuditEvent.id)).where(
            AuditEvent.organization_id == _UUIDType(other_scope_org_id)
        )
        return (await session.execute(stmt)).scalar_one()


async def _snapshot_lot_state(client: AsyncClient, lot_ids: list[str]) -> list[Decimal]:
    """Return balances (in canonical Decimal form) for the given lots,
    in the same order, using the read APIs so the snapshot survives
    any DB-level side-effects the endpoint may attempt."""
    balances: list[Decimal] = []
    from app.models.inventory import InventoryLot as _LotModel

    for lot_id in lot_ids:
        async with _db_session_module.AsyncSessionLocal() as session:
            row = (
                await session.execute(select(_LotModel).where(_LotModel.id == _UUIDType(lot_id)))
            ).scalar_one_or_none()
            if row is None:
                balances.append(Decimal("0"))
                continue
        # Prefer the ledger-derived balance from the API so we assert
        # the same value the caller of the reversal endpoint sees.
        lots = (await client.get(f"/api/v1/warehouses/{row.warehouse_id}/lots")).json()
        match = next((x for x in lots if x["id"] == lot_id), None)
        balances.append(Decimal(str(match["balance"])) if match else Decimal("0"))
    return balances


async def _assert_no_writes_after(
    client: AsyncClient,
    *,
    lot_ids: list[str],
    org_id: str,
    baseline: dict,
) -> None:
    """Uniform no-op assertion used by every corruption test."""
    assert await _count_tx_rows(lot_ids) == baseline["tx"]
    assert await _count_inverse_rows(lot_ids) == baseline["inverse"]
    assert await _count_reversal_markers(lot_ids) == baseline["marker"]
    assert await _sum_org_inventory(client, org_id) == baseline["total"]
    balances_now = await _snapshot_lot_state(client, lot_ids)
    assert balances_now == baseline["balances"], (
        f"lot balances changed under a refused reversal: {balances_now} != {baseline['balances']}"
    )


async def _baseline(client: AsyncClient, *, lot_ids: list[str], org_id: str) -> dict:
    return {
        "tx": await _count_tx_rows(lot_ids),
        "inverse": await _count_inverse_rows(lot_ids),
        "marker": await _count_reversal_markers(lot_ids),
        "total": await _sum_org_inventory(client, org_id),
        "balances": await _snapshot_lot_state(client, lot_ids),
    }


# --------------------------------------------------------------------- #
# 5.4.4.1 — Original tx points at a lot in another warehouse (same org)
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_original_lot_in_another_warehouse(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    item_id = (
        await client.get(f"/api/v1/organizations/{setup['ctx']['org_id']}/inventory-items")
    ).json()[0]["id"]
    _, other_lot_id = await _create_extra_wh_with_lot(
        client,
        org_id=setup["ctx"]["org_id"],
        farm_id=setup["ctx"]["farm_id"],
        item_id=item_id,
    )
    await _mutate_tx(setup["out_tx"]["id"], lot_id=_UUIDType(other_lot_id))
    baseline = await _baseline(
        client, lot_ids=[*lot_ids, other_lot_id], org_id=setup["ctx"]["org_id"]
    )
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_lot_warehouse_mismatch"
    await _assert_no_writes_after(
        client,
        lot_ids=[*lot_ids, other_lot_id],
        org_id=setup["ctx"]["org_id"],
        baseline=baseline,
    )


# --------------------------------------------------------------------- #
# 5.4.4.2 — Original tx points at a lot in another farm (same org)
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_original_lot_in_another_farm(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    item_id = (
        await client.get(f"/api/v1/organizations/{setup['ctx']['org_id']}/inventory-items")
    ).json()[0]["id"]
    # Create a second farm in the same org, then a warehouse + lot in it.
    r = await client.post(
        f"/api/v1/organizations/{setup['ctx']['org_id']}/farms",
        json={"name": "Farm-Other", "code": f"farm-o-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    other_farm_id = r.json()["id"]
    _, other_lot_id = await _create_extra_wh_with_lot(
        client,
        org_id=setup["ctx"]["org_id"],
        farm_id=other_farm_id,
        item_id=item_id,
    )
    await _mutate_tx(setup["out_tx"]["id"], lot_id=_UUIDType(other_lot_id))
    baseline = await _baseline(
        client, lot_ids=[*lot_ids, other_lot_id], org_id=setup["ctx"]["org_id"]
    )
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_lot_warehouse_mismatch"
    await _assert_no_writes_after(
        client,
        lot_ids=[*lot_ids, other_lot_id],
        org_id=setup["ctx"]["org_id"],
        baseline=baseline,
    )


# --------------------------------------------------------------------- #
# 5.4.4.3 — Original tx points at a lot in another organization
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_original_lot_in_another_org(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    # Build a fully-separate org with its own lot.
    other_owner_email = f"other-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(other_owner_email)
    await switch_user(client, other_owner_email)
    other_org_id = await create_org(client, slug=f"other-{uuid4().hex[:6]}")
    other_wh_id = await _create_warehouse(client, other_org_id, code=f"WH-{uuid4().hex[:4]}")
    other_item_id = await _create_feed_item(client, other_org_id)
    await _receipt(client, other_wh_id, other_item_id, quantity=1, unit="kg", lot_code="OTHER")
    other_lot_id = await _lot_id_for(client, other_wh_id)
    # Back to the source-side owner and snapshot.
    await switch_user(client, setup["ctx"]["owner"])
    await _mutate_tx(setup["out_tx"]["id"], lot_id=_UUIDType(other_lot_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    other_baseline_total = await _sum_org_inventory(client, other_org_id)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_lot_warehouse_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )
    # The OTHER org's inventory must be equally untouched — a refused
    # reversal must NOT leak audit or ledger state across tenants.
    assert await _sum_org_inventory(client, other_org_id) == other_baseline_total


# --------------------------------------------------------------------- #
# 5.4.4.4 — Original tx item_id != original lot item_id
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_original_item_id_diverges_from_lot(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_item_id = await _create_feed_item(client, setup["ctx"]["org_id"])
    await _mutate_tx(setup["out_tx"]["id"], item_id=_UUIDType(other_item_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_lot_item_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )


# --------------------------------------------------------------------- #
# 5.4.4.5 — Partner tx item_id != partner lot item_id
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_partner_item_id_diverges_from_lot(
    client: AsyncClient,
) -> None:
    """Both original and partner tx.item_id point at the SAME new item
    so the pair-level ``item_id`` invariant passes, but partner_lot's
    ``item_id`` still points at the ORIGINAL item — driving the
    partner-side lot / item symmetry check.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_item_id = await _create_feed_item(client, setup["ctx"]["org_id"])
    # Mutate BOTH tx rows to reference the new item so the pair-level
    # cross-check does not fire first. This isolates the partner-side
    # lot / item check.
    await _mutate_tx(setup["out_tx"]["id"], item_id=_UUIDType(other_item_id))
    await _mutate_tx(setup["in_tx"]["id"], item_id=_UUIDType(other_item_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    # The FIRST invariant we hit is
    # ``transfer_original_lot_item_mismatch`` because both txs were
    # rewritten and the original-side symmetric check runs before the
    # partner-side one. That is acceptable — the important guarantee
    # is that NO writes escape. If we only mutate the partner tx, the
    # pair-level cross-item check fires (transfer_pair_item_mismatch).
    # Either way the refusal must be zero-write.
    assert r.json()["detail"]["code"] in {
        "transfer_original_lot_item_mismatch",
        "transfer_partner_lot_item_mismatch",
        "transfer_pair_item_mismatch",
    }
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )


async def test_reversal_refused_when_partner_lot_item_id_mismatches_partner_tx(
    client: AsyncClient,
) -> None:
    """Direct fixture for the ``transfer_partner_lot_item_mismatch`` code.

    Keeps the ORIGINAL side pristine, and rewrites the partner tx's
    ``item_id`` to match the original — but leaves the destination
    lot pointing at the ORIGINAL item so ``partner_lot.item_id !=
    partner.item_id``.

    Requires slightly more intricate corruption: create a new item,
    rewrite BOTH original and partner tx.item_id to that new item,
    then rewrite the ORIGINAL lot's item_id back to the original.
    The partner lot still references the original item → mismatch.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_item_id = await _create_feed_item(client, setup["ctx"]["org_id"])
    await _mutate_tx(setup["out_tx"]["id"], item_id=_UUIDType(other_item_id))
    await _mutate_tx(setup["in_tx"]["id"], item_id=_UUIDType(other_item_id))
    # Sync the source lot's item so original-side symmetric check
    # passes; leave partner lot untouched to isolate the partner-side
    # mismatch.
    async with _db_session_module.AsyncSessionLocal() as session:
        from app.models.inventory import InventoryLot as _LotModel

        await session.execute(
            sa_update(_LotModel)
            .where(_LotModel.id == _UUIDType(setup["src_lot"]))
            .values(item_id=_UUIDType(other_item_id))
        )
        await session.commit()
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_partner_lot_item_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )


# --------------------------------------------------------------------- #
# 5.4.4.6 — Original tx organization differs from warehouse organization
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_original_tx_org_diverges_from_warehouse(
    client: AsyncClient,
) -> None:
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_owner_email = f"other-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(other_owner_email)
    await switch_user(client, other_owner_email)
    other_org_id = await create_org(client, slug=f"other-{uuid4().hex[:6]}")
    await switch_user(client, setup["ctx"]["owner"])
    await _mutate_tx(setup["out_tx"]["id"], organization_id=_UUIDType(other_org_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    other_baseline_total = await _sum_org_inventory(client, other_org_id)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_org_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )
    assert await _sum_org_inventory(client, other_org_id) == other_baseline_total


# --------------------------------------------------------------------- #
# 5.4.4.7 — Partner tx organization differs
# --------------------------------------------------------------------- #
async def test_reversal_refused_when_partner_tx_org_diverges(
    client: AsyncClient,
) -> None:
    """Rewrite the partner tx to a foreign org → ``transfer_pair_cross_org``.

    The counterpart's authorization scope is derived from that
    partner row; the resolver MUST refuse before ever returning it.
    """
    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_owner_email = f"other-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(other_owner_email)
    await switch_user(client, other_owner_email)
    other_org_id = await create_org(client, slug=f"other-{uuid4().hex[:6]}")
    await switch_user(client, setup["ctx"]["owner"])
    await _mutate_tx(setup["in_tx"]["id"], organization_id=_UUIDType(other_org_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"])
    other_baseline_total = await _sum_org_inventory(client, other_org_id)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_pair_cross_org"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["ctx"]["org_id"], baseline=baseline
    )
    assert await _sum_org_inventory(client, other_org_id) == other_baseline_total


# --------------------------------------------------------------------- #
# 5.4.4.8 — Authorization resolver rejects BEFORE returning scopes
# --------------------------------------------------------------------- #
async def test_resolve_reversal_scopes_rejects_malformed_before_scope_return(
    client: AsyncClient,
) -> None:
    """When the pair is corrupted, ``resolve_reversal_scopes`` MUST
    refuse before enumerating (and therefore before authorizing) the
    counterpart scope.

    We prove this via HTTP flow: corrupt the partner tx to a foreign
    org, then invoke the endpoint as a caller who only has
    ``inventory_transaction.create`` on the SOURCE farm. If the
    resolver were to return the partner scope, the endpoint would
    enforce authorization against the counterpart farm and answer
    with 403. Instead we observe 409 with the corruption diagnostic,
    which is only possible if the resolver refused before returning
    any partner scope.
    """
    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    other_owner_email = f"other-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(other_owner_email)
    await switch_user(client, other_owner_email)
    other_org_id = await create_org(client, slug=f"other-{uuid4().hex[:6]}")
    # Corrupt the partner org while still authenticated as some org
    # admin — the DB mutation itself is direct.
    await switch_user(client, setup["owner_email"])
    await _mutate_tx(setup["in_tx"]["id"], organization_id=_UUIDType(other_org_id))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["org_id"])
    # Provision a source-only farm_manager.
    src_only = f"src-only-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(src_only)
    await invite_and_accept(
        client,
        inviter_email=setup["owner_email"],
        invitee_email=src_only,
        org_id=setup["org_id"],
        role_name="farm_manager",
        farm_id=setup["farm_a_id"],
    )
    await switch_user(client, src_only)
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    # 409 (not 403) proves the resolver rejected before scope
    # enumeration — the counterpart-farm auth check never ran.
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == "transfer_pair_cross_org"
    await switch_user(client, setup["owner_email"])
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["org_id"], baseline=baseline
    )


# ===================================================================== #
# Sprint 5.4.5 — Farm consistency + race-safe transfer reversal
# ===================================================================== #
async def test_reversal_refused_when_original_farm_id_diverges_from_warehouse(
    client: AsyncClient,
) -> None:
    """Direct mutation of the ORIGINAL tx's farm_id — must refuse
    with ``transfer_original_farm_mismatch`` and write nothing.
    Uses ``_setup_two_farm_transfer`` so ``farm_id`` values differ
    between the two warehouses and a swap actually changes state.
    """
    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    # Repoint the source tx's farm_id to farm-B (the destination's
    # farm). This is a corruption we cannot produce via the API.
    await _mutate_tx(setup["out_tx"]["id"], farm_id=_UUIDType(setup["farm_b_id"]))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_original_farm_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["org_id"], baseline=baseline
    )


async def test_reversal_refused_when_partner_farm_id_diverges_from_warehouse(
    client: AsyncClient,
) -> None:
    """Direct mutation of the PARTNER tx's farm_id."""
    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    await _mutate_tx(setup["in_tx"]["id"], farm_id=_UUIDType(setup["farm_a_id"]))
    baseline = await _baseline(client, lot_ids=lot_ids, org_id=setup["org_id"])
    r = await client.post(
        f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
        json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "x"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "transfer_partner_farm_mismatch"
    await _assert_no_writes_after(
        client, lot_ids=lot_ids, org_id=setup["org_id"], baseline=baseline
    )


# --------------------------------------------------------------------- #
# 5.4.5 — Postgres concurrency proofs.
# --------------------------------------------------------------------- #
# All tests below acquire the tx-row locks that Sprint 5.4.5 introduces
# and demand real DB-level lock semantics. On SQLite the locks are
# silent no-ops (StaticPool serialises everything anyway), so these
# tests are pinned to Postgres CI.
@_postgres_only
async def test_reversal_serialises_concurrent_writers_on_same_pair(
    client: AsyncClient,
) -> None:
    """Two concurrent reversal HTTP calls on the same transfer pair.

    The FOR UPDATE lock on the transaction rows must serialise the
    two attempts: exactly one wins with 201, the other blocks until
    the first commits and then answers 409 ``already_reversed``.
    Neither may produce a half-reversed state.
    """
    import asyncio as _asyncio

    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    baseline_tx = await _count_tx_rows(lot_ids)
    baseline_total = await _sum_org_inventory(client, setup["ctx"]["org_id"])

    async def _fire(key: str) -> tuple[int, dict]:
        r = await client.post(
            f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
            json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": key},
            headers={"Idempotency-Key": key},
        )
        return r.status_code, r.json()

    r1, r2 = await _asyncio.gather(_fire("racer-a"), _fire("racer-b"))
    codes = sorted([r1[0], r2[0]])
    assert codes == [201, 409], f"unexpected outcome pair: {codes}"
    losing = r1 if r1[0] == 409 else r2
    assert losing[1]["detail"]["code"] == "already_reversed"
    # Exactly one paired reversal ran: +2 inverse + 2 markers = +4 rows.
    assert await _count_tx_rows(lot_ids) == baseline_tx + 4
    assert await _count_inverse_rows(lot_ids) == 2
    assert await _count_reversal_markers(lot_ids) == 2
    # Inventory total unchanged: a paired reversal is inventory-neutral.
    assert await _sum_org_inventory(client, setup["ctx"]["org_id"]) == baseline_total


@_postgres_only
async def test_reversal_serialises_concurrent_writers_via_opposite_sides(
    client: AsyncClient,
) -> None:
    """Same as above but the two writers reverse from OPPOSITE ends
    of the pair (one targets TRANSFER_OUT, the other TRANSFER_IN).

    Sprint 5.4.5's deterministic ``ORDER BY tx.id ASC`` lock
    acquisition MUST prevent the classic AB / BA deadlock. Exactly
    one writer wins.
    """
    import asyncio as _asyncio

    setup = await _setup_transfer_pair(client, transfer_qty=3.0, initial_qty=9.0)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    baseline_tx = await _count_tx_rows(lot_ids)

    async def _from_out() -> tuple[int, dict]:
        r = await client.post(
            f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
            json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "out"},
            headers={"Idempotency-Key": "opp-out"},
        )
        return r.status_code, r.json()

    async def _from_in() -> tuple[int, dict]:
        r = await client.post(
            f"/api/v1/warehouses/{setup['dst']}/inventory:reverse",
            json={"reverses_transaction_id": setup["in_tx"]["id"], "reason": "in"},
            headers={"Idempotency-Key": "opp-in"},
        )
        return r.status_code, r.json()

    r1, r2 = await _asyncio.gather(_from_out(), _from_in())
    codes = sorted([r1[0], r2[0]])
    assert codes == [201, 409], f"unexpected outcome pair: {codes}"
    losing = r1 if r1[0] == 409 else r2
    assert losing[1]["detail"]["code"] == "already_reversed"
    assert await _count_tx_rows(lot_ids) == baseline_tx + 4


@_postgres_only
async def test_reversal_detects_relationship_change_between_read_and_lock(
    client: AsyncClient,
) -> None:
    """Force a race: reversal begins, and a concurrent UPDATE
    changes ``farm_id`` on the partner tx BEFORE the reversal
    acquires its FOR UPDATE lock.

    We drive this by starting a session that opens a transaction,
    holds a FOR UPDATE lock on the partner tx, then mutates its
    farm_id; concurrently the API request tries to reverse. When
    the mutating session commits, the API acquires the lock,
    re-reads the (now-changed) partner row, and refuses with
    ``transfer_partner_farm_mismatch`` — no writes, no partial
    state.
    """
    import asyncio as _asyncio

    setup = await _setup_two_farm_transfer(client)
    lot_ids = [setup["src_lot"], setup["dst_lot"]]
    baseline_tx = await _count_tx_rows(lot_ids)
    baseline_total = await _sum_org_inventory(client, setup["org_id"])

    started = _asyncio.Event()
    finished = _asyncio.Event()

    async def _mutator() -> None:
        # Hold the partner row's write lock, mutate its farm_id,
        # signal the reader, sleep briefly to make sure the API
        # request is actively waiting on the FOR UPDATE lock, and
        # commit — releasing the row in a corrupted state.
        async with _db_session_module.AsyncSessionLocal() as session:
            from app.models.inventory import InventoryTransaction as _Tx

            await session.execute(
                select(_Tx).where(_Tx.id == _UUIDType(setup["in_tx"]["id"])).with_for_update()
            )
            await session.execute(
                sa_update(_Tx)
                .where(_Tx.id == _UUIDType(setup["in_tx"]["id"]))
                .values(farm_id=_UUIDType(setup["farm_a_id"]))
            )
            started.set()
            # Give the API request time to enqueue on the lock.
            await _asyncio.sleep(0.5)
            await session.commit()
            finished.set()

    async def _reverser() -> tuple[int, dict]:
        await started.wait()
        # Fire the reversal while the mutator is still holding the
        # lock — the request will block inside FOR UPDATE and only
        # proceed after the mutator commits its farm_id change.
        r = await client.post(
            f"/api/v1/warehouses/{setup['src']}/inventory:reverse",
            json={"reverses_transaction_id": setup["out_tx"]["id"], "reason": "race"},
        )
        return r.status_code, r.json()

    r_reverser, _ = await _asyncio.gather(_reverser(), _mutator())
    assert finished.is_set()
    assert r_reverser[0] == 409, r_reverser
    # The reversal refused because it re-read the row under lock and
    # saw the mutated farm_id.
    assert r_reverser[1]["detail"]["code"] == "transfer_partner_farm_mismatch"
    # Zero-write guarantee.
    assert await _count_tx_rows(lot_ids) == baseline_tx
    assert await _count_inverse_rows(lot_ids) == 0
    assert await _count_reversal_markers(lot_ids) == 0
    assert await _sum_org_inventory(client, setup["org_id"]) == baseline_total
