"""Curl-driven (real HTTP) end-to-end verification of CRG01-1 & CRG01-2.

This file talks to a **live** FastAPI process backed by real Postgres
(http://localhost:8002 by default — override with BASE_URL env). It
does NOT use the pytest asgi client fixture. Run alongside the
canonical suite to independently validate the two invariants.

Invariants under test:
  CRG01-1: cross-tenant custom production-unit-type isolation.
  CRG01-2: production-event idempotency (per-batch, payload-aware).
"""

from __future__ import annotations

import asyncio
import os
from uuid import uuid4

import httpx
import pytest
import requests

BASE_URL = os.environ.get("CRG_BASE_URL", "http://localhost:8002").rstrip("/")
API = f"{BASE_URL}/api/v1"
PW = "Sprint0ne!2026"


# --------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------- #
def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _register(email: str) -> None:
    r = requests.post(
        f"{API}/auth/register",
        json={"email": email, "password": PW, "full_name": "Test User"},
        timeout=10,
    )
    assert r.status_code == 201, r.text


def _login(session: requests.Session, email: str) -> None:
    r = session.post(f"{API}/auth/login", json={"email": email, "password": PW}, timeout=10)
    assert r.status_code == 200, r.text


def _new_owner_org_farm(session: requests.Session) -> dict:
    email = f"crg-{uuid4().hex[:10]}@agrovix.dev"
    _register(email)
    _login(session, email)
    slug = f"org-{uuid4().hex[:8]}"
    r = session.post(f"{API}/organizations", json={"name": "T Co", "slug": slug})
    assert r.status_code == 201, r.text
    org_id = r.json()["id"]
    r = session.post(
        f"{API}/organizations/{org_id}/farms",
        json={"name": "Farm A", "code": f"F-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    farm_id = r.json()["id"]
    r = session.get(f"{API}/farms/{farm_id}/sites")
    assert r.status_code == 200, r.text
    sites = r.json()
    assert len(sites) == 1
    return {"email": email, "org_id": org_id, "farm_id": farm_id, "site_id": sites[0]["id"]}


def _pick_system_unit_type_id(session: requests.Session, org_id: str) -> str:
    r = session.get(f"{API}/production-unit-types", params={"organization_id": org_id})
    assert r.status_code == 200
    types = r.json()
    system = [t for t in types if t["is_system"]]
    assert system, "System unit types must be seeded"
    return system[0]["id"]


def _create_unit(session: requests.Session, site_id: str, unit_type_id: str) -> str:
    r = session.post(
        f"{API}/sites/{site_id}/units",
        json={
            "unit_type_id": unit_type_id,
            "name": "Tank A",
            "code": f"T-{uuid4().hex[:6]}",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _create_batch(session: requests.Session, unit_id: str) -> str:
    r = session.post(
        f"{API}/units/{unit_id}/batches",
        json={
            "code": f"B-{uuid4().hex[:6]}",
            "species": "L. vannamei",
            "expected_quantity": 10000,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _prepare_active_batch(session: requests.Session) -> str:
    ctx = _new_owner_org_farm(session)
    ut = _pick_system_unit_type_id(session, ctx["org_id"])
    unit_id = _create_unit(session, ctx["site_id"], ut)
    batch_id = _create_batch(session, unit_id)
    r = session.post(
        f"{API}/batches/{batch_id}/events",
        json={"event_type": "STOCKING", "data": {"quantity": 1}},
    )
    assert r.status_code == 201, r.text
    r = session.post(
        f"{API}/batches/{batch_id}/transitions",
        json={"target_state": "active"},
    )
    assert r.status_code in (200, 201), r.text
    return batch_id


# ===================================================================== #
# CRG01-1 — cross-tenant unit-type isolation
# ===================================================================== #
def test_crg1_cross_tenant_custom_unit_type_is_never_returned():
    # Bob (Org B) creates a CUSTOM unit type.
    bob = _new_session()
    b_ctx = _new_owner_org_farm(bob)
    r = bob.post(
        f"{API}/organizations/{b_ctx['org_id']}/production-unit-types",
        json={"code": "SECRET_TANK", "name": "Secret Tank", "category": "custom"},
    )
    assert r.status_code == 201, r.text

    # Positive control: Bob himself sees it.
    r = bob.get(f"{API}/production-unit-types")
    codes = {t["code"] for t in r.json()}
    assert "SECRET_TANK" in codes, f"owner cannot see own custom: {codes}"

    # Alice (fresh, no membership in B).
    alice = _new_session()
    _new_owner_org_farm(alice)

    # a) No filter → outsider sees ONLY system types.
    r = alice.get(f"{API}/production-unit-types")
    assert r.status_code == 200, r.text
    codes = {t["code"] for t in r.json()}
    assert "SECRET_TANK" not in codes, f"cross-tenant leak (no filter): {codes}"
    assert all(t["is_system"] for t in r.json()), "non-system entry leaked"

    # b) Spoofed filter → outsider passes B's org id.
    r = alice.get(f"{API}/production-unit-types", params={"organization_id": b_ctx["org_id"]})
    assert r.status_code == 200, r.text
    codes = {t["code"] for t in r.json()}
    assert "SECRET_TANK" not in codes, f"cross-tenant leak with filter: {codes}"
    assert all(t["is_system"] for t in r.json()), "non-system leaked via spoofed filter"


def test_crg1_own_org_custom_unit_type_is_visible_with_filter():
    s = _new_session()
    ctx = _new_owner_org_farm(s)
    r = s.post(
        f"{API}/organizations/{ctx['org_id']}/production-unit-types",
        json={"code": "MY_TANK", "name": "My Tank"},
    )
    assert r.status_code == 201, r.text

    # Unfiltered
    r = s.get(f"{API}/production-unit-types")
    assert "MY_TANK" in {t["code"] for t in r.json()}

    # Filtered by own org
    r = s.get(f"{API}/production-unit-types", params={"organization_id": ctx["org_id"]})
    assert "MY_TANK" in {t["code"] for t in r.json()}


# ===================================================================== #
# CRG01-2 — production-event idempotency
# ===================================================================== #
def test_crg2_same_key_same_payload_returns_replay():
    s = _new_session()
    batch_id = _prepare_active_batch(s)
    key = f"idem-{uuid4().hex}"
    body = {"event_type": "FEEDING", "data": {"feed_kg": 2.5, "feed_type": "grower"}}

    r1 = s.post(f"{API}/batches/{batch_id}/events", json=body, headers={"Idempotency-Key": key})
    assert r1.status_code == 201, r1.text
    assert r1.headers.get("X-Idempotent-Replay") is None
    original_id = r1.json()["id"]

    r2 = s.post(f"{API}/batches/{batch_id}/events", json=body, headers={"Idempotency-Key": key})
    assert r2.status_code == 200, r2.text
    assert r2.headers.get("X-Idempotent-Replay") == "true"
    assert r2.json()["id"] == original_id

    # DB-side: exactly one FEEDING event.
    r = s.get(f"{API}/batches/{batch_id}/events", params={"event_type": "FEEDING"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1, items


def test_crg2_same_key_different_payload_returns_409():
    s = _new_session()
    batch_id = _prepare_active_batch(s)
    key = f"idem-{uuid4().hex}"
    r1 = s.post(
        f"{API}/batches/{batch_id}/events",
        json={"event_type": "FEEDING", "data": {"feed_kg": 1.0, "feed_type": "starter"}},
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201, r1.text
    r2 = s.post(
        f"{API}/batches/{batch_id}/events",
        json={"event_type": "FEEDING", "data": {"feed_kg": 999.9, "feed_type": "grower"}},
        headers={"Idempotency-Key": key},
    )
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["code"] == "idempotency_key_payload_conflict", detail
    assert detail.get("idempotency_key") == key


def test_crg2_missing_header_creates_two_distinct_events():
    s = _new_session()
    batch_id = _prepare_active_batch(s)
    body = {"event_type": "FEEDING", "data": {"feed_kg": 1.0, "feed_type": "starter"}}
    r1 = s.post(f"{API}/batches/{batch_id}/events", json=body)
    r2 = s.post(f"{API}/batches/{batch_id}/events", json=body)
    assert r1.status_code == r2.status_code == 201
    assert r1.json()["id"] != r2.json()["id"]


def test_crg2_key_reused_across_batches_is_scoped_per_batch():
    s = _new_session()
    ctx = _new_owner_org_farm(s)
    ut = _pick_system_unit_type_id(s, ctx["org_id"])
    unit_id = _create_unit(s, ctx["site_id"], ut)
    b1 = _create_batch(s, unit_id)
    b2 = _create_batch(s, unit_id)
    key = f"shared-{uuid4().hex}"
    body = {"event_type": "STOCKING", "data": {"quantity": 1}}
    r1 = s.post(f"{API}/batches/{b1}/events", json=body, headers={"Idempotency-Key": key})
    r2 = s.post(f"{API}/batches/{b2}/events", json=body, headers={"Idempotency-Key": key})
    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text
    assert r1.json()["id"] != r2.json()["id"]


def test_crg2_stocking_replay_does_not_double_transition():
    s = _new_session()
    ctx = _new_owner_org_farm(s)
    ut = _pick_system_unit_type_id(s, ctx["org_id"])
    unit_id = _create_unit(s, ctx["site_id"], ut)
    batch_id = _create_batch(s, unit_id)

    key = f"stock-{uuid4().hex}"
    body = {"event_type": "STOCKING", "data": {"quantity": 100}}
    r1 = s.post(f"{API}/batches/{batch_id}/events", json=body, headers={"Idempotency-Key": key})
    assert r1.status_code == 201, r1.text
    r2 = s.post(f"{API}/batches/{batch_id}/events", json=body, headers={"Idempotency-Key": key})
    assert r2.status_code == 200
    assert r2.headers.get("X-Idempotent-Replay") == "true"

    # PLANNED -> STOCKED must appear exactly once in transition history.
    r = s.get(f"{API}/batches/{batch_id}/transitions")
    rows = r.json()
    assert len(rows) == 2, rows
    assert rows[0]["to_state"] == "planned"
    assert rows[1]["to_state"] == "stocked"


def test_crg2_concurrent_same_key_leaves_exactly_one_event():
    """DB-level: partial unique index makes only one row possible.

    We fire two identical POSTs in parallel via httpx's AsyncClient.
    We assert the strong invariant (single row); the (201, 200) shape
    is preferred but a (5xx, 201) recovery on race collision is also
    acceptable as long as final row-count is 1.
    """
    setup = _new_session()
    batch_id = _prepare_active_batch(setup)

    # Extract the cookie jar for httpx.
    cookies = {c.name: c.value for c in setup.cookies}
    key = f"race-{uuid4().hex}"
    body = {"event_type": "FEEDING", "data": {"feed_kg": 3.0, "feed_type": "grower"}}

    async def _fire() -> tuple[int, int]:
        async with httpx.AsyncClient(cookies=cookies, timeout=15) as ac:
            r1, r2 = await asyncio.gather(
                ac.post(
                    f"{API}/batches/{batch_id}/events",
                    json=body,
                    headers={"Idempotency-Key": key},
                ),
                ac.post(
                    f"{API}/batches/{batch_id}/events",
                    json=body,
                    headers={"Idempotency-Key": key},
                ),
            )
            return r1.status_code, r2.status_code

    s1, s2 = asyncio.run(_fire())
    print(f"concurrent statuses: {s1}, {s2}")
    ok = [c for c in (s1, s2) if c in (200, 201)]
    assert ok, (s1, s2)

    r = setup.get(f"{API}/batches/{batch_id}/events", params={"event_type": "FEEDING"})
    items = r.json()["items"]
    assert len(items) == 1, items


def test_crg2_event_transition_happy_path_atomicity():
    """Positive atomicity check: a STOCKING event on a fresh PLANNED
    batch MUST commit BOTH the event row AND the PLANNED→STOCKED
    transition together.

    (The negative case — transition raises → event MUST NOT persist —
    can only be triggered under a real DB-level race between two
    lifecycle transitions and is exercised by the Postgres integration
    tests in ``test_production_engine.py::test_concurrent_transitions_only_one_wins``.
    Here we assert the request-scoped happy-path invariant that is
    verifiable via the public HTTP surface.)
    """
    s = _new_session()
    ctx = _new_owner_org_farm(s)
    ut = _pick_system_unit_type_id(s, ctx["org_id"])
    unit_id = _create_unit(s, ctx["site_id"], ut)
    batch_id = _create_batch(s, unit_id)

    # Before: batch is PLANNED, no STOCKING event, one implicit
    # (None → PLANNED) transition row.
    r = s.get(f"{API}/batches/{batch_id}")
    assert r.json()["state"] == "planned", r.text
    events_before = s.get(
        f"{API}/batches/{batch_id}/events", params={"event_type": "STOCKING"}
    ).json()["items"]
    assert len(events_before) == 0
    transitions_before = s.get(f"{API}/batches/{batch_id}/transitions").json()
    assert len(transitions_before) == 1
    assert transitions_before[0]["to_state"] == "planned"

    # POST STOCKING → both event and transition must appear.
    r = s.post(
        f"{API}/batches/{batch_id}/events",
        json={"event_type": "STOCKING", "data": {"quantity": 100}},
    )
    assert r.status_code == 201, r.text

    # After: batch state is STOCKED, event is visible, transition
    # history has PLANNED → STOCKED.
    r = s.get(f"{API}/batches/{batch_id}")
    assert r.json()["state"] == "stocked", r.text
    events_after = s.get(
        f"{API}/batches/{batch_id}/events", params={"event_type": "STOCKING"}
    ).json()["items"]
    assert len(events_after) == 1
    transitions_after = s.get(f"{API}/batches/{batch_id}/transitions").json()
    assert len(transitions_after) == 2
    assert transitions_after[1]["to_state"] == "stocked"
    assert transitions_after[1]["from_state"] == "planned"


if __name__ == "__main__":
    # Quick manual driver — pytest -q is the canonical entry point.
    pytest.main([__file__, "-v", "-s"])
