"""Sprint 4 CRG03 iteration-8 verification-only live pass.

Exercises the full CLOSED-PATCH matrix against the live FastAPI on
http://127.0.0.1:8055/api using cookie auth (matches the frontend flow).

Warehouse under test = 'Main Store' (MAIN) on org 'E2E Farm'.
"""

from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("CRG03_LIVE_URL", "http://127.0.0.1:8055/api")
EMAIL = "e2e@agrovix.dev"
PASSWORD = "testtest123"
ORG_ID = "4e43a952-2f13-4d5a-a99f-5b34c51b228a"


@pytest.fixture(scope="module")
def sess() -> requests.Session:
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/v1/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    return s


@pytest.fixture()
def closed_wh(sess: requests.Session) -> str:
    """Create a fresh warehouse and close it. Returns wh_id."""
    code = f"CRG8-{uuid.uuid4().hex[:6].upper()}"
    r = sess.post(
        f"{BASE_URL}/v1/organizations/{ORG_ID}/warehouses",
        json={"name": f"CRG8 {code}", "code": code},
        timeout=10,
    )
    assert r.status_code == 201, r.text
    wh_id = r.json()["id"]
    r = sess.patch(f"{BASE_URL}/v1/warehouses/{wh_id}", json={"status": "closed"}, timeout=10)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed"
    return wh_id


# ---------------------------------------------------------------- happy paths
def test_closed_status_only_active_reopens(sess, closed_wh):
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "active"},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"


def test_closed_status_only_maintenance_reopens(sess, closed_wh):
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "maintenance"},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "maintenance"


# ---------------------------------------------------------------- refusals
def test_closed_name_only_refused(sess, closed_wh):
    r = sess.patch(f"{BASE_URL}/v1/warehouses/{closed_wh}", json={"name": "x"}, timeout=10)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "warehouse_closed_no_writes"
    assert detail["submitted_fields"] == ["name"]
    assert detail["warehouse_id"] == closed_wh
    # unchanged
    g = sess.get(f"{BASE_URL}/v1/warehouses/{closed_wh}", timeout=10).json()
    assert g["status"] == "closed"
    assert g["name"] != "x"


def test_closed_status_plus_name_refused(sess, closed_wh):
    original = sess.get(f"{BASE_URL}/v1/warehouses/{closed_wh}", timeout=10).json()
    original_name = original["name"]
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "active", "name": "x"},
        timeout=10,
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "warehouse_closed_no_writes"
    assert set(detail["submitted_fields"]) == {"status", "name"}
    # no partial application
    g = sess.get(f"{BASE_URL}/v1/warehouses/{closed_wh}", timeout=10).json()
    assert g["status"] == "closed"
    assert g["name"] == original_name


def test_closed_status_plus_address_refused(sess, closed_wh):
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "active", "address": "12 New Rd"},
        timeout=10,
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "warehouse_closed_no_writes"
    assert set(detail["submitted_fields"]) == {"status", "address"}
    g = sess.get(f"{BASE_URL}/v1/warehouses/{closed_wh}", timeout=10).json()
    assert g["status"] == "closed"
    assert g["address"] is None


def test_closed_status_plus_description_refused(sess, closed_wh):
    """Additional shape — status + description also blocked."""
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "active", "description": "reopening notes"},
        timeout=10,
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "warehouse_closed_no_writes"
    assert "status" in detail["submitted_fields"]
    assert "description" in detail["submitted_fields"]
    g = sess.get(f"{BASE_URL}/v1/warehouses/{closed_wh}", timeout=10).json()
    assert g["status"] == "closed"


# ---------------------------------------------------------------- two-step
def test_reopen_then_edit_is_two_step_flow(sess, closed_wh):
    # Step 1 — status-only reopen
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"status": "active"},
        timeout=10,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "active"
    # Step 2 — rename in a separate PATCH
    r = sess.patch(
        f"{BASE_URL}/v1/warehouses/{closed_wh}",
        json={"name": "HQ (reopened)"},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "HQ (reopened)"
    assert r.json()["status"] == "active"


# ---------------------------------------------------------------- MAIN warehouse
MAIN_WH_ID = "03aca305-e38e-4da1-86f1-4dfe5214eb86"


def test_main_warehouse_full_matrix(sess):
    """Run the exact matrix on the fixture 'Main Store' warehouse and
    leave it back at ACTIVE."""
    # baseline snapshot
    original = sess.get(f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}", timeout=10).json()
    original_name = original["name"]
    original_address = original.get("address")
    try:
        # Close it
        r = sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"status": "closed"},
            timeout=10,
        )
        assert r.status_code == 200, r.text

        # 1) name-only → 409
        r = sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"name": "x"},
            timeout=10,
        )
        assert r.status_code == 409
        assert r.json()["detail"]["submitted_fields"] == ["name"]

        # 2) status+name → 409
        r = sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"status": "active", "name": "x"},
            timeout=10,
        )
        assert r.status_code == 409
        assert set(r.json()["detail"]["submitted_fields"]) == {"status", "name"}

        # 3) status+address → 409
        r = sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"status": "active", "address": "12 New Rd"},
            timeout=10,
        )
        assert r.status_code == 409

        # Confirm no drift after all refusals
        g = sess.get(f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}", timeout=10).json()
        assert g["status"] == "closed"
        assert g["name"] == original_name
        assert g.get("address") == original_address

        # 4) status-only reopen → 200
        r = sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"status": "active"},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["status"] == "active"
    finally:
        # Always restore to ACTIVE
        sess.patch(
            f"{BASE_URL}/v1/warehouses/{MAIN_WH_ID}",
            json={"status": "active"},
            timeout=10,
        )
