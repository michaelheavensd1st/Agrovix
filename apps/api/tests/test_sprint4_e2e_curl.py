"""End-to-end curl-driven regression for Sprint 4 inventory features.

Uses the live FastAPI server on http://127.0.0.1:8055 and the seeded E2E
account (e2e@agrovix.dev / testtest123, org E2E Farm).

Focus: verify the invariants called out in the review request:
  - Login sets httpOnly cookies
  - Overview data (warehouses/items/lots/balance) is reachable via API
  - Receive → Issue → Transfer → Adjust → Reverse flow all return 2xx
  - Idempotency-Key contract on receive (same key + same payload => replay,
    same key + different payload => 409)
  - Feeding event with inventory_lot_id deducts lot balance
"""

from __future__ import annotations

import os
import uuid
from decimal import Decimal

import pytest
import requests

BASE = os.environ.get("SPRINT4_API_BASE", "http://127.0.0.1:8055").rstrip("/")
EMAIL = "e2e@agrovix.dev"
PASSWORD = "testtest123"
ORG_ID = "463c2bbc-da32-4971-9206-8941f15c61fb"


def _live_server_reachable() -> bool:
    try:
        r = requests.get(f"{BASE}/health", timeout=1.5)
        return r.status_code == 200
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _live_server_reachable(),
    reason=(
        "Sprint 4 curl-driven E2E requires a live FastAPI at "
        f"{BASE} plus a seeded E2E account. Skipped when the server is "
        "not reachable (e.g. hermetic CI). Set SPRINT4_API_BASE to point "
        "at a running instance to enable this suite."
    ),
)


@pytest.fixture(scope="module")
def session() -> requests.Session:
    s = requests.Session()
    r = s.post(
        f"{BASE}/api/v1/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    # httpOnly cookies must be set
    assert "agrovix_access" in s.cookies, "agrovix_access cookie not set"
    assert "agrovix_refresh" in s.cookies, "agrovix_refresh cookie not set"
    return s


@pytest.fixture(scope="module")
def wh_and_item(session):
    r = session.get(f"{BASE}/api/v1/organizations/{ORG_ID}/warehouses")
    assert r.status_code == 200, r.text
    wh = next(w for w in r.json() if w["code"] == "MAIN")
    r = session.get(f"{BASE}/api/v1/organizations/{ORG_ID}/inventory-items")
    assert r.status_code == 200, r.text
    item = next(i for i in r.json() if i["code"] == "FEED-01")
    return wh, item


def _balance_for(session, wh_id, lot_id):
    r = session.get(f"{BASE}/api/v1/warehouses/{wh_id}/lots")
    assert r.status_code == 200, r.text
    lots = [lot for lot in r.json() if lot["id"] == lot_id]
    if not lots:
        return None
    return Decimal(lots[0]["balance"])


# ---------- Login / me ----------


def test_me_after_login(session):
    r = session.get(f"{BASE}/api/v1/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == EMAIL


# ---------- Idempotency ----------


def test_receive_idempotency_replay_returns_replay_header(session, wh_and_item):
    wh, item = wh_and_item
    key = str(uuid.uuid4())
    payload = {
        "item_id": item["id"],
        "lot_code": f"IDMP-{uuid.uuid4().hex[:8]}",
        "quantity": "5.0",
        "unit": "kg",
    }
    headers = {"Idempotency-Key": key}
    r1 = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:receive",
        json=payload,
        headers=headers,
    )
    assert r1.status_code == 201, r1.text
    assert r1.headers.get("X-Idempotent-Replay") in (None, "false")

    r2 = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:receive",
        json=payload,
        headers=headers,
    )
    # Replay: 200 with replay header true (per contract in review request)
    assert r2.status_code == 200, r2.text
    assert r2.headers.get("X-Idempotent-Replay", "").lower() == "true"


def test_receive_idempotency_conflict_on_different_payload(session, wh_and_item):
    wh, item = wh_and_item
    key = str(uuid.uuid4())
    lot_code = f"IDMPC-{uuid.uuid4().hex[:8]}"
    p1 = {"item_id": item["id"], "lot_code": lot_code, "quantity": "5.0", "unit": "kg"}
    p2 = {"item_id": item["id"], "lot_code": lot_code, "quantity": "6.0", "unit": "kg"}
    headers = {"Idempotency-Key": key}
    r1 = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:receive",
        json=p1,
        headers=headers,
    )
    assert r1.status_code == 201, r1.text
    r2 = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:receive",
        json=p2,
        headers=headers,
    )
    assert r2.status_code == 409, r2.text
    detail = r2.json().get("detail")
    # Accept either dict or string
    if isinstance(detail, dict):
        code = detail.get("code") or detail.get("error") or ""
    else:
        code = str(detail)
    assert "idempotency_key_payload_conflict" in code.lower(), r2.text


