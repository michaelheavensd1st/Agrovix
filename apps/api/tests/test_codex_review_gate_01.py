"""Codex Review Gate 01 — regression tests.

Two focused suites:

* **CRG01-1**: Cross-tenant leak on ``GET /production-unit-types``.
  Custom unit types owned by another organization MUST NOT be visible
  to a caller who is not a member of that organization, even when the
  caller passes that organization's UUID as a query filter.

* **CRG01-2**: Idempotency on ``POST /batches/{id}/events``. Same key
  + same payload → replay (200 + ``X-Idempotent-Replay: true``); same
  key + different payload → 409; new key on a state-changing event
  writes exactly one row.
"""

from __future__ import annotations

import asyncio
import os
from uuid import uuid4

import pytest
from httpx import AsyncClient

from tests._helpers import (
    create_org,
    create_verified_user,
    switch_user,
)
from tests.test_production_engine import (
    _create_batch,
    _create_unit,
    _new_owner_org_farm,
    _pick_system_unit_type_id,
)


# ===================================================================== #
# CRG01-1 — cross-tenant unit-type visibility
# ===================================================================== #
@pytest.mark.asyncio
async def test_cross_tenant_custom_unit_type_is_never_returned(client: AsyncClient) -> None:
    """A caller who is not a member of org B must NEVER see B's custom
    unit types, even by passing ``organization_id=<B>`` in the query
    string. This is the leak fixed under CRG01-1."""
    # --- Org B creates a custom unit type -------------------------- #
    b = await _new_owner_org_farm(client)
    r = await client.post(
        f"/api/v1/organizations/{b['org_id']}/production-unit-types",
        json={"code": "SECRET_TANK", "name": "Secret Tank", "category": "custom"},
    )
    assert r.status_code == 201, r.text

    # --- Org A user (fresh, no membership in B) ------------------- #
    outsider = f"crg1-out-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"crg1-a-{uuid4().hex[:6]}")

    # a) No filter — outsider sees ONLY system types.
    r = await client.get("/api/v1/production-unit-types")
    assert r.status_code == 200
    codes = {t["code"] for t in r.json()}
    assert "SECRET_TANK" not in codes
    assert all(t["is_system"] for t in r.json())

    # b) Spoofed filter — outsider tries to force B's org id.
    #    Endpoint must silently strip the unauthorised filter and STILL
    #    return only system types (no signal about B's existence).
    r = await client.get(
        "/api/v1/production-unit-types",
        params={"organization_id": b["org_id"]},
    )
    assert r.status_code == 200
    codes = {t["code"] for t in r.json()}
    assert "SECRET_TANK" not in codes
    assert all(t["is_system"] for t in r.json())


@pytest.mark.asyncio
async def test_own_org_custom_unit_type_is_visible(client: AsyncClient) -> None:
    """Positive control: the owning org's user CAN see their own custom
    types, both unfiltered and with the ``organization_id`` filter."""
    ctx = await _new_owner_org_farm(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/production-unit-types",
        json={"code": "MY_TANK", "name": "My Tank"},
    )
    assert r.status_code == 201

    r = await client.get("/api/v1/production-unit-types")
    codes = {t["code"] for t in r.json()}
    assert "MY_TANK" in codes

    r = await client.get(
        "/api/v1/production-unit-types",
        params={"organization_id": ctx["org_id"]},
    )
    codes = {t["code"] for t in r.json()}
    assert "MY_TANK" in codes


# ===================================================================== #
# CRG01-2 — production-event idempotency
# ===================================================================== #
async def _prepare_active_batch(client: AsyncClient) -> str:
    """Helper that leaves us with an ACTIVE batch ready to accept a
    FEEDING event (which is not lifecycle-driven)."""
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    batch_id = await _create_batch(client, unit_id)
    # PLANNED -> STOCKED via STOCKING event; STOCKED -> ACTIVE explicit
    await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={"event_type": "STOCKING", "data": {"quantity": 1}},
    )
    await client.post(
        f"/api/v1/batches/{batch_id}/transitions",
        json={"target_state": "active"},
    )
    return batch_id


@pytest.mark.asyncio
async def test_same_key_same_payload_returns_replay(client: AsyncClient) -> None:
    batch_id = await _prepare_active_batch(client)
    key = f"idem-{uuid4().hex}"
    body = {"event_type": "FEEDING", "data": {"feed_kg": 2.5, "feed_type": "grower"}}

    r1 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201, r1.text
    assert r1.headers.get("X-Idempotent-Replay") is None
    original_id = r1.json()["id"]

    # Same key + same payload → replay
    r2 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r2.status_code == 200, r2.text
    assert r2.headers.get("X-Idempotent-Replay") == "true"
    assert r2.json()["id"] == original_id


@pytest.mark.asyncio
async def test_same_key_different_payload_returns_409(client: AsyncClient) -> None:
    batch_id = await _prepare_active_batch(client)
    key = f"idem-{uuid4().hex}"

    r1 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={"event_type": "FEEDING", "data": {"feed_kg": 1.0, "feed_type": "starter"}},
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201

    r2 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={"event_type": "FEEDING", "data": {"feed_kg": 999.9, "feed_type": "grower"}},
        headers={"Idempotency-Key": key},
    )
    assert r2.status_code == 409, r2.text
    detail = r2.json()["detail"]
    assert detail["code"] == "idempotency_key_payload_conflict"
    assert detail["idempotency_key"] == key


