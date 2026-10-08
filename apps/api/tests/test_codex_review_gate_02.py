"""Codex Review Gate 02 — regression tests.

Focused on the pre-merge hardening set:

* **Endpoint permission enforcement** — a member with a read-only role
  cannot mutate; a non-member still receives 404 (tenancy 404 comes
  before permission 403).
* **Postgres row-level concurrency** — mortality / transfer / harvest /
  stocking event races cannot drive stock below zero or duplicate a
  once-only event. These tests require real DB-level concurrency and
  therefore skip under SQLite (see marker below).
* **STOCKING policy** — exactly one STOCKING per batch, only while
  ``state == PLANNED``.
* **HARVEST validation** — quantity cannot exceed remaining
  population; ``total_weight`` must be > 0; a second final HARVEST is
  rejected.
* **Site / unit lifecycle policy** — MAINTENANCE narrows the allowed
  event surface; CLOSED blocks all writes; a unit / site cannot be
  closed while it still contains active batches.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production import ProductionEvent
from app.repositories.production import ProductionBatchRepository
from tests._helpers import (
    create_org,
    create_verified_user,
    harvest_payload,
    invite_and_accept,
    mortality_payload,
    sampling_payload,
    stocking_payload,
    switch_user,
    transfer_payload,
)
from tests.test_production_engine import (
    _create_batch,
    _create_unit,
    _new_owner_org_farm,
    _pick_system_unit_type_id,
)

pytestmark = pytest.mark.asyncio


# Marker: race tests require real DB-level concurrency (Postgres).
# Under SQLite the shared aiosqlite connection + StaticPool serializes
# all writers, so a genuine race cannot be simulated and the test would
# either false-pass or false-fail.
_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serializes writers.",
)


# --------------------------------------------------------------------- #
# Fixture helpers
# --------------------------------------------------------------------- #
async def _prepare_planned_batch(client: AsyncClient) -> dict:
    """Owner + PLANNED batch. Returns ctx + ``batch_id``."""
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    batch_id = await _create_batch(client, unit_id)
    ctx["unit_id"] = unit_id
    ctx["batch_id"] = batch_id
    ctx["unit_type_id"] = ut
    return ctx


async def _prepare_active_batch(client: AsyncClient, quantity: int = 1000) -> dict:
    """Same as `_prepare_planned_batch` + STOCKING + STOCKED→ACTIVE."""
    ctx = await _prepare_planned_batch(client)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "STOCKING", "data": stocking_payload(quantity=quantity)},
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/transitions",
        json={"target_state": "active"},
    )
    assert r.status_code == 200, r.text
    ctx["stocked_quantity"] = quantity
    return ctx


async def _prepare_receiving_batch(client: AsyncClient, unit_id: str, quantity: int = 1) -> str:
    batch_id = await _create_batch(client, unit_id)
    response = await client.post(
        f"/api/v1/batches/{batch_id}/events",
        json={"event_type": "STOCKING", "data": stocking_payload(quantity=quantity)},
    )
    assert response.status_code == 201, response.text
    return str(batch_id)


# ===================================================================== #
# 1. Permission enforcement (runs on SQLite too)
# ===================================================================== #
async def test_member_without_event_permission_cannot_create_event(
    client: AsyncClient,
) -> None:
    """A `viewer` in the same org receives 403 on POST /events, not 200.

    Tenancy check remains ahead of the permission gate (proven by the
    cross-tenant suite): a non-member would receive 404. The viewer
    IS a member — that's why they hit 403 instead of 404.
    """
    owner_ctx = await _prepare_active_batch(client, quantity=100)
    owner_email = owner_ctx["owner"]

    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=owner_email,
        invitee_email=viewer,
        org_id=owner_ctx["org_id"],
        role_name="viewer",
    )
    # Viewer is now switched-in from `invite_and_accept`. Try to write.
    r = await client.post(
        f"/api/v1/batches/{owner_ctx['batch_id']}/events",
        json={"event_type": "FEEDING", "data": {"quantity": 1.0, "feed_description": "x"}},
    )
    assert r.status_code == 403, r.text
    assert "production_event.create" in r.json()["detail"]


async def test_non_member_still_receives_404_not_403(client: AsyncClient) -> None:
    """Tenancy 404 must precede permission 403 (no existence leak)."""
    owner_ctx = await _prepare_planned_batch(client)

    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"out-{uuid4().hex[:6]}")

    r = await client.get(f"/api/v1/batches/{owner_ctx['batch_id']}")
    assert r.status_code == 404, r.text


async def test_viewer_can_still_read(client: AsyncClient) -> None:
    """Positive control: `viewer` role has read permissions."""
    owner_ctx = await _prepare_active_batch(client, quantity=50)
    viewer = f"reader-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=owner_ctx["owner"],
        invitee_email=viewer,
        org_id=owner_ctx["org_id"],
        role_name="viewer",
    )
    r = await client.get(f"/api/v1/batches/{owner_ctx['batch_id']}")
    assert r.status_code == 200, r.text


# ===================================================================== #
# 2. STOCKING policy (SQLite: sequential; Postgres: race)
# ===================================================================== #
async def test_second_sequential_stocking_is_rejected(client: AsyncClient) -> None:
    """Batch can be stocked exactly once."""
    ctx = await _prepare_planned_batch(client)
    body = {"event_type": "STOCKING", "data": stocking_payload(quantity=500)}
    r1 = await client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body)
    assert r1.status_code == 201, r1.text

    r2 = await client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body)
    assert r2.status_code == 409, r2.text
    # After the first STOCKING the batch is no longer PLANNED, so the
    # PLANNED-only guard fires first with the state-mismatch error.
    detail = r2.json()["detail"]
    assert detail["code"] in {
        "stocking_only_in_planned_state",
        "stocking_already_recorded",
    }


async def test_stocking_rejected_when_batch_not_planned(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "STOCKING", "data": stocking_payload(quantity=10)},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "stocking_only_in_planned_state"


@_postgres_only
async def test_concurrent_stocking_only_one_wins(client: AsyncClient) -> None:
    """Two simultaneous STOCKING events → one 201, one 409."""
    ctx = await _prepare_planned_batch(client)
    body_a = {"event_type": "STOCKING", "data": stocking_payload(quantity=200)}
    body_b = {"event_type": "STOCKING", "data": stocking_payload(quantity=300)}

    r1, r2 = await asyncio.gather(
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body_a),
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body_b),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses[0] == 201, (r1.text, r2.text)
    assert statuses[1] == 409, (r1.text, r2.text)

    # There must be exactly one STOCKING event on the batch.
    r = await client.get(
        f"/api/v1/batches/{ctx['batch_id']}/events", params={"event_type": "STOCKING"}
    )
    assert r.status_code == 200
    assert len(r.json()["items"]) == 1


# ===================================================================== #
# 3. HARVEST validation
# ===================================================================== #
async def test_harvest_total_weight_zero_rejected_by_schema(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=50)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=10, total_weight=0, harvest_type="partial", is_final=False
            ),
        },
    )
    # The Pydantic schema uses `gt=0`; the endpoint returns 422 with
    # field-level detail.
    assert r.status_code == 422, r.text


async def test_harvest_exceeds_remaining_population_returns_409(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=101,
                total_weight=50,
                harvest_type="partial",
                is_final=False,
            ),
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_exceeds_population"


async def test_second_final_harvest_rejected(client: AsyncClient) -> None:
    """Second final HARVEST is 409 harvest_already_final.

    A partial (non-final) harvest first, then a final one succeeds and
    transitions the batch. A second final harvest attempt after that
    hits the terminal-state guard (batch is HARVESTED).
    """
    ctx = await _prepare_active_batch(client, quantity=100)

    # First a partial harvest — batch stays ACTIVE.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=20, total_weight=6, harvest_type="partial", is_final=False
            ),
        },
    )
    assert r.status_code == 201, r.text

    # First final harvest — transitions to HARVESTED.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=80, total_weight=10, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 201, r.text

    # Second final harvest — rejected by the final-harvest guard.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=10, total_weight=4, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_already_final"


# --------------------------------------------------------------------- #
# 3b. HARVEST safety (final = ACTIVE-only, full remaining, once)
# --------------------------------------------------------------------- #
def _events_url(ctx: dict) -> str:
    return f"/api/v1/batches/{ctx['batch_id']}/events"


def _harvest_body(
    quantity: int, *, final: bool, total_weight: float = 10.0, harvested_at: str | None = None
) -> dict:
    data = harvest_payload(
        quantity=quantity,
        total_weight=total_weight,
        harvest_type="total" if final else "partial",
        is_final=final,
    )
    if harvested_at is not None:
        data["harvested_at"] = harvested_at
    return {"event_type": "HARVEST", "data": data}


async def _harvest_event_count(client: AsyncClient, ctx: dict) -> int:
    r = await client.get(_events_url(ctx), params={"event_type": "HARVEST"})
    assert r.status_code == 200, r.text
    return len(r.json()["items"])


async def _batch_state(client: AsyncClient, ctx: dict) -> str:
    r = await client.get(f"/api/v1/batches/{ctx['batch_id']}")
    assert r.status_code == 200, r.text
    return r.json()["state"]


async def test_final_harvest_equal_to_remaining_transitions_to_harvested(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "harvested"


async def test_final_harvest_after_partial_must_equal_remaining(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(40, final=False))
    assert r.status_code == 201, r.text
    r = await client.post(_events_url(ctx), json=_harvest_body(60, final=True))
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "harvested"


@pytest.mark.parametrize("target", ["stocked", "suspended"])
async def test_final_harvest_requires_active_batch(client: AsyncClient, target: str) -> None:
    ctx = await _prepare_planned_batch(client)
    r = await client.post(
        _events_url(ctx), json={"event_type": "STOCKING", "data": stocking_payload(quantity=100)}
    )
    assert r.status_code == 201, r.text
    if target == "suspended":
        r = await client.post(
            f"/api/v1/batches/{ctx['batch_id']}/transitions", json={"target_state": "suspended"}
        )
        assert r.status_code == 200, r.text
    assert await _batch_state(client, ctx) == target

    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "harvest_final_requires_active"
    assert detail["current_state"] == target
    assert detail["required_state"] == "active"
    assert await _harvest_event_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == target


async def test_partial_harvest_still_allowed_on_active_batch(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(30, final=False))
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "active"
    proj = (await client.get(f"/api/v1/batches/{ctx['batch_id']}/projections")).json()
    assert proj["cumulative_harvest"] == 30
    assert proj["estimated_remaining_population"] == 70


async def test_final_harvest_below_remaining_rejected(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(99, final=True))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "harvest_final_quantity_mismatch"
    assert detail["quantity"] == 99
    assert detail["estimated_remaining_population"] == 100
    assert await _harvest_event_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == "active"


async def test_final_harvest_above_remaining_rejected(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(101, final=True))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_exceeds_population"
    assert await _harvest_event_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == "active"


async def test_final_harvest_uses_sampling_population_override(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(
        _events_url(ctx),
        json={
            "event_type": "SAMPLING",
            "data": sampling_payload(estimated_population=80),
        },
    )
    assert r.status_code == 201, r.text
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_exceeds_population"
    r = await client.post(_events_url(ctx), json=_harvest_body(79, final=True))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_final_quantity_mismatch"
    assert r.json()["detail"]["estimated_remaining_population"] == 80
    r = await client.post(_events_url(ctx), json=_harvest_body(80, final=True))
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "harvested"


def _days_from_now(days: int) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).isoformat()


async def _post_dated(client: AsyncClient, ctx: dict, event_type: str, data: dict, days: int):
    return await client.post(
        _events_url(ctx),
        json={"event_type": event_type, "data": data, "performed_at": _days_from_now(days)},
    )


async def test_final_harvest_backdated_before_sampling_is_rejected(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await _post_dated(client, ctx, "SAMPLING", sampling_payload(estimated_population=80), 3)
    assert r.status_code == 201, r.text
    body = _harvest_body(80, final=True)
    r = await client.post(_events_url(ctx), json={**body, "performed_at": _days_from_now(2)})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_final_backdated"
    assert await _harvest_event_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == "active"


@pytest.mark.parametrize("later_type", ["MORTALITY", "HARVEST"])
async def test_final_harvest_backdated_before_population_event_is_rejected(
    client: AsyncClient, later_type: str
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    if later_type == "MORTALITY":
        later = await _post_dated(client, ctx, "MORTALITY", mortality_payload(count=10), 3)
    else:
        later = await _post_dated(client, ctx, "HARVEST", _harvest_body(10, final=False)["data"], 3)
    assert later.status_code == 201, later.text
    r = await client.post(
        _events_url(ctx),
        json={**_harvest_body(90, final=True), "performed_at": _days_from_now(2)},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_final_backdated"
    assert await _batch_state(client, ctx) == "active"


async def test_final_harvest_chronologically_after_sampling_is_accepted(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await _post_dated(client, ctx, "SAMPLING", sampling_payload(estimated_population=80), 2)
    assert r.status_code == 201, r.text
    r = await client.post(
        _events_url(ctx),
        json={**_harvest_body(80, final=True), "performed_at": _days_from_now(3)},
    )
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "harvested"


async def _projection(client: AsyncClient, ctx: dict) -> dict:
    r = await client.get(f"/api/v1/batches/{ctx['batch_id']}/projections")
    assert r.status_code == 200, r.text
    return {k: v for k, v in r.json().items() if k != "computed_at"}


async def _sampling_count(client: AsyncClient, ctx: dict) -> int:
    r = await client.get(_events_url(ctx), params={"event_type": "SAMPLING"})
    assert r.status_code == 200, r.text
    return len(r.json()["items"])


@pytest.mark.parametrize("offset_days", [-1, 0, 1])
async def test_sampling_estimate_after_final_harvest_is_rejected(
    client: AsyncClient, offset_days: int
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    harvest_at = datetime.now(UTC) + timedelta(days=2)
    r = await client.post(
        _events_url(ctx),
        json={**_harvest_body(100, final=True), "performed_at": harvest_at.isoformat()},
    )
    assert r.status_code == 201, r.text
    before = await _projection(client, ctx)
    r = await client.post(
        _events_url(ctx),
        json={
            "event_type": "SAMPLING",
            "data": sampling_payload(estimated_population=80),
            "performed_at": (harvest_at + timedelta(days=offset_days)).isoformat(),
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "sampling_after_final_harvest"
    assert await _sampling_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == "harvested"
    assert await _projection(client, ctx) == before


async def test_sampling_without_estimate_allowed_after_final_harvest(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 201, r.text
    r = await client.post(
        _events_url(ctx), json={"event_type": "SAMPLING", "data": sampling_payload()}
    )
    assert r.status_code == 201, r.text
    assert await _batch_state(client, ctx) == "harvested"


async def test_sampling_replay_after_final_harvest_returns_original(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    headers = {"Idempotency-Key": "sampling-replay-after-final-0001"}
    body = {"event_type": "SAMPLING", "data": sampling_payload(estimated_population=90)}
    first = await client.post(_events_url(ctx), json=body, headers=headers)
    assert first.status_code == 201, first.text
    r = await client.post(_events_url(ctx), json=_harvest_body(90, final=True))
    assert r.status_code == 201, r.text
    replay = await client.post(_events_url(ctx), json=body, headers=headers)
    assert replay.status_code == 200, replay.text
    assert replay.headers.get("X-Idempotent-Replay") == "true"
    assert replay.json()["id"] == first.json()["id"]
    assert await _sampling_count(client, ctx) == 1


async def test_sampling_estimate_before_final_harvest_remains_valid(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(
        _events_url(ctx),
        json={"event_type": "SAMPLING", "data": sampling_payload(estimated_population=90)},
    )
    assert r.status_code == 201, r.text
    assert await _sampling_count(client, ctx) == 1
    assert await _batch_state(client, ctx) == "active"


async def test_final_harvest_includes_transfer_in(client: AsyncClient) -> None:
    source = await _prepare_active_batch(client, quantity=100)
    destination_unit = await _create_unit(client, source["site_id"], source["unit_type_id"])
    destination_batch = await _prepare_receiving_batch(client, destination_unit, quantity=50)
    r = await client.post(
        f"/api/v1/batches/{destination_batch}/transitions", json={"target_state": "active"}
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        _events_url(source),
        json={
            "event_type": "TRANSFER",
            "data": transfer_payload(
                source_unit_id=source["unit_id"],
                destination_unit_id=destination_unit,
                destination_batch_id=destination_batch,
                quantity=20,
                transfer_loss=0,
            ),
        },
    )
    assert r.status_code == 201, r.text
    destination = {"batch_id": destination_batch}
    r = await client.post(_events_url(destination), json=_harvest_body(50, final=True))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_final_quantity_mismatch"
    assert r.json()["detail"]["estimated_remaining_population"] == 70
    r = await client.post(_events_url(destination), json=_harvest_body(70, final=True))
    assert r.status_code == 201, r.text
    assert await _batch_state(client, destination) == "harvested"


async def test_partial_harvest_rejected_after_final(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 201, r.text
    r = await client.post(_events_url(ctx), json=_harvest_body(1, final=False))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "harvest_already_final"
    assert await _harvest_event_count(client, ctx) == 1


async def test_final_harvest_replay_after_transition_returns_original_event(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    body = _harvest_body(100, final=True)
    headers = {"Idempotency-Key": f"harvest-{uuid4().hex}"}
    first = await client.post(_events_url(ctx), json=body, headers=headers)
    assert first.status_code == 201, first.text
    assert await _batch_state(client, ctx) == "harvested"

    replay = await client.post(_events_url(ctx), json=body, headers=headers)
    assert replay.status_code == 200, replay.text
    assert replay.headers.get("X-Idempotent-Replay") == "true"
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["data"] == first.json()["data"]
    assert await _harvest_event_count(client, ctx) == 1
    assert await _batch_state(client, ctx) == "harvested"


async def test_final_harvest_same_key_different_payload_conflicts(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    headers = {"Idempotency-Key": f"harvest-{uuid4().hex}"}
    body = _harvest_body(100, final=True)
    first = await client.post(_events_url(ctx), json=body, headers=headers)
    assert first.status_code == 201, first.text

    changed = _harvest_body(
        100, final=True, total_weight=11.0, harvested_at=body["data"]["harvested_at"]
    )
    r = await client.post(_events_url(ctx), json=changed, headers=headers)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "idempotency_key_payload_conflict"
    assert await _harvest_event_count(client, ctx) == 1


# SQLite's driver does not honour SAVEPOINT rollback of the event insert, so
# request-level rollback is only provable on PostgreSQL.
@_postgres_only
async def test_final_harvest_transition_failure_rolls_back_event(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    original = ProductionBatchRepository.compare_and_set_state

    async def lose_race(self, *args, **kwargs):
        return False

    monkeypatch.setattr(ProductionBatchRepository, "compare_and_set_state", lose_race)
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    monkeypatch.setattr(ProductionBatchRepository, "compare_and_set_state", original)

    assert r.status_code == 409, r.text
    db_session.expire_all()
    count = await db_session.scalar(
        select(func.count(ProductionEvent.id)).where(
            ProductionEvent.batch_id == UUID(str(ctx["batch_id"])),
            ProductionEvent.event_type == "HARVEST",
        )
    )
    assert count == 0
    assert await _batch_state(client, ctx) == "active"


async def test_viewer_cannot_harvest_and_outsider_gets_404(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=100)
    owner_email = ctx["owner"]

    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"out-{uuid4().hex[:6]}")
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 404, r.text

    await switch_user(client, owner_email)
    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=owner_email,
        invitee_email=viewer,
        org_id=ctx["org_id"],
        role_name="viewer",
    )
    r = await client.post(_events_url(ctx), json=_harvest_body(100, final=True))
    assert r.status_code == 403, r.text
    await switch_user(client, owner_email)
    assert await _harvest_event_count(client, ctx) == 0
    assert await _batch_state(client, ctx) == "active"


# ===================================================================== #
# 4. Site / Unit lifecycle policy
# ===================================================================== #
async def test_feeding_blocked_on_maintenance_unit(client: AsyncClient) -> None:
    """MAINTENANCE unit accepts water-quality + evacuation transfer only."""
    ctx = await _prepare_active_batch(client, quantity=50)
    # Owner puts the unit under MAINTENANCE.
    r = await client.patch(
        f"/api/v1/units/{ctx['unit_id']}",
        json={"status": "maintenance"},
    )
    assert r.status_code == 200, r.text

    # FEEDING now rejected.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "FEEDING", "data": {"quantity": 1.0, "feed_description": "x"}},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] in {
        "site_under_maintenance",
        "unit_under_maintenance",
    }

    # WATER_QUALITY still allowed.
    from tests._helpers import water_quality_payload

    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "WATER_QUALITY", "data": water_quality_payload()},
    )
    assert r.status_code == 201, r.text


async def test_no_writes_on_closed_unit(client: AsyncClient) -> None:
    """CLOSED unit → all event writes 409.

    Note: transitioning a unit to CLOSED while it holds an ACTIVE
    batch is itself blocked (tested below). We reach the CLOSED
    state here by first making the batch HARVESTED and then closing
    the unit.
    """
    ctx = await _prepare_active_batch(client, quantity=50)
    # Take the batch through a final harvest → HARVESTED.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=50, total_weight=20, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 201, r.text
    # Now CLOSED is allowed on the unit (no active batches).
    r = await client.patch(
        f"/api/v1/units/{ctx['unit_id']}",
        json={"status": "closed"},
    )
    assert r.status_code == 200, r.text
    # Even a WATER_QUALITY reading fails on CLOSED — but the batch is
    # HARVESTED so the terminal-state guard fires first. That still
    # proves "no writes on CLOSED" from the caller's perspective.
    from tests._helpers import water_quality_payload

    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "WATER_QUALITY", "data": water_quality_payload()},
    )
    assert r.status_code == 409, r.text


async def test_unit_close_blocked_by_active_batches(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=10)
    r = await client.patch(
        f"/api/v1/units/{ctx['unit_id']}",
        json={"status": "closed"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_close_blocked_by_active_batches"


async def test_site_close_blocked_by_active_batches(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=10)
    r = await client.patch(
        f"/api/v1/sites/{ctx['site_id']}",
        json={"status": "closed"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_close_blocked_by_active_batches"


async def test_transfer_into_maintenance_destination_blocked(client: AsyncClient) -> None:
    """TRANSFER into a MAINTENANCE unit is blocked."""
    ctx = await _prepare_active_batch(client, quantity=100)
    # Create a second unit in the same site + park it in MAINTENANCE.
    dst_unit_id = await _create_unit(client, ctx["site_id"], ctx["unit_type_id"])
    r = await client.patch(
        f"/api/v1/units/{dst_unit_id}",
        json={"status": "maintenance"},
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "TRANSFER",
            "data": transfer_payload(
                source_unit_id=ctx["unit_id"],
                destination_unit_id=dst_unit_id,
                quantity=10,
            ),
        },
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "transfer_destination_ineligible"


# ===================================================================== #
# 5. Codex Review Gate 02 (final) — creation + transition + update
#    lifecycle gates. Centralised in ``app.production.lifecycle_policy``.
# ===================================================================== #
async def test_cannot_create_unit_under_maintenance_site(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    r = await client.patch(
        f"/api/v1/sites/{ctx['site_id']}",
        json={"status": "maintenance"},
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/sites/{ctx['site_id']}/units",
        json={"unit_type_id": ut, "name": "Rejected", "code": f"R-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_under_maintenance"


async def test_cannot_create_unit_under_closed_site(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    # No batches exist yet — closing the empty site is allowed.
    r = await client.patch(
        f"/api/v1/sites/{ctx['site_id']}",
        json={"status": "closed"},
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/sites/{ctx['site_id']}/units",
        json={"unit_type_id": ut, "name": "Rejected", "code": f"R-{uuid4().hex[:6]}"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_closed_no_writes"


async def test_cannot_create_batch_under_maintenance_unit(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/units/{unit_id}/batches",
        json={"code": f"B-{uuid4().hex[:6]}", "species": "L. vannamei"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_under_maintenance"


async def test_cannot_create_batch_under_closed_unit(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/units/{unit_id}/batches",
        json={"code": f"B-{uuid4().hex[:6]}", "species": "L. vannamei"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_closed_no_writes"


async def test_cannot_create_batch_under_maintenance_site(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    # Unit stays ACTIVE, but the SITE moves to maintenance.
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/units/{unit_id}/batches",
        json={"code": f"B-{uuid4().hex[:6]}", "species": "L. vannamei"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_under_maintenance"


async def test_cannot_create_batch_under_closed_site(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/units/{unit_id}/batches",
        json={"code": f"B-{uuid4().hex[:6]}", "species": "L. vannamei"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_closed_no_writes"


async def test_cannot_manual_transition_under_maintenance_unit(client: AsyncClient) -> None:
    """Manual /transitions endpoint must be gated by unit lifecycle."""
    ctx = await _prepare_active_batch(client, quantity=50)
    r = await client.patch(f"/api/v1/units/{ctx['unit_id']}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/transitions",
        json={"target_state": "suspended"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] in {
        "unit_under_maintenance",
        "site_under_maintenance",
    }


async def test_cannot_manual_transition_under_maintenance_site(client: AsyncClient) -> None:
    ctx = await _prepare_active_batch(client, quantity=50)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/transitions",
        json={"target_state": "suspended"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_under_maintenance"


async def test_cannot_manual_transition_under_closed_unit(client: AsyncClient) -> None:
    """CLOSED unit blocks manual transitions.

    Reaching CLOSED requires no active batches, so we take the batch
    to HARVESTED (final-harvest) first, then close the unit.
    """
    ctx = await _prepare_active_batch(client, quantity=25)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=25, total_weight=10.0, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 201, r.text
    r = await client.patch(f"/api/v1/units/{ctx['unit_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    # HARVESTED → CLOSED is a legal state-machine transition, but the
    # lifecycle gate refuses it because the parent unit is CLOSED
    # (read-only) — no ordinary batch mutations are permitted.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/transitions",
        json={"target_state": "closed"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_closed_no_writes"


async def test_evacuation_transfer_still_works_from_maintenance(
    client: AsyncClient,
) -> None:
    """MAINTENANCE unit still permits an evacuating TRANSFER out."""
    ctx = await _prepare_active_batch(client, quantity=100)
    dst_unit_id = await _create_unit(client, ctx["site_id"], ctx["unit_type_id"])
    dst_batch_id = await _prepare_receiving_batch(client, dst_unit_id)
    r = await client.patch(f"/api/v1/units/{ctx['unit_id']}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "TRANSFER",
            "data": transfer_payload(
                source_unit_id=ctx["unit_id"],
                destination_unit_id=dst_unit_id,
                destination_batch_id=dst_batch_id,
                quantity=10,
            ),
        },
    )
    assert r.status_code == 201, r.text


async def test_closed_site_is_read_only_for_patch(client: AsyncClient) -> None:
    """CLOSED site accepts only a `status` reopen — no other fields."""
    ctx = await _new_owner_org_farm(client)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"name": "Renamed while closed"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_closed_no_writes"

    # Controlled reopen is allowed.
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "active"})
    assert r.status_code == 200, r.text


async def test_closed_unit_is_read_only_for_patch(client: AsyncClient) -> None:
    """CLOSED unit accepts only a `status` reopen — no other fields."""
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"name": "Nope"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_closed_no_writes"
    # Controlled reopen.
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "active"})
    assert r.status_code == 200, r.text


async def test_maintenance_site_disallows_capacity_edit(client: AsyncClient) -> None:
    """MAINTENANCE narrows PATCH to safe admin metadata + status."""
    ctx = await _new_owner_org_farm(client)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "maintenance"})
    assert r.status_code == 200, r.text
    # `capacity` is structural — refused while under maintenance.
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"capacity": 500})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_under_maintenance"
    # `name` is safe admin metadata — allowed.
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"name": "Rename OK"})
    assert r.status_code == 200, r.text


# ===================================================================== #
# 5.a Codex Review Gate 02 (verification pass) — remaining read
#     endpoints get explicit permission gates, remaining mutations get
#     the CLOSED lifecycle gate.
# ===================================================================== #
async def _create_orphan_user(client: AsyncClient, prefix: str = "orphan") -> str:
    """User with zero org memberships → holds no APE permissions."""
    email = f"{prefix}-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(email)
    await switch_user(client, email)
    return email


async def test_unauthenticated_cannot_list_unit_types(client: AsyncClient) -> None:
    # Ensure no active session before probing the endpoint.
    client.cookies.clear()
    r = await client.get("/api/v1/production-unit-types")
    assert r.status_code == 401, r.text


async def test_orphan_user_cannot_list_unit_types(client: AsyncClient) -> None:
    """Authenticated but no memberships → 403 (no APE perms anywhere)."""
    await _create_orphan_user(client)
    r = await client.get("/api/v1/production-unit-types")
    assert r.status_code == 403, r.text
    assert "production_unit_type.read" in r.json()["detail"]


async def test_non_member_org_scoped_unit_type_list_returns_404(client: AsyncClient) -> None:
    """Requesting `?organization_id=<other-tenant>` from a non-member returns 404.

    The tenancy check runs before the RBAC check so non-members can't
    probe for org existence via the 403/404 shape.
    """
    owner_ctx = await _new_owner_org_farm(client)  # owner org (target)
    # Switch to an outsider who owns a *different* org.
    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"out-{uuid4().hex[:6]}")

    r = await client.get(
        "/api/v1/production-unit-types",
        params={"organization_id": owner_ctx["org_id"]},
    )
    assert r.status_code == 404, r.text


async def test_authorized_member_can_list_unit_types(client: AsyncClient) -> None:
    """Owner (has viewer/owner roles) → 200 + at least the system types."""
    ctx = await _new_owner_org_farm(client)
    r = await client.get(
        "/api/v1/production-unit-types",
        params={"organization_id": ctx["org_id"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, list)
    assert any(t.get("is_system") for t in body), "expected at least one system unit type"


async def test_unauthenticated_cannot_read_event_catalog(client: AsyncClient) -> None:
    client.cookies.clear()
    r = await client.get("/api/v1/production-events/catalog")
    assert r.status_code == 401, r.text


async def test_orphan_user_cannot_read_event_catalog(client: AsyncClient) -> None:
    await _create_orphan_user(client)
    r = await client.get("/api/v1/production-events/catalog")
    assert r.status_code == 403, r.text
    assert "production_event.read" in r.json()["detail"]


async def test_authorized_member_can_read_event_catalog(client: AsyncClient) -> None:
    await _new_owner_org_farm(client)
    r = await client.get("/api/v1/production-events/catalog")
    assert r.status_code == 200, r.text
    assert isinstance(r.json().get("entries"), list)


# --- CLOSED lifecycle enforcement on remaining mutations ------------ #
async def test_batch_patch_blocked_when_parent_unit_is_closed(client: AsyncClient) -> None:
    """PATCH /batches/{id} refused while the parent unit is CLOSED."""
    ctx = await _prepare_active_batch(client, quantity=25)
    # Final-harvest → HARVESTED so the unit can be closed.
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=25, total_weight=10.0, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 201, r.text
    r = await client.patch(f"/api/v1/units/{ctx['unit_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text

    r = await client.patch(
        f"/api/v1/batches/{ctx['batch_id']}",
        json={"code": "renamed-while-closed"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_closed_no_writes"


async def test_batch_patch_blocked_when_parent_site_is_closed(client: AsyncClient) -> None:
    """PATCH /batches/{id} refused while the parent site is CLOSED."""
    ctx = await _prepare_active_batch(client, quantity=25)
    r = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={
            "event_type": "HARVEST",
            "data": harvest_payload(
                quantity=25, total_weight=10.0, harvest_type="total", is_final=True
            ),
        },
    )
    assert r.status_code == 201, r.text
    # Reach CLOSED site by first closing the unit, then closing the site.
    r = await client.patch(f"/api/v1/units/{ctx['unit_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text

    r = await client.patch(
        f"/api/v1/batches/{ctx['batch_id']}",
        json={"code": "renamed-while-site-closed"},
    )
    assert r.status_code == 409, r.text
    # Either the site OR unit closed check may fire first; both are valid.
    assert r.json()["detail"]["code"] in {"site_closed_no_writes", "unit_closed_no_writes"}


async def test_delete_site_blocked_when_site_is_closed(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/sites/{ctx['site_id']}")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "site_closed_no_writes"


async def test_delete_unit_blocked_when_unit_is_closed(client: AsyncClient) -> None:
    ctx = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], ut)
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/units/{unit_id}")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "unit_closed_no_writes"


async def test_reopen_then_delete_follows_normal_safeguards(client: AsyncClient) -> None:
    """CLOSED site is refused DELETE, but reopening → DELETE succeeds."""
    ctx = await _new_owner_org_farm(client)
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/sites/{ctx['site_id']}")
    assert r.status_code == 409, r.text

    # Reopen through the explicit status update path.
    r = await client.patch(f"/api/v1/sites/{ctx['site_id']}", json={"status": "active"})
    assert r.status_code == 200, r.text
    # Now DELETE proceeds through the normal soft-delete flow.
    r = await client.delete(f"/api/v1/sites/{ctx['site_id']}")
    assert r.status_code == 200, r.text
    # Soft-deleted sites disappear from the tenancy scope (404 on GET).
    r = await client.get(f"/api/v1/sites/{ctx['site_id']}")
    assert r.status_code == 404

    # Same round-trip for a unit.
    ctx2 = await _new_owner_org_farm(client)
    ut = await _pick_system_unit_type_id(client, ctx2["org_id"])
    unit_id = await _create_unit(client, ctx2["site_id"], ut)
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "closed"})
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/units/{unit_id}")
    assert r.status_code == 409, r.text
    r = await client.patch(f"/api/v1/units/{unit_id}", json={"status": "active"})
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/units/{unit_id}")
    assert r.status_code == 200, r.text


# ===================================================================== #
# 6. Postgres-only concurrency races
# ===================================================================== #
@_postgres_only
async def test_concurrent_mortalities_never_overshoot(client: AsyncClient) -> None:
    """Two mortalities that together exceed remaining → one succeeds."""
    ctx = await _prepare_active_batch(client, quantity=100)
    body = {"event_type": "MORTALITY", "data": mortality_payload(count=60)}

    r1, r2 = await asyncio.gather(
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    # Exactly one write succeeded; the other must be rejected — never
    # both, because 60+60 > 100.
    assert statuses[0] == 201
    assert statuses[1] == 409, (r1.text, r2.text)

    # Projections must show ≥ 0 population and cumulative mortality
    # equal to the winning event's count only.
    r = await client.get(f"/api/v1/batches/{ctx['batch_id']}/projections")
    assert r.status_code == 200
    proj = r.json()
    assert proj["cumulative_mortality"] == 60
    assert proj["estimated_remaining_population"] == 40


@_postgres_only
async def test_concurrent_transfers_never_overshoot(client: AsyncClient) -> None:
    """Two transfers that together exceed remaining → one succeeds."""
    ctx = await _prepare_active_batch(client, quantity=100)
    dst_unit_id = await _create_unit(client, ctx["site_id"], ctx["unit_type_id"])
    dst_batch_id = await _prepare_receiving_batch(client, dst_unit_id)

    body = {
        "event_type": "TRANSFER",
        "data": transfer_payload(
            source_unit_id=ctx["unit_id"],
            destination_unit_id=dst_unit_id,
            destination_batch_id=dst_batch_id,
            quantity=60,
        ),
    }
    r1, r2 = await asyncio.gather(
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses[0] == 201, (r1.text, r2.text)
    assert statuses[1] == 409, (r1.text, r2.text)

    r = await client.get(f"/api/v1/batches/{ctx['batch_id']}/projections")
    proj = r.json()
    assert proj["cumulative_transfer_out"] == 60
    assert proj["estimated_remaining_population"] == 40


@_postgres_only
async def test_concurrent_final_harvests_only_one_wins(client: AsyncClient) -> None:
    """Two final HARVESTs racing → one 201, one 409."""
    ctx = await _prepare_active_batch(client, quantity=100)
    body = {
        "event_type": "HARVEST",
        "data": harvest_payload(
            quantity=100, total_weight=25.0, harvest_type="total", is_final=True
        ),
    }
    r1, r2 = await asyncio.gather(
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
        client.post(f"/api/v1/batches/{ctx['batch_id']}/events", json=body),
    )
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses[0] == 201, (r1.text, r2.text)
    assert statuses[1] == 409, (r1.text, r2.text)

    # Batch should be HARVESTED with exactly one final HARVEST event.
    r = await client.get(f"/api/v1/batches/{ctx['batch_id']}")
    assert r.status_code == 200
    assert r.json()["state"] == "harvested"

    r = await client.get(
        f"/api/v1/batches/{ctx['batch_id']}/events", params={"event_type": "HARVEST"}
    )
    items = r.json()["items"]
    finals = [e for e in items if e.get("is_final")]
    assert len(finals) == 1
