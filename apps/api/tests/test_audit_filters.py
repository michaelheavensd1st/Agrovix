"""Audit-event filtering + pagination tests."""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from tests._helpers import (
    create_farm,
    create_org,
    create_verified_user,
    switch_user,
)


async def _seed_events(client: AsyncClient) -> dict:
    """Create an owner + 2 farms + delete/restore + invitation to generate
    varied audit events, then return the ids we need for filter tests."""
    owner = f"aud-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(owner)
    await switch_user(client, owner)
    org_id = await create_org(client)
    farm_a = await create_farm(client, org_id, name="AA", code=f"A-{uuid4().hex[:4]}")
    farm_b = await create_farm(client, org_id, name="BB", code=f"B-{uuid4().hex[:4]}")

    # farm.delete + farm.restore on farm_a
    r = await client.delete(f"/api/v1/farms/{farm_a}")
    assert r.status_code == 200
    r = await client.post(f"/api/v1/farms/{farm_a}/restore")
    assert r.status_code == 200

    # farm.delete on farm_b (stays deleted)
    r = await client.delete(f"/api/v1/farms/{farm_b}")
    assert r.status_code == 200

    return {"owner": owner, "org_id": org_id, "farm_a": farm_a, "farm_b": farm_b}


@pytest.mark.asyncio
async def test_default_page_is_bounded_and_ordered(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r = await client.get(f"/api/v1/organizations/{s['org_id']}/audit-events")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "items" in body and "total" in body and "limit" in body and "offset" in body
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert body["total"] >= 5  # org.create + 2x farm.create + 2x farm.delete + farm.restore

    # Deterministic ordering — created_at desc, then id desc.
    ts = [item["created_at"] for item in body["items"]]
    assert ts == sorted(ts, reverse=True), "audit list must be newest-first"


@pytest.mark.asyncio
async def test_filter_by_action(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"action": "farm.delete"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert all(i["action"] == "farm.delete" for i in body["items"])


@pytest.mark.asyncio
async def test_filter_by_entity_type(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"entity_type": "farm"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 5
    assert all(i["entity_type"] == "farm" for i in body["items"])


@pytest.mark.asyncio
async def test_filter_by_farm(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"farm_id": s["farm_a"]},
    )
    assert r.status_code == 200
    body = r.json()
    # farm_a: create + delete + restore = 3
    assert body["total"] == 3
    assert all(i["farm_id"] == s["farm_a"] for i in body["items"])


@pytest.mark.asyncio
async def test_filter_by_actor(client: AsyncClient) -> None:
    s = await _seed_events(client)
    # Look up owner id.
    from app.db import session as _db
    from sqlalchemy import select
    from app.models.user import User
    async with _db.AsyncSessionLocal() as session:
        u = (await session.execute(select(User).where(User.email == s["owner"]))).scalar_one()

    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"actor_id": str(u.id)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 5
    assert all(i["actor_id"] == str(u.id) for i in body["items"])


@pytest.mark.asyncio
async def test_filter_by_date_range(client: AsyncClient) -> None:
    from datetime import datetime, timedelta, timezone
    s = await _seed_events(client)
    # A very tight future window returns nothing.
    future_from = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"occurred_from": future_from},
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0

    # A window that ended yesterday returns nothing either.
    past_to = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"occurred_to": past_to},
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0

    # A wide-enough window returns everything.
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={
            "occurred_from": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "occurred_to": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        },
    )
    assert r.status_code == 200
    assert r.json()["total"] >= 5


@pytest.mark.asyncio
async def test_pagination_is_stable(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r1 = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"limit": 2, "offset": 0},
    )
    r2 = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"limit": 2, "offset": 2},
    )
    assert r1.status_code == 200 and r2.status_code == 200
    b1, b2 = r1.json(), r2.json()
    assert len(b1["items"]) == 2
    assert b1["total"] == b2["total"]

    ids_page_1 = {i["id"] for i in b1["items"]}
    ids_page_2 = {i["id"] for i in b2["items"]}
    assert ids_page_1.isdisjoint(ids_page_2), "pages must not overlap"


@pytest.mark.asyncio
async def test_limit_is_clamped(client: AsyncClient) -> None:
    s = await _seed_events(client)
    r = await client.get(
        f"/api/v1/organizations/{s['org_id']}/audit-events",
        params={"limit": 999},
    )
    # 999 exceeds the 200 cap → 422 from FastAPI Query validator.
    assert r.status_code == 422