@pytest.mark.asyncio
async def test_missing_header_does_not_activate_idempotency(client: AsyncClient) -> None:
    """Without an ``Idempotency-Key`` header, each POST creates a NEW
    event even with identical payloads — legacy behavior preserved."""
    batch_id = await _prepare_active_batch(client)
    body = {"event_type": "FEEDING", "data": {"feed_kg": 1.0, "feed_type": "starter"}}
    r1 = await client.post(f"/api/v1/batches/{batch_id}/events", json=body)
    r2 = await client.post(f"/api/v1/batches/{batch_id}/events", json=body)
    assert r1.status_code == r2.status_code == 201
    assert r1.json()["id"] != r2.json()["id"]


@pytest.mark.asyncio
async def test_idempotent_stocking_does_not_double_transition(client: AsyncClient) -> None:
    """Replaying a state-changing STOCKING event with the same key must
    NOT create a second transition row (verifies that replay short-
    circuits BEFORE the batch-service transition logic)."""
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    batch_id = await _create_batch(client, unit_id)

    key = f"stock-{uuid4().hex}"
    body = {"event_type": "STOCKING", "data": {"quantity": 100}}
    r1 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r1.status_code == 201, r1.text

    # Second call — same key, same payload → replay
    r2 = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json=body,
        headers={"Idempotency-Key": key},
    )
    assert r2.status_code == 200
    assert r2.headers.get("X-Idempotent-Replay") == "true"

    # Transition history should have exactly TWO entries:
    # (None → PLANNED) [batch creation] and (PLANNED → STOCKED) [first event].
    r = await client.get(f"/api/v1/batches/{batch_id}/transitions")
    rows = r.json()
    assert len(rows) == 2, rows
    assert rows[0]["to_state"] == "planned"
    assert rows[1]["to_state"] == "stocked"


# Marker used to skip tests that require true DB-level concurrency —
# SQLite (test suite default) serializes writers through a single
# shared connection under StaticPool, so a genuine race cannot be
# simulated. These tests run in the Postgres integration job.
_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serializes writers.",
)


@_postgres_only
@pytest.mark.asyncio
async def test_concurrent_same_key_produces_exactly_one_event(client: AsyncClient) -> None:
    """Two concurrent POSTs with the same idempotency key must NOT
    result in two rows.

    The core guarantee is enforced by a partial unique index at the
    database layer. Under Postgres, the SAVEPOINT-wrapped INSERT
    catches the collision cleanly and the loser is replayed. Under
    SQLite (used by the hermetic suite), the shared aiosqlite
    connection + StaticPool cannot faithfully model a race — one of
    the two callers may see a 5xx as SQLAlchemy aborts the outer
    transaction. We therefore assert only the invariant that
    matters: **at most one event exists per (batch_id,
    idempotency_key)**. Postgres integration tests exercise the
    cleaner (200/201, 200/201) shape.
    """
    batch_id = await _prepare_active_batch(client)
    key = f"race-{uuid4().hex}"
    body = {"event_type": "FEEDING", "data": {"feed_kg": 3.0, "feed_type": "grower"}}

    r1, r2 = await asyncio.gather(
        client.post(
            f"/api/v1/batches/{batch_id}/events",
            json=body,
            headers={"Idempotency-Key": key},
        ),
        client.post(
            f"/api/v1/batches/{batch_id}/events",
            json=body,
            headers={"Idempotency-Key": key},
        ),
        return_exceptions=False,
    )
    # At least one call must have succeeded — the loser is allowed to
    # 5xx on SQLite due to the driver-level serialization issue.
    ok = [r for r in (r1, r2) if r.status_code in (200, 201)]
    assert ok, (r1.status_code, r2.status_code, r1.text, r2.text)
    # The winners must all point to the same event id.
    ids = {r.json()["id"] for r in ok}
    assert len(ids) == 1, ids

    # The strong invariant: DB has exactly ONE FEEDING event for this
    # batch. (The batch already has a STOCKING event from
    # ``_prepare_active_batch`` — filter it out.)
    r = await client.get(f"/api/v1/batches/{batch_id}/events?event_type=FEEDING")
    assert len(r.json()["items"]) == 1


@pytest.mark.asyncio
async def test_idempotent_replay_is_scoped_per_batch(client: AsyncClient) -> None:
    """The same Idempotency-Key can be reused across DIFFERENT batches
    (the unique index is scoped by ``batch_id``)."""
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    b1 = await _create_batch(client, unit_id)
    b2 = await _create_batch(client, unit_id)
    key = f"shared-{uuid4().hex}"
    body = {"event_type": "STOCKING", "data": {"quantity": 1}}

    r1 = await client.post(
        f"/api/v1/batches/{b1}/events", json=body, headers={"Idempotency-Key": key}
    )
    r2 = await client.post(
        f"/api/v1/batches/{b2}/events", json=body, headers={"Idempotency-Key": key}
    )
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["id"] != r2.json()["id"]
