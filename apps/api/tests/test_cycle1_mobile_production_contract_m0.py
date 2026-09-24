"""Cycle 1 backend M0 — focused mobile production contract suite.

This suite intentionally covers the end-to-end seams that AgOS Mobile M1
needs from the API: bearer auth, context scoping, site/unit/batch lifecycle,
event catalog + timeline pagination, authoritative projections, transfer
eligibility, refresh behavior, and idempotent replay/conflict handling.

It is deliberately narrow and reuses the existing canonical payload helpers
and shared factory patterns already exercised elsewhere in the API suite.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from tests._helpers import (
    DEFAULT_PW,
    create_farm,
    create_org,
    create_verified_user,
    feeding_payload,
    invite_and_accept,
    stocking_payload,
    switch_user,
    transfer_payload,
)
from tests.test_codex_review_gate_02 import _prepare_receiving_batch
from tests.test_production_engine import (
    _create_batch,
    _create_unit,
    _new_owner_org_farm,
    _pick_system_unit_type_id,
)

pytestmark = pytest.mark.asyncio


async def _prepare_mobile_batch(client: AsyncClient) -> dict:
    ctx = await _new_owner_org_farm(client)
    unit_type_id = await _pick_system_unit_type_id(client, ctx["org_id"])
    unit_id = await _create_unit(client, ctx["site_id"], unit_type_id)
    batch_id = await _create_batch(client, unit_id)
    return {**ctx, "unit_id": unit_id, "batch_id": batch_id, "unit_type_id": unit_type_id}


async def test_mobile_bearer_auth_and_context_contract(client: AsyncClient) -> None:
    email = f"mobile-auth-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(email)
    await switch_user(client, email)

    org_id = await create_org(client, slug=f"mobile-org-{uuid4().hex[:6]}")
    farm_id = await create_farm(client, org_id, name="Production Farm", code="MOB-1")
    sites = (await client.get(f"/api/v1/farms/{farm_id}/sites")).json()
    assert len(sites) == 1, sites
    assert sites[0]["code"] == "MAIN"

    login = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": DEFAULT_PW},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert login.status_code == 200, login.text
    body = login.json()
    access_token = body["access_token"]
    assert access_token

    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert me.status_code == 200, me.text
    me_body = me.json()
    assert me_body["email"].lower() == email.lower()
    assert me_body["is_active"] is True
    assert any(scope["organization_id"] == org_id for scope in me_body["permission_scopes"])
    assert any(scope["permissions"] for scope in me_body["permission_scopes"])
    assert any(scope["organization_id"] == org_id and scope["farm_id"] is None for scope in me_body["permission_scopes"]) or any(
        scope["organization_id"] == org_id and scope["farm_id"] == farm_id
        for scope in me_body["permission_scopes"]
    )

    refresh = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": body["refresh_token"]},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert refresh.status_code == 200, refresh.text
    refreshed = refresh.json()
    assert refreshed["access_token"]
    assert refreshed["refresh_token"] != body["refresh_token"]


async def test_mobile_batch_contract_event_catalog_and_timeline_are_stable(
    client: AsyncClient,
) -> None:
    ctx = await _prepare_mobile_batch(client)

    catalog = await client.get("/api/v1/production-events/catalog")
    assert catalog.status_code == 200, catalog.text
    codes = {entry["code"] for entry in catalog.json()["entries"]}
    assert {"STOCKING", "FEEDING", "MORTALITY", "SAMPLING", "WATER_QUALITY", "TRANSFER", "HARVEST"}.issubset(codes)

    stocking = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "STOCKING", "data": stocking_payload(quantity=1250)},
    )
    assert stocking.status_code == 201, stocking.text

    batch = await client.get(f"/api/v1/batches/{ctx['batch_id']}")
    assert batch.status_code == 200, batch.text
    assert batch.json()["state"] == "stocked"

    for i in range(3):
        event = await client.post(
            f"/api/v1/batches/{ctx['batch_id']}/events",
            json={"event_type": "FEEDING", "data": feeding_payload(quantity=1.0 + i)},
        )
        assert event.status_code == 201, event.text

    projection = await client.get(f"/api/v1/batches/{ctx['batch_id']}/projections")
    assert projection.status_code == 200, projection.text
    proj = projection.json()
    assert proj["estimated_remaining_population"] == 1250
    assert proj["survival_rate"] >= 0.0

    page1 = await client.get(f"/api/v1/batches/{ctx['batch_id']}/events", params={"limit": 2})
    assert page1.status_code == 200, page1.text
    body1 = page1.json()
    assert len(body1["items"]) == 2
    assert body1["next_cursor"] is not None

    page2 = await client.get(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        params={"limit": 2, "cursor": body1["next_cursor"]},
    )
    assert page2.status_code == 200, page2.text
    body2 = page2.json()
    assert len(body2["items"]) == 2
    assert body2["next_cursor"] is None
    ids1 = {item["id"] for item in body1["items"]}
    ids2 = {item["id"] for item in body2["items"]}
    assert ids1.isdisjoint(ids2)
    times1 = [item["performed_at"] for item in body1["items"]]
    assert times1 == sorted(times1, reverse=True)
    times2 = [item["performed_at"] for item in body2["items"]]
    assert times2 == sorted(times2, reverse=True)


async def test_mobile_transfer_destination_and_idempotency_contract(client: AsyncClient) -> None:
    source = await _prepare_mobile_batch(client)
    destination_site = await client.post(
        f"/api/v1/farms/{source['farm_id']}/sites",
        json={"name": "Destination Site", "code": f"DST-{uuid4().hex[:6]}"},
    )
    assert destination_site.status_code == 201, destination_site.text
    destination_site_id = destination_site.json()["id"]
    destination_unit_id = await _create_unit(client, destination_site_id, source["unit_type_id"])
    destination_batch_id = await _prepare_receiving_batch(client, destination_unit_id, quantity=100)

    source_stocking = await client.post(
        f"/api/v1/batches/{source['batch_id']}/events",
        json={
            "event_type": "STOCKING",
            "data": stocking_payload(quantity=1000),
        },
    )
    assert source_stocking.status_code == 201, source_stocking.text
    source_active = await client.post(
        f"/api/v1/batches/{source['batch_id']}/transitions",
        json={"target_state": "active"},
    )
    assert source_active.status_code == 200, source_active.text

    transfer_request = {
        "event_type": "TRANSFER",
        "data": transfer_payload(
            source_unit_id=source["unit_id"],
            destination_unit_id=destination_unit_id,
            destination_batch_id=destination_batch_id,
            quantity=200,
        ),
    }
    transfer = await client.post(
        f"/api/v1/batches/{source['batch_id']}/events",
        json=transfer_request,
        headers={"Idempotency-Key": "mobile-transfer-1"},
    )
    assert transfer.status_code == 201, transfer.text
    transfer_body = transfer.json()
    assert transfer_body["transfer_role"] == "out"
    assert transfer_body["transfer_id"]

    replay = await client.post(
        f"/api/v1/batches/{source['batch_id']}/events",
        json=transfer_request,
        headers={"Idempotency-Key": "mobile-transfer-1"},
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == transfer_body["id"]

    conflict = await client.post(
        f"/api/v1/batches/{source['batch_id']}/events",
        json={
            "event_type": "TRANSFER",
            "data": {**transfer_request["data"], "quantity": 201},
        },
        headers={"Idempotency-Key": "mobile-transfer-1"},
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "idempotency_key_payload_conflict"

    destinations = await client.get(f"/api/v1/batches/{source['batch_id']}/transfer-destinations")
    assert destinations.status_code == 200, destinations.text
    assert any(item["id"] == destination_batch_id for item in destinations.json())


async def test_mobile_auth_and_tenant_security_contract(client: AsyncClient) -> None:
    ctx = await _prepare_mobile_batch(client)

    bad = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": "totally-not-valid"},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert bad.status_code == 401, bad.text

    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await switch_user(client, outsider)
    await create_org(client, slug=f"outsider-org-{uuid4().hex[:6]}")
    hidden = await client.get(f"/api/v1/batches/{ctx['batch_id']}")
    assert hidden.status_code == 404, hidden.text

    await switch_user(client, ctx["owner"])
    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=viewer,
        org_id=ctx["org_id"],
        role_name="viewer",
    )

    forbidden = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "FEEDING", "data": feeding_payload(quantity=2.0)},
    )
    assert forbidden.status_code == 403, forbidden.text

    await switch_user(client, ctx["owner"])
    invalid_transition = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/transitions",
        json={"target_state": "harvested"},
    )
    assert invalid_transition.status_code == 409, invalid_transition.text

    bad_event = await client.post(
        f"/api/v1/batches/{ctx['batch_id']}/events",
        json={"event_type": "STOCKING", "data": {}},
    )
    assert bad_event.status_code == 422, bad_event.text


async def test_mobile_refresh_and_replay_behaviour_is_revocation_safe(client: AsyncClient) -> None:
    email = f"mobile-refresh-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(email)
    login = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": DEFAULT_PW},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert login.status_code == 200, login.text
    original_refresh = login.json()["refresh_token"]

    refreshed = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": original_refresh},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert refreshed.status_code == 200, refreshed.text
    new_refresh = refreshed.json()["refresh_token"]
    assert new_refresh != original_refresh

    replay = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": original_refresh},
        headers={"X-Agrovix-Auth-Transport": "bearer"},
    )
    assert replay.status_code == 401, replay.text

    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {refreshed.json()['access_token']}"},
    )
    assert me.status_code == 200, me.text