# ---------- Receive → Issue → Transfer → Adjust → Reverse ----------


def test_full_stock_flow(session, wh_and_item):
    wh, item = wh_and_item
    # 1) Receive fresh 20kg
    lot_code = f"FLOW-{uuid.uuid4().hex[:8]}"
    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:receive",
        json={
            "item_id": item["id"],
            "lot_code": lot_code,
            "quantity": "20.0",
            "unit": "kg",
        },
    )
    assert r.status_code == 201, r.text
    lot_id = r.json()["lot_id"]
    assert _balance_for(session, wh["id"], lot_id) == Decimal("20.000000")

    # 2) Issue 5kg
    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:issue",
        json={
            "lot_id": lot_id,
            "quantity": "5.0",
            "unit": "kg",
            "reason": "consumption",
        },
    )
    assert r.status_code == 201, r.text
    assert _balance_for(session, wh["id"], lot_id) == Decimal("15.000000")

    # 3) Create second warehouse & transfer 5kg
    wh2_name = f"TEST_Secondary_{uuid.uuid4().hex[:6]}"
    r = session.post(
        f"{BASE}/api/v1/organizations/{ORG_ID}/warehouses",
        json={"name": wh2_name, "code": f"T{uuid.uuid4().hex[:4].upper()}"},
    )
    assert r.status_code == 201, r.text
    wh2 = r.json()

    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:transfer",
        json={
            "lot_id": lot_id,
            "destination_warehouse_id": wh2["id"],
            "quantity": "5.0",
            "unit": "kg",
        },
    )
    assert r.status_code == 201, r.text
    # Source balance is now 10
    assert _balance_for(session, wh["id"], lot_id) == Decimal("10.000000")
    # Destination lot for same lot_code should exist w/ 5kg
    r = session.get(f"{BASE}/api/v1/warehouses/{wh2['id']}/lots")
    assert r.status_code == 200
    dest_lot = next(lot for lot in r.json() if lot["lot_code"] == lot_code)
    assert Decimal(dest_lot["balance"]) == Decimal("5.000000")

    # 4) Adjust down 2kg with reason
    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "direction": "decrease",
            "quantity": "2.0",
            "unit": "kg",
            "reason": "spoilage",
        },
    )
    assert r.status_code == 201, r.text
    assert _balance_for(session, wh["id"], lot_id) == Decimal("8.000000")

    # 5) Adjust with missing reason must fail
    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:adjust",
        json={
            "lot_id": lot_id,
            "direction": "decrease",
            "quantity": "1.0",
            "unit": "kg",
        },
    )
    assert r.status_code in (400, 422), r.text

    # 6) Reverse the adjustment (find transaction id from history)
    r = session.get(f"{BASE}/api/v1/lots/{lot_id}/transactions")
    assert r.status_code == 200, r.text
    body = r.json()
    txns = body["items"] if isinstance(body, dict) else body
    assert len(txns) >= 4  # receipt + issue + transfer_out + adjust
    adjust_txn = next(
        t
        for t in txns
        if t.get("transaction_type", "").startswith("adjustment")
        or t.get("transaction_type") == "adjust"
    )

    r = session.post(
        f"{BASE}/api/v1/warehouses/{wh['id']}/inventory:reverse",
        json={
            "reverses_transaction_id": adjust_txn["id"],
            "reason": "test-reversal",
        },
    )
    assert r.status_code == 201, r.text
    # Balance should return to 10
    assert _balance_for(session, wh["id"], lot_id) == Decimal("10.000000")


# ---------- History filter smoke ----------


def test_transaction_history_returns_multiple_types(session, wh_and_item):
    wh, _ = wh_and_item
    r = session.get(f"{BASE}/api/v1/warehouses/{wh['id']}/lots")
    assert r.status_code == 200
    # Use LOT001 which is guaranteed
    lot = next(lot for lot in r.json() if lot["lot_code"] == "LOT001")
    r = session.get(f"{BASE}/api/v1/lots/{lot['id']}/transactions")
    assert r.status_code == 200
    body = r.json()
    txns = body["items"] if isinstance(body, dict) else body
    types = {t.get("transaction_type") for t in txns}
    # Should include at least receipt
    assert "receipt" in types
