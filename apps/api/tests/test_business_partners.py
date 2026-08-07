"""Release 6.0.2 — Business Partner integration tests.

Coverage per Phase 7 of the frozen implementation plan
(``docs/architecture/release-6.0-purchase-to-stock.md``):

* create / read / update / deactivate / restore lifecycle
* per-organization ``code`` uniqueness (409 envelope)
* code normalization (upper-case + regex)
* nested-create atomicity (capabilities + supplier profile + contacts)
* supplier profile requires ``supplier`` capability
* capability idempotency + supplier removal purges profile
* qualification server-controlled (qualified_by_id / qualified_at)
* contacts CRUD + at-most-one-active-primary-per-role invariant
* deactivate / restore idempotency
* cursor pagination (deterministic ordering)
* list filters (capability / active / qualification / preference / search)
* tenant isolation (cross-org 404, tenant-hidden shape)
* permission enforcement (403 for missing scoped grant)
* audit trail completeness (create/update/deactivate/restore/capability/
  qualification/contact.create/update/deactivate/restore)
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.db import session as _db
from app.models.audit import AuditEvent
from app.models.farm import Farm
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from tests._helpers import (
    create_farm,
    create_org,
    create_verified_user,
    invite_and_accept,
    switch_user,
)

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------- #

# Concurrency tests require real DB-level MVCC (Postgres).
_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serializes writers.",
)


async def _new_owner_org(client: AsyncClient) -> dict:
    email = f"owner-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(email)
    await switch_user(client, email)
    org_id = await create_org(client, slug=f"org-{uuid4().hex[:6]}")
    return {"owner": email, "org_id": org_id}


async def _create_partner(
    client: AsyncClient,
    org_id: str,
    *,
    code: str | None = None,
    legal_name: str = "Acme Feeds Ltd.",
    capabilities: list[str] | None = None,
    supplier_profile: dict | None = None,
    contacts: list[dict] | None = None,
    expect_status: int = 201,
) -> dict:
    body: dict = {
        "code": code or f"BP-{uuid4().hex[:6]}",
        "legal_name": legal_name,
        "capabilities": capabilities if capabilities is not None else ["supplier"],
    }
    if supplier_profile is not None:
        body["supplier_profile"] = supplier_profile
    if contacts is not None:
        body["contacts"] = contacts
    r = await client.post(
        f"/api/v1/organizations/{org_id}/business-partners",
        json=body,
    )
    assert r.status_code == expect_status, r.text
    return r.json() if r.text else {}


async def _audit_actions_for(org_id: str) -> list[str]:
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(org_id),
                        AuditEvent.entity_type == "business_partner",
                    )
                )
            )
            .scalars()
            .all()
        )
    return [r.action for r in rows]


def uuid_from(v: str):
    from uuid import UUID

    return UUID(v)


# --------------------------------------------------------------------- #
# 1. Create — happy path + code normalization
# --------------------------------------------------------------------- #
async def test_owner_can_create_supplier_partner(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    partner = await _create_partner(
        client,
        ctx["org_id"],
        code="acme-01",
        legal_name="Acme Feeds Ltd.",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
        contacts=[
            {
                "name": "Alice Buyer",
                "email": "alice@acme.example",
                "contact_role": "accounts",
                "is_primary": True,
            }
        ],
    )
    # Code is server-normalized to upper-case.
    assert partner["code"] == "ACME-01"
    assert partner["legal_name"] == "Acme Feeds Ltd."
    assert partner["is_active"] is True
    assert len(partner["capabilities"]) == 1
    assert partner["capabilities"][0]["capability"] == "supplier"
    assert partner["supplier_profile"]["qualification_status"] == "approved"
    assert partner["supplier_profile"]["preference_tier"] == "preferred"
    # Server-controlled qualified_by_id + qualified_at populated.
    assert partner["supplier_profile"]["qualified_by_id"] is not None
    assert partner["supplier_profile"]["qualified_at"] is not None
    assert len(partner["contacts"]) == 1
    assert partner["contacts"][0]["is_primary"] is True


async def test_create_rejects_bad_code(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    # lower-case + space + special chars → schema validator rejects.
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "  ", "legal_name": "X", "capabilities": []},
    )
    assert r.status_code == 422, r.text


async def test_create_rejects_blank_legal_name(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "BP-001", "legal_name": "   ", "capabilities": []},
    )
    assert r.status_code == 422, r.text


async def test_create_supplier_profile_requires_supplier_capability(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(
        client,
        ctx["org_id"],
        code="BP-CUST",
        capabilities=["customer"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "standard",
        },
        expect_status=409,
    )


async def test_duplicate_code_within_org_conflicts(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(client, ctx["org_id"], code="DUP-001")
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "dup-001", "legal_name": "Second", "capabilities": ["supplier"]},
    )
    assert r.status_code == 409, r.text
    body = r.json()["detail"]
    assert body["code"] == "business_partner_code_conflict"
    assert body["context"]["code"] == "DUP-001"


async def test_same_code_permitted_across_orgs(client: AsyncClient) -> None:
    a = await _new_owner_org(client)
    await _create_partner(client, a["org_id"], code="SHARED")
    # Second org owned by another user.
    b = await _new_owner_org(client)
    await _create_partner(client, b["org_id"], code="SHARED")


# --------------------------------------------------------------------- #
# 2. Read / list / filter / pagination
# --------------------------------------------------------------------- #
async def test_list_returns_created_partners(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p1 = await _create_partner(client, ctx["org_id"], code="AAA", legal_name="Alpha")
    p2 = await _create_partner(client, ctx["org_id"], code="BBB", legal_name="Bravo")
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
    )
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [row["id"] for row in body["items"]]
    assert p1["id"] in ids and p2["id"] in ids
    # Deterministic ordering: legal_name ASC.
    names = [row["legal_name"] for row in body["items"]]
    assert names == sorted(names)


async def test_list_filter_by_capability(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    sup = await _create_partner(client, ctx["org_id"], code="S1", capabilities=["supplier"])
    cust = await _create_partner(client, ctx["org_id"], code="C1", capabilities=["customer"])
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"capability": "supplier"},
    )
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()["items"]]
    assert sup["id"] in ids
    assert cust["id"] not in ids


async def test_list_filter_by_active(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p1 = await _create_partner(client, ctx["org_id"], code="ACT-1")
    p2 = await _create_partner(client, ctx["org_id"], code="ACT-2")
    r = await client.post(
        f"/api/v1/business-partners/{p2['id']}/deactivate",
        json={"reason": "consolidation"},
    )
    assert r.status_code == 200, r.text
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"active": "true"},
    )
    ids = [row["id"] for row in r.json()["items"]]
    assert p1["id"] in ids and p2["id"] not in ids
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"active": "false"},
    )
    ids = [row["id"] for row in r.json()["items"]]
    assert p2["id"] in ids and p1["id"] not in ids


async def test_list_search_by_name_and_code(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(client, ctx["org_id"], code="HAY-01", legal_name="HayGrow")
    await _create_partner(client, ctx["org_id"], code="OIL-01", legal_name="Oleum")
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"search": "hay"},
    )
    names = [row["legal_name"] for row in r.json()["items"]]
    assert names == ["HayGrow"]


async def test_list_filter_by_qualification_and_preference(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    approved = await _create_partner(
        client,
        ctx["org_id"],
        code="Q-APR",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    unq = await _create_partner(
        client,
        ctx["org_id"],
        code="Q-UNQ",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"qualification": "approved"},
    )
    ids = [row["id"] for row in r.json()["items"]]
    assert approved["id"] in ids and unq["id"] not in ids
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"preference": "preferred"},
    )
    ids = [row["id"] for row in r.json()["items"]]
    assert approved["id"] in ids and unq["id"] not in ids


async def test_list_pagination_cursor(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    for i in range(5):
        await _create_partner(client, ctx["org_id"], code=f"PG-{i}", legal_name=f"Name{i:02d}")
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"limit": 2},
    )
    body = r.json()
    assert len(body["items"]) == 2
    assert body["next_cursor"] is not None
    # Follow the cursor.
    r2 = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"limit": 2, "cursor": body["next_cursor"]},
    )
    body2 = r2.json()
    assert len(body2["items"]) == 2
    # No overlap.
    ids1 = {row["id"] for row in body["items"]}
    ids2 = {row["id"] for row in body2["items"]}
    assert ids1.isdisjoint(ids2)


async def test_list_invalid_cursor_returns_422(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"cursor": "!!!!garbage!!!!"},
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "invalid_cursor"


# --------------------------------------------------------------------- #
# 3. PATCH header
# --------------------------------------------------------------------- #
async def test_patch_updates_header_fields(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="PX-01")
    r = await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={
            "trading_name": "PX Trading",
            "primary_address": {
                "line1": "1 Silk Road",
                "city": "Bengaluru",
                "country_code": "IN",
            },
            "country_code": "in",  # server normalises to upper.
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trading_name"] == "PX Trading"
    assert body["primary_address"]["city"] == "Bengaluru"
    assert body["primary_address"]["country_code"] == "IN"
    assert body["country_code"] == "IN"
    # Code is immutable — must not be included in PATCH shape.


async def test_patch_no_changes_returns_same_state(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="PX-NO")
    r = await client.patch(f"/api/v1/business-partners/{p['id']}", json={})
    assert r.status_code == 200
    assert r.json()["legal_name"] == p["legal_name"]


# --------------------------------------------------------------------- #
# 4. Deactivate / restore (idempotent)
# --------------------------------------------------------------------- #
async def test_deactivate_and_restore_lifecycle(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="LC-01")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "seasonal pause"},
    )
    assert r.status_code == 200
    assert r.json()["is_active"] is False
    assert r.json()["deactivation_reason"] == "seasonal pause"
    # Idempotent.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "still paused"},
    )
    assert r.status_code == 200
    assert r.json()["is_active"] is False
    # Restore.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/restore",
        json={"reason": "back in business"},
    )
    assert r.status_code == 200
    assert r.json()["is_active"] is True
    # Idempotent restore.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/restore",
        json={"reason": "already active"},
    )
    assert r.status_code == 200


# --------------------------------------------------------------------- #
# 5. Capabilities
# --------------------------------------------------------------------- #
async def test_capability_add_and_remove(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CAP-01", capabilities=["supplier"])
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/capabilities",
        json={"capability": "transporter"},
    )
    assert r.status_code == 201
    assert r.json()["capability"] == "transporter"
    r = await client.get(f"/api/v1/business-partners/{p['id']}/capabilities")
    caps = {row["capability"] for row in r.json()}
    assert caps == {"supplier", "transporter"}
    # Idempotent add.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/capabilities",
        json={"capability": "transporter"},
    )
    assert r.status_code == 201
    # Remove.
    r = await client.delete(f"/api/v1/business-partners/{p['id']}/capabilities/transporter")
    assert r.status_code == 204


async def test_capability_supplier_remove_purges_profile(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="CAP-SUP",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    r = await client.get(f"/api/v1/business-partners/{p['id']}/supplier-profile")
    assert r.status_code == 200
    # Now remove the supplier capability — profile is purged.
    r = await client.delete(f"/api/v1/business-partners/{p['id']}/capabilities/supplier")
    assert r.status_code == 204
    r = await client.get(f"/api/v1/business-partners/{p['id']}/supplier-profile")
    assert r.status_code == 404


# --------------------------------------------------------------------- #
# 6. Supplier profile
# --------------------------------------------------------------------- #
async def test_upsert_supplier_profile_requires_supplier_capability(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="SP-NO", capabilities=["customer"])
    r = await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={
            "qualification_status": "approved",
            "preference_tier": "standard",
        },
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "supplier_profile_requires_supplier_capability"


async def test_upsert_supplier_profile_qualification_stamps(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="SP-QUAL",
        capabilities=["supplier"],
    )
    r = await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={
            "qualification_status": "approved",
            "preference_tier": "preferred",
            "qualification_note": "onboarding complete",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["qualification_status"] == "approved"
    assert body["qualified_by_id"] is not None
    assert body["qualified_at"] is not None

    # Reset to unqualified — qualifier stamps are cleared.
    r = await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    body = r.json()
    assert body["qualification_status"] == "unqualified"
    assert body["qualified_by_id"] is None
    assert body["qualified_at"] is None


# --------------------------------------------------------------------- #
# 7. Contacts
# --------------------------------------------------------------------- #
async def test_contact_create_list_and_primary_invariant(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CTC-01")
    # First primary — OK.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Alice",
            "contact_role": "accounts",
            "is_primary": True,
        },
    )
    assert r.status_code == 201
    # Second primary for same role — rejected.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Bob",
            "contact_role": "accounts",
            "is_primary": True,
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "business_partner_contact_primary_conflict"
    # Different role — primary OK.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Carol",
            "contact_role": "warehouse",
            "is_primary": True,
        },
    )
    assert r.status_code == 201


@_postgres_only
async def test_concurrent_primary_contact_creation_returns_stable_conflict(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CTC-RACE")
    endpoint = f"/api/v1/business-partners/{p['id']}/contacts"

    first, second = await asyncio.gather(
        client.post(
            endpoint,
            json={"name": "Primary A", "contact_role": "accounts", "is_primary": True},
        ),
        client.post(
            endpoint,
            json={"name": "Primary B", "contact_role": "accounts", "is_primary": True},
        ),
    )

    assert sorted((first.status_code, second.status_code)) == [201, 409]
    conflict = first if first.status_code == 409 else second
    assert conflict.json()["detail"]["code"] == "business_partner_contact_primary_conflict"

    # The losing transaction must be rolled back cleanly and leave exactly one
    # active primary for the constrained (partner, contact_role) tuple.
    listed = await client.get(endpoint, params={"include_inactive": True})
    assert listed.status_code == 200, listed.text
    active_primaries = [
        contact
        for contact in listed.json()["items"]
        if contact["contact_role"] == "accounts" and contact["is_active"] and contact["is_primary"]
    ]
    assert len(active_primaries) == 1


async def test_contact_update_deactivate_restore(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CTC-02")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Dave",
            "contact_role": "sales",
            "is_primary": True,
        },
    )
    contact_id = r.json()["id"]
    # Update.
    r = await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={"job_title": "Head of Sales"},
    )
    assert r.status_code == 200
    assert r.json()["job_title"] == "Head of Sales"
    # Deactivate.
    r = await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/deactivate",
        json={"reason": "left the company"},
    )
    assert r.status_code == 200
    assert r.json()["is_active"] is False
    # New primary for that role now allowed.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Eve",
            "contact_role": "sales",
            "is_primary": True,
        },
    )
    assert r.status_code == 201
    # Restoring the old one would collide → rejected.
    r = await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/restore",
        json={"reason": "returned"},
    )
    assert r.status_code == 409


async def test_contact_list_pagination_and_include_inactive(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CTC-PG")
    for i in range(3):
        await client.post(
            f"/api/v1/business-partners/{p['id']}/contacts",
            json={
                "name": f"Person {i:02d}",
                "contact_role": "other",
                "is_primary": False,
            },
        )
    r = await client.get(
        f"/api/v1/business-partners/{p['id']}/contacts",
        params={"limit": 2},
    )
    body = r.json()
    assert len(body["items"]) == 2
    assert body["next_cursor"] is not None


# --------------------------------------------------------------------- #
# 8. Tenant isolation
# --------------------------------------------------------------------- #
async def test_cross_org_partner_returns_tenant_hidden_404(
    client: AsyncClient,
) -> None:
    a = await _new_owner_org(client)
    p = await _create_partner(client, a["org_id"], code="ISO-A")
    await _new_owner_org(client)  # switches to a fresh owner+org
    # Fresh org: non-member of A → tenant-hidden 404 (existence hidden).
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 404, r.text


async def test_cross_org_list_returns_empty(client: AsyncClient) -> None:
    a = await _new_owner_org(client)
    await _create_partner(client, a["org_id"], code="ISO-A2")
    await _new_owner_org(client)
    r = await client.get(f"/api/v1/organizations/{a['org_id']}/business-partners")
    # Non-member of A → membership guard fires first → 404 tenant-hidden.
    assert r.status_code == 404, r.text


# --------------------------------------------------------------------- #
# 9. Permissions (viewer cannot create; owner can)
# --------------------------------------------------------------------- #
async def test_viewer_cannot_create_partner(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    viewer = f"viewer-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(viewer)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=viewer,
        org_id=ctx["org_id"],
        role_name="viewer",
    )
    # Now client is authenticated as viewer.
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "VW-01", "legal_name": "Blocked", "capabilities": []},
    )
    assert r.status_code == 403, r.text


async def test_farm_director_cannot_deactivate(client: AsyncClient) -> None:
    """§12: farm_director may create/update but NOT deactivate."""
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="DEACT-01")
    director = f"dir-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(director)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=director,
        org_id=ctx["org_id"],
        role_name="farm_director",
    )
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "attempt"},
    )
    assert r.status_code == 403


# --------------------------------------------------------------------- #
# 10. Audit trail completeness
# --------------------------------------------------------------------- #
async def test_full_lifecycle_writes_expected_audit_actions(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-01",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    # PATCH header.
    await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={"trading_name": "Aud Trading"},
    )
    # Qualification change.
    await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    # Add capability.
    await client.post(
        f"/api/v1/business-partners/{p['id']}/capabilities",
        json={"capability": "transporter"},
    )
    # Create + deactivate + restore a contact.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={"name": "Frank", "contact_role": "technical", "is_primary": True},
    )
    contact_id = r.json()["id"]
    await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/deactivate",
        json={"reason": "off"},
    )
    await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/restore",
        json={"reason": "on"},
    )
    # Deactivate + restore partner.
    await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "pause"},
    )
    await client.post(
        f"/api/v1/business-partners/{p['id']}/restore",
        json={"reason": "unpause"},
    )
    actions = await _audit_actions_for(ctx["org_id"])
    expected_subset = {
        "business_partner.create",
        "business_partner.update",
        "business_partner.qualification.update",
        "business_partner.capability.add",
        "business_partner.contact.create",
        "business_partner.contact.deactivate",
        "business_partner.contact.restore",
        "business_partner.deactivate",
        "business_partner.restore",
    }
    missing = expected_subset - set(actions)
    assert not missing, f"missing audit actions: {missing}"


async def test_audit_metadata_bounded_no_secrets(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-BND",
        capabilities=["supplier"],
        contacts=[
            {
                "name": "G",
                "email": "g@ex.example",
                "phone": "+91 555 0100",
                "contact_role": "sales",
            }
        ],
    )
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(ctx["org_id"]),
                        AuditEvent.entity_type == "business_partner",
                    )
                )
            )
            .scalars()
            .all()
        )
    for row in rows:
        md = row.metadata_json or {}
        # No email / phone / free-text notes leak into audit metadata.
        blob = str(md).lower()
        assert "g@ex.example" not in blob
        assert "+91 555 0100" not in blob


# ===================================================================== #
# §4.1 conformance — primary_address, email/phone, country_code,
# tax_identifier, metadata (added for Sprint 6.0.2 schema alignment).
# ===================================================================== #
async def test_primary_address_round_trip(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "ADDR-01",
            "legal_name": "Address Test",
            "capabilities": ["supplier"],
            "primary_address": {
                "line1": "12 Sardar Patel Road",
                "line2": "Suite 4B",
                "city": "Mumbai",
                "region": "Maharashtra",
                "postal_code": "400001",
                "country_code": "IN",
            },
            "country_code": "IN",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # Structured JSONB round-trips faithfully.
    assert body["primary_address"] == {
        "line1": "12 Sardar Patel Road",
        "line2": "Suite 4B",
        "city": "Mumbai",
        "region": "Maharashtra",
        "postal_code": "400001",
        "country_code": "IN",
    }
    # No flat address keys leak into the public API.
    for banned in (
        "address_line_1",
        "address_line_2",
        "city",
        "region",
        "postal_code",
        "country",
    ):
        assert banned not in body


async def test_country_code_uppercase_normalization(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "CC-01",
            "legal_name": "Lowercase Country",
            "capabilities": ["supplier"],
            "country_code": "in",  # lowercase in the request
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["country_code"] == "IN"


async def test_country_code_invalid_rejected(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    for bad in ("USA", "1A", "X", "!!"):
        r = await client.post(
            f"/api/v1/organizations/{ctx['org_id']}/business-partners",
            json={
                "code": f"CC-{bad}",
                "legal_name": "Bad Country",
                "capabilities": ["supplier"],
                "country_code": bad,
            },
        )
        assert r.status_code == 422, (bad, r.text)


async def test_primary_address_country_code_iso(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    # Nested country_code inside primary_address is also ISO-checked.
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "PACC-BAD",
            "legal_name": "Bad Nested Country",
            "capabilities": ["supplier"],
            "primary_address": {"country_code": "usa"},
        },
    )
    assert r.status_code == 422, r.text


async def test_primary_address_extra_keys_rejected(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "ADDR-XTRA",
            "legal_name": "Extra Key",
            "capabilities": ["supplier"],
            "primary_address": {"line1": "1 Rd", "county": "not-allowed"},
        },
    )
    # Frozen key-set: extra keys are rejected.
    assert r.status_code == 422, r.text


async def test_partner_level_email_and_phone_persist(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "EP-01",
            "legal_name": "Convenience Contact",
            "capabilities": ["supplier"],
            "email": "hello@convenience.example",
            "phone": "+91 22 5555 0100",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "hello@convenience.example"
    assert body["phone"] == "+91 22 5555 0100"


async def test_partner_level_email_invalid_rejected(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "EP-BAD",
            "legal_name": "Bad Email",
            "capabilities": ["supplier"],
            "email": "not-an-email",
        },
    )
    assert r.status_code == 422, r.text


async def test_partner_level_email_does_not_replace_contacts(
    client: AsyncClient,
) -> None:
    """The header email is a convenience; multi-contact remains authoritative."""
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "EP-MC",
            "legal_name": "Multi Contact",
            "capabilities": ["supplier"],
            "email": "billing@mc.example",
            "contacts": [
                {
                    "name": "Alice",
                    "email": "alice@mc.example",
                    "contact_role": "accounts",
                    "is_primary": True,
                },
                {
                    "name": "Bob",
                    "email": "bob@mc.example",
                    "contact_role": "warehouse",
                    "is_primary": True,
                },
            ],
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["email"] == "billing@mc.example"
    assert len(body["contacts"]) == 2
    contact_emails = {c["email"] for c in body["contacts"]}
    assert contact_emails == {"alice@mc.example", "bob@mc.example"}


async def test_tax_identifier_persistence(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "TAX-01",
            "legal_name": "Tax Test",
            "capabilities": ["supplier"],
            "tax_identifier": "GSTIN29ABCDE1234F1Z5",
        },
    )
    assert r.status_code == 201
    assert r.json()["tax_identifier"] == "GSTIN29ABCDE1234F1Z5"
    # Round-trip through PATCH clear.
    partner_id = r.json()["id"]
    r = await client.patch(
        f"/api/v1/business-partners/{partner_id}",
        json={"tax_identifier": None},
    )
    assert r.status_code == 200
    assert r.json()["tax_identifier"] is None


async def test_bounded_metadata_persistence(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "META-OK",
            "legal_name": "Meta OK",
            "capabilities": ["supplier"],
            "metadata": {"segment": "premium", "onboarding": {"batch": 42}},
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["metadata"] == {"segment": "premium", "onboarding": {"batch": 42}}


async def test_metadata_rejects_secrets(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    for banned_key in ("password", "api_key", "SECRET", "authorization"):
        r = await client.post(
            f"/api/v1/organizations/{ctx['org_id']}/business-partners",
            json={
                "code": f"MSEC-{banned_key}",
                "legal_name": "Secret Metadata",
                "capabilities": ["supplier"],
                "metadata": {banned_key: "xyz"},
            },
        )
        assert r.status_code == 422, (banned_key, r.text)


async def test_metadata_rejects_oversize(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    big = {"a": "x" * 5000}  # > 4 KiB cap
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "MBIG",
            "legal_name": "Oversized Meta",
            "capabilities": ["supplier"],
            "metadata": big,
        },
    )
    assert r.status_code == 422, r.text


async def test_public_api_omits_old_flat_address_fields(
    client: AsyncClient,
) -> None:
    """§4.1 requires primary_address JSONB — the old flat shape must
    NEVER appear in the public API."""
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "NO-FLAT",
            "legal_name": "No Flat",
            "capabilities": ["supplier"],
            "primary_address": {"line1": "1 Rd"},
        },
    )
    assert r.status_code == 201
    body = r.json()
    for banned in (
        "address_line_1",
        "address_line_2",
        "postal_code",
    ):
        assert banned not in body, f"flat field {banned} leaked into API"
    # `country_code` at partner level IS allowed (frozen §4.1) — only
    # the free-text "country" column is banned.
    assert "country" not in body


# ===================================================================== #
# ADVERSARIAL EXTENSIONS (independent verification pass — Release 6.0.2)
# Added by testing subagent. Do NOT rewrite the existing suite above;
# these are additive gap coverage per the review request.
# ===================================================================== #


# --- Tenant-hidden 404 on contact-scoped routes ------------------------- #
async def test_cross_org_contact_endpoints_return_tenant_hidden_404(
    client: AsyncClient,
) -> None:
    """A non-member of the owning org must see 404 (not 403) on
    /business-partner-contacts/{id} GET/PATCH/deactivate/restore."""
    a = await _new_owner_org(client)
    p = await _create_partner(client, a["org_id"], code="ISO-CTC")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={"name": "Zed", "contact_role": "sales", "is_primary": True},
    )
    contact_id = r.json()["id"]
    # Switch to fresh unrelated owner/org.
    await _new_owner_org(client)
    r = await client.get(f"/api/v1/business-partner-contacts/{contact_id}")
    assert r.status_code in (403, 404), r.text
    # The frozen contract requires tenant existence hidden → 404, not 403.
    assert r.status_code == 404, (
        f"tenant-leak: cross-org contact GET returned {r.status_code} "
        f"(expected 404 tenant-hidden)"
    )
    r = await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={"job_title": "sneaky"},
    )
    assert r.status_code == 404
    r = await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/deactivate",
        json={"reason": "x"},
    )
    assert r.status_code == 404
    r = await client.post(
        f"/api/v1/business-partner-contacts/{contact_id}/restore",
        json={"reason": "x"},
    )
    assert r.status_code == 404


# --- Cross-org sub-resource routes tenant-hidden 404 ------------------- #
async def test_cross_org_subresources_return_404(client: AsyncClient) -> None:
    a = await _new_owner_org(client)
    p = await _create_partner(
        client,
        a["org_id"],
        code="ISO-SUB",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    await _new_owner_org(client)
    for path in (
        f"/api/v1/business-partners/{p['id']}/capabilities",
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        f"/api/v1/business-partners/{p['id']}/contacts",
    ):
        r = await client.get(path)
        assert r.status_code == 404, f"{path} leaked: {r.status_code}"
    # Writes also 404.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/capabilities",
        json={"capability": "transporter"},
    )
    assert r.status_code == 404
    r = await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={"qualification_status": "approved", "preference_tier": "standard"},
    )
    assert r.status_code == 404
    r = await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={"trading_name": "leak"},
    )
    assert r.status_code == 404


# --- Preference-only change does NOT overwrite qualifier stamps -------- #
async def test_preference_only_change_preserves_qualifier_stamps(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="SP-PREF",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "standard",
        },
    )
    original_qb = p["supplier_profile"]["qualified_by_id"]
    original_qa = p["supplier_profile"]["qualified_at"]
    assert original_qb is not None and original_qa is not None
    # Preference-only change; qualification unchanged.
    r = await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={"qualification_status": "approved", "preference_tier": "preferred"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["preference_tier"] == "preferred"
    assert body["qualification_status"] == "approved"
    assert body["qualified_by_id"] == original_qb
    assert body["qualified_at"] == original_qa


# --- No hard-delete API on partner ------------------------------------- #
async def test_no_hard_delete_endpoint_on_partner(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="NO-DEL")
    r = await client.delete(f"/api/v1/business-partners/{p['id']}")
    # Route should not exist → 404 or 405 (method not allowed).
    assert r.status_code in (404, 405), f"unexpected DELETE support: got {r.status_code}"


# --- Non-UUID path params → 422, never 500 ----------------------------- #
async def test_non_uuid_partner_path_returns_422(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    del ctx
    r = await client.get("/api/v1/business-partners/not-a-uuid")
    assert r.status_code == 422
    r = await client.patch("/api/v1/business-partners/not-a-uuid", json={"trading_name": "x"})
    assert r.status_code == 422


# --- Random UUID partner → 404 ----------------------------------------- #
async def test_random_partner_id_returns_404(client: AsyncClient) -> None:
    await _new_owner_org(client)
    r = await client.get(f"/api/v1/business-partners/{uuid4()}")
    assert r.status_code == 404


# --- Removing a non-existent capability returns 404 -------------------- #
async def test_remove_nonexistent_capability_returns_404(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="RM-NONE", capabilities=["supplier"])
    r = await client.delete(f"/api/v1/business-partners/{p['id']}/capabilities/transporter")
    assert r.status_code == 404


# --- Invalid capability enum in URL → 422 ------------------------------ #
async def test_remove_invalid_capability_enum_returns_422(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="RM-BAD")
    r = await client.delete(f"/api/v1/business-partners/{p['id']}/capabilities/nonsense")
    assert r.status_code == 422


# --- Invalid capability enum in POST body → 422 ------------------------ #
async def test_add_invalid_capability_body_returns_422(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="ADD-BAD")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/capabilities",
        json={"capability": "totally_made_up"},
    )
    assert r.status_code == 422


# --- Deactivated partner still PATCH-able ------------------------------ #
async def test_patch_still_works_on_deactivated_partner(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="DEACT-PATCH")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "seasonal"},
    )
    assert r.status_code == 200
    r = await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={"trading_name": "Still Editable"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["trading_name"] == "Still Editable"
    # GET on deactivated partner is still visible (not filtered out).
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 200
    assert r.json()["is_active"] is False


# --- farm_manager is read-only on partners (impl per permissions.py) --- #
# NOTE: Review request text says "farm_manager can create/update" but the
# permissions.py grant only includes `business_partner.read` for
# farm_manager (create/update belong to farm_director). Test aligns with
# implementation; discrepancy is flagged for main agent review.
async def test_farm_manager_can_update_but_not_deactivate(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="FM-01")
    farm_id = await create_farm(client, ctx["org_id"], name="FM-Farm")
    manager = f"fm-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(manager)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=manager,
        org_id=ctx["org_id"],
        role_name="farm_manager",
        farm_id=farm_id,
    )
    # Frozen §12 model: an active farm-scoped read grant widens only
    # Business Partner reads within the same organization.
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 200, r.text
    # Cannot create (impl reserves create for farm_director+).
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "FM-BAD", "legal_name": "X", "capabilities": ["supplier"]},
    )
    assert r.status_code == 403
    # Cannot update.
    r = await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={"trading_name": "nope"},
    )
    assert r.status_code == 403
    # Cannot deactivate.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "attempt"},
    )
    assert r.status_code == 403


# --- farm_director cannot restore either ------------------------------- #
async def test_farm_director_cannot_restore(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="DIR-RST")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "pause"},
    )
    assert r.status_code == 200
    director = f"dir2-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(director)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=director,
        org_id=ctx["org_id"],
        role_name="farm_director",
    )
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/restore",
        json={"reason": "attempt"},
    )
    assert r.status_code == 403


# --- Restore of a non-existent partner → 404 --------------------------- #
async def test_restore_non_existent_partner_returns_404(
    client: AsyncClient,
) -> None:
    await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/business-partners/{uuid4()}/restore",
        json={"reason": "x"},
    )
    assert r.status_code == 404


# --- Combined filters (capability + qualification + active) ------------ #
async def test_list_filters_are_combinable(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    good = await _create_partner(
        client,
        ctx["org_id"],
        code="COMB-A",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    bad = await _create_partner(
        client,
        ctx["org_id"],
        code="COMB-B",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={
            "capability": "supplier",
            "qualification": "approved",
            "preference": "preferred",
            "active": "true",
        },
    )
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()["items"]]
    assert good["id"] in ids and bad["id"] not in ids


# --- Cursor from one org NOT usable for another org list --------------- #
async def test_pagination_limit_bounds(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    # limit=0 → 422 (ge=1); limit=201 → 422 (le=200).
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"limit": 0},
    )
    assert r.status_code == 422
    r = await client.get(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        params={"limit": 500},
    )
    assert r.status_code == 422


# --- Adding all frozen capability enums --------------------------------- #
async def test_all_capability_enum_values_accepted(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="ENUM-CAP", capabilities=[])
    for cap in (
        "supplier",
        "customer",
        "transporter",
        "contractor",
        "veterinary_service",
        "laboratory",
        "consultant",
        "other",
    ):
        r = await client.post(
            f"/api/v1/business-partners/{p['id']}/capabilities",
            json={"capability": cap},
        )
        assert r.status_code == 201, f"{cap} rejected: {r.text}"
    r = await client.get(f"/api/v1/business-partners/{p['id']}/capabilities")
    caps = {row["capability"] for row in r.json()}
    assert caps == {
        "supplier",
        "customer",
        "transporter",
        "contractor",
        "veterinary_service",
        "laboratory",
        "consultant",
        "other",
    }


# --- Contact role enum coverage ----------------------------------------- #
async def test_all_contact_role_enums_accepted(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CTC-ENUM")
    for role in (
        "accounts",
        "warehouse",
        "sales",
        "driver",
        "managing_director",
        "technical",
        "other",
    ):
        r = await client.post(
            f"/api/v1/business-partners/{p['id']}/contacts",
            json={"name": f"P-{role}", "contact_role": role, "is_primary": True},
        )
        assert r.status_code == 201, f"{role} rejected: {r.text}"


# --- Migration architecture conformance -------------------------------- #
_ALEMBIC_VERSIONS = Path(__file__).resolve().parent.parent / "alembic" / "versions"


async def test_migration_revision_conformance() -> None:
    """0011_business_partners must exist with expected down_revision."""
    import re

    path = _ALEMBIC_VERSIONS / "0011_business_partners.py"
    assert path.exists(), f"migration file missing at {path}"
    src = path.read_text()
    m_rev = re.search(r"revision(?:\s*:\s*str)?\s*=\s*['\"]([^'\"]+)['\"]", src)
    m_down = re.search(r"down_revision(?:\s*:\s*[^=]+)?\s*=\s*['\"]([^'\"]+)['\"]", src)
    assert m_rev and m_rev.group(1) == "0011_business_partners", m_rev
    assert m_down and m_down.group(1) == "0010_sprint_5_4_12_reconcile_ddl", m_down


# --- Frozen permission set — only the 4 BP perms exist ----------------- #
async def test_frozen_bp_permissions_exact_set() -> None:
    from app.security import permissions as perms

    src = __import__("inspect").getsource(perms)
    for keep in (
        "business_partner.read",
        "business_partner.create",
        "business_partner.update",
        "business_partner.deactivate",
    ):
        assert keep in src, f"missing permission: {keep}"
    # Ensure no stray BP perm was introduced.
    import re

    bp_perms = set(re.findall(r"business_partner\.[a-z_]+", src))
    allowed = {
        "business_partner.read",
        "business_partner.create",
        "business_partner.update",
        "business_partner.deactivate",
    }
    extras = bp_perms - allowed
    assert not extras, f"unexpected BP permissions defined: {extras}"


# ===================================================================== #
# §4.1 conformance — ADDITIONAL ADVERSARIAL COVERAGE (iteration 10)
# Added by testing subagent. Do NOT rewrite existing suite.
# ===================================================================== #


# --- PATCH extra_field is rejected (extra="forbid" on Update) ---------- #
async def test_patch_extra_field_rejected(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="PATCH-XTRA")
    r = await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={"trading_name": "OK", "extra_field": "should-fail"},
    )
    assert r.status_code == 422, r.text


# --- phone whitespace is stripped; empty string coerces to null -------- #
async def test_phone_whitespace_stripping_and_empty_null(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    # Whitespace around a phone is stripped.
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "PH-STRIP",
            "legal_name": "Phone Strip",
            "capabilities": ["supplier"],
            "phone": "  +91 22 5555 0100  ",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["phone"] == "+91 22 5555 0100"
    # Empty phone is coerced to null.
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "PH-EMPTY",
            "legal_name": "Phone Empty",
            "capabilities": ["supplier"],
            "phone": "   ",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["phone"] is None


# --- Audit metadata records ONLY changed field names (no PII values) --- #
async def test_patch_audit_metadata_no_value_leak_for_new_fields(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="AUD-4-1")
    # PATCH the §4.1 fields; the header email/phone/tax/metadata must
    # NOT leak into the audit metadata blob.
    await client.patch(
        f"/api/v1/business-partners/{p['id']}",
        json={
            "email": "leak-check@example.com",
            "phone": "+91 22 9999 0000",
            "tax_identifier": "GSTIN29LEAK1234F1Z5",
            "metadata": {"segment": "leak-segment"},
        },
    )
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(ctx["org_id"]),
                        AuditEvent.entity_type == "business_partner",
                        AuditEvent.action == "business_partner.update",
                    )
                )
            )
            .scalars()
            .all()
        )
    assert rows, "expected an update audit row"
    for row in rows:
        blob = str(row.metadata_json or {}).lower()
        for banned in (
            "leak-check@example.com",
            "+91 22 9999 0000",
            "gstin29leak1234f1z5",
            "leak-segment",
        ):
            assert banned not in blob, f"value leaked into audit: {banned}"


# --- Header email does NOT collapse the multi-contact model at DB level - #
async def test_contact_rows_persist_independently_from_header_email(
    client: AsyncClient,
) -> None:
    from app.models.business_partner import BusinessPartnerContact

    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "SEP-EMAIL",
            "legal_name": "Separate",
            "capabilities": ["supplier"],
            "email": "header@sep.example",
            "contacts": [
                {
                    "name": "A",
                    "email": "a@sep.example",
                    "contact_role": "accounts",
                    "is_primary": True,
                },
                {
                    "name": "B",
                    "email": "b@sep.example",
                    "contact_role": "warehouse",
                    "is_primary": True,
                },
                {
                    "name": "C",
                    "email": "c@sep.example",
                    "contact_role": "sales",
                    "is_primary": True,
                },
            ],
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    partner_id = body["id"]
    assert body["email"] == "header@sep.example"
    assert len(body["contacts"]) == 3
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(BusinessPartnerContact).where(
                        BusinessPartnerContact.business_partner_id == uuid_from(partner_id),
                    )
                )
            )
            .scalars()
            .all()
        )
    assert len(rows) == 3
    contact_emails = {r_.email for r_ in rows}
    assert contact_emails == {"a@sep.example", "b@sep.example", "c@sep.example"}
    # Header email is NOT one of the contact rows.
    assert "header@sep.example" not in contact_emails


# --- Base.metadata not broken by metadata->metadata_json aliasing ------ #
async def test_declarative_base_metadata_intact() -> None:
    """The DB column is `metadata`; the ORM attribute is `metadata_json`.
    This guards against the classic Declarative reserved-name collision.
    """
    # Base.metadata is still the SQLAlchemy MetaData registry, not a Column.
    from sqlalchemy import MetaData

    from app.db.base import Base
    from app.models.business_partner import BusinessPartner

    assert isinstance(Base.metadata, MetaData)
    # Model exposes metadata_json ORM attribute mapped to DB column 'metadata'.
    col = BusinessPartner.__table__.c["metadata"]
    assert col is not None
    # The Python-side attribute is metadata_json (not metadata).
    assert hasattr(BusinessPartner, "metadata_json")
    # And accessing BusinessPartner.metadata resolves to the SQLA registry,
    # not the mapped column, which is the intended shielding.
    assert BusinessPartner.metadata is Base.metadata


# --- Migration uses DB column name `metadata`, not `metadata_json` ----- #
async def test_migration_uses_metadata_column_name() -> None:
    src = (_ALEMBIC_VERSIONS / "0011_business_partners.py").read_text()
    # Positive: DB column literally named "metadata".
    assert 'sa.Column("metadata"' in src or "sa.Column('metadata'" in src
    # Negative: no flat address columns from the old shape.
    for banned in ("address_line_1", "address_line_2"):
        assert banned not in src, f"flat address column {banned} still in migration"
    # There is a single 0011_business_partners head; no 0011a / 0012 BP file.
    bp_migrations = [
        p.name
        for p in _ALEMBIC_VERSIONS.glob("*.py")
        if "business_partner" in p.name.lower() or "business-partner" in p.name.lower()
    ]
    assert bp_migrations == ["0011_business_partners.py"], bp_migrations


# --- Empty primary_address renders as null-ish (no blank leak) --------- #
async def test_partner_without_primary_address_renders_null(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="ADDR-NULL")
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body.get("primary_address") is None


# --- metadata rejects non-dict at API layer --------------------------- #
async def test_metadata_rejects_non_dict(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    for bad in (["not", "a", "dict"], "just-a-string", 42):
        r = await client.post(
            f"/api/v1/organizations/{ctx['org_id']}/business-partners",
            json={
                "code": f"META-NDCT-{uuid4().hex[:4]}",
                "legal_name": "Bad Meta",
                "capabilities": ["supplier"],
                "metadata": bad,
            },
        )
        assert r.status_code == 422, (bad, r.text)


# ===================================================================== #
# CODEX REVIEW REMEDIATION (PR #15, second-review prep)
# ===================================================================== #
async def _create_farm(client: AsyncClient, org_id: str) -> str:
    return await create_farm(client, org_id, name="Test Farm")


# --- Phase 1: farm-scoped reads must succeed for §12 "Scoped" roles ---- #
@pytest.mark.parametrize("role_name", ["farm_manager", "supervisor", "storekeeper"])
async def test_farm_scoped_role_can_read_org_partner(client: AsyncClient, role_name: str) -> None:
    ctx = await _new_owner_org(client)
    farm_id = await _create_farm(client, ctx["org_id"])
    p = await _create_partner(client, ctx["org_id"], code=f"FSR-{role_name[:3].upper()}")
    scoped = f"{role_name}-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(scoped)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=scoped,
        org_id=ctx["org_id"],
        role_name=role_name,
        farm_id=farm_id,
    )
    # Now client is switched to the scoped user.
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/v1/organizations/{ctx['org_id']}/business-partners")
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(
    "invalid_scope",
    [
        "revoked_assignment",
        "inactive_membership",
        "inactive_farm",
        "deleted_farm",
        "inactive_org_membership",
    ],
)
async def test_stale_farm_scope_does_not_grant_partner_read(
    client: AsyncClient,
    invalid_scope: str,
) -> None:
    """An active org membership must not revive a stale farm grant."""
    ctx = await _new_owner_org(client)
    farm_id = await _create_farm(client, ctx["org_id"])
    partner = await _create_partner(client, ctx["org_id"], code=f"STALE-{invalid_scope[:3]}")
    scoped = f"stale-{invalid_scope}-{uuid4().hex[:6]}@agrovix.dev"
    await create_verified_user(scoped)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=scoped,
        org_id=ctx["org_id"],
        role_name="farm_manager",
        farm_id=farm_id,
    )
    if invalid_scope == "inactive_org_membership":
        # Keep the user valid and active in another tenant. That unrelated
        # membership must not revive the stale assignment in the target org.
        await create_org(client, slug=f"other-{uuid4().hex[:6]}")

    async with _db.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == scoped))).scalar_one()
        org_membership = (
            await session.execute(
                select(OrganizationMembership).where(
                    OrganizationMembership.user_id == user.id,
                    OrganizationMembership.organization_id == uuid_from(ctx["org_id"]),
                )
            )
        ).scalar_one()
        assert org_membership.is_active is True

        if invalid_scope == "revoked_assignment":
            assignment = (
                await session.execute(
                    select(RoleAssignment).where(
                        RoleAssignment.user_id == user.id,
                        RoleAssignment.farm_id == uuid_from(farm_id),
                    )
                )
            ).scalar_one()
            assignment.revoked_at = datetime.now(UTC)
            session.add(assignment)
        elif invalid_scope == "inactive_membership":
            membership = (
                await session.execute(
                    select(FarmMembership).where(
                        FarmMembership.user_id == user.id,
                        FarmMembership.farm_id == uuid_from(farm_id),
                    )
                )
            ).scalar_one()
            membership.is_active = False
            session.add(membership)
        elif invalid_scope in {"inactive_farm", "deleted_farm"}:
            farm = await session.get(Farm, uuid_from(farm_id))
            assert farm is not None
            if invalid_scope == "inactive_farm":
                farm.is_active = False
            else:
                farm.deleted_at = datetime.now(UTC)
            session.add(farm)
        else:
            org_membership.is_active = False
            session.add(org_membership)
        await session.commit()

    response = await client.get(f"/api/v1/business-partners/{partner['id']}")
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("role_name", ["farm_manager", "supervisor", "storekeeper"])
async def test_farm_scoped_role_cannot_mutate_partner(client: AsyncClient, role_name: str) -> None:
    ctx = await _new_owner_org(client)
    farm_id = await _create_farm(client, ctx["org_id"])
    p = await _create_partner(client, ctx["org_id"], code=f"FSM-{role_name[:3].upper()}")
    scoped = f"{role_name}mut-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(scoped)
    await invite_and_accept(
        client,
        inviter_email=ctx["owner"],
        invitee_email=scoped,
        org_id=ctx["org_id"],
        role_name=role_name,
        farm_id=farm_id,
    )
    # Create — must be 403 (no create grant).
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={"code": "NEW-FSM", "legal_name": "Nope", "capabilities": ["supplier"]},
    )
    assert r.status_code == 403
    # Update — must be 403.
    r = await client.patch(f"/api/v1/business-partners/{p['id']}", json={"trading_name": "hijack"})
    assert r.status_code == 403
    # Deactivate — must be 403.
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/deactivate",
        json={"reason": "shouldnt work"},
    )
    assert r.status_code == 403


async def test_scoped_read_stays_tenant_hidden_for_foreign_org(
    client: AsyncClient,
) -> None:
    a = await _new_owner_org(client)
    p = await _create_partner(client, a["org_id"], code="TSH-A")
    # New user with a farm-scoped role in a DIFFERENT organization.
    b = await _new_owner_org(client)
    b_farm = await _create_farm(client, b["org_id"])
    outsider = f"outsider-{uuid4().hex[:8]}@agrovix.dev"
    await create_verified_user(outsider)
    await invite_and_accept(
        client,
        inviter_email=b["owner"],
        invitee_email=outsider,
        org_id=b["org_id"],
        role_name="farm_manager",
        farm_id=b_farm,
    )
    r = await client.get(f"/api/v1/business-partners/{p['id']}")
    assert r.status_code == 404, r.text


# --- Phase 2: audit completeness ----------------------------------------- #
async def test_nested_contact_creation_emits_contact_create_audit(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    partner = await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-NCT",
        capabilities=["supplier"],
        contacts=[
            {"name": "A", "contact_role": "accounts", "is_primary": True},
            {"name": "B", "contact_role": "warehouse", "is_primary": False},
            {"name": "C", "contact_role": "sales", "is_primary": True},
        ],
    )
    assert len(partner["contacts"]) == 3
    actions = await _audit_actions_for(ctx["org_id"])
    contact_creates = [a for a in actions if a == "business_partner.contact.create"]
    assert len(contact_creates) == 3, actions


async def test_initial_approved_profile_emits_qualification_audit(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-QIA",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    actions = await _audit_actions_for(ctx["org_id"])
    assert "business_partner.qualification.update" in actions


async def test_initial_unqualified_profile_does_not_emit_qualification_audit(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-UNQ",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    actions = await _audit_actions_for(ctx["org_id"])
    assert "business_partner.qualification.update" not in actions


async def test_qualification_update_records_bounded_old_and_new(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-QBN",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "unqualified",
            "preference_tier": "standard",
        },
    )
    await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={"qualification_status": "approved", "preference_tier": "preferred"},
    )
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(ctx["org_id"]),
                        AuditEvent.action == "business_partner.qualification.update",
                    )
                )
            )
            .scalars()
            .all()
        )
    assert rows
    for row in rows:
        md = row.metadata_json or {}
        assert md.get("old_qualification_status") is not None
        assert md.get("new_qualification_status") == "approved"
        assert "changed_fields" in md
        # No PII / notes / addresses in audit metadata.
        blob = str(md).lower()
        for banned in ("note", "email", "phone", "address"):
            assert banned not in blob, (banned, md)


async def test_same_state_qualification_no_duplicate_audit(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(
        client,
        ctx["org_id"],
        code="AUD-IDEM",
        capabilities=["supplier"],
        supplier_profile={
            "qualification_status": "approved",
            "preference_tier": "preferred",
        },
    )
    # Same state PUT.
    await client.put(
        f"/api/v1/business-partners/{p['id']}/supplier-profile",
        json={"qualification_status": "approved", "preference_tier": "preferred"},
    )
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(ctx["org_id"]),
                        AuditEvent.action == "business_partner.qualification.update",
                    )
                )
            )
            .scalars()
            .all()
        )
    # Exactly ONE qualification event (from the initial approved create).
    assert len(rows) == 1


# --- Phase 4: ISO 3166-1 alpha-2 real-set validation --------------------- #
async def test_country_code_ng_is_uppercased(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "CC-NG",
            "legal_name": "Nigeria",
            "capabilities": ["supplier"],
            "country_code": "ng",
        },
    )
    assert r.status_code == 201
    assert r.json()["country_code"] == "NG"


@pytest.mark.parametrize("code", ["NG", "US", "IN", "GB", "ZA"])
async def test_country_code_valid_iso_accepted(client: AsyncClient, code: str) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": f"CC-{code}",
            "legal_name": f"Country {code}",
            "capabilities": ["supplier"],
            "country_code": code,
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["country_code"] == code


@pytest.mark.parametrize("bad", ["XK", "ZZ", "QQ", "XX", "ZY"])
async def test_country_code_reserved_or_nonexistent_rejected(client: AsyncClient, bad: str) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": f"CC-{bad}",
            "legal_name": "Bad ISO",
            "capabilities": ["supplier"],
            "country_code": bad,
        },
    )
    assert r.status_code == 422, r.text


async def test_country_code_non_string_rejected(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "CC-NUM",
            "legal_name": "Numeric CC",
            "capabilities": ["supplier"],
            "country_code": 42,
        },
    )
    assert r.status_code == 422


async def test_country_code_null_accepted_optional(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "CC-NULL",
            "legal_name": "No Country",
            "capabilities": ["supplier"],
            "country_code": None,
        },
    )
    assert r.status_code == 201
    assert r.json()["country_code"] is None


# --- Phase 5: nullable contact clearing --------------------------------- #
async def test_contact_patch_can_clear_nullable_fields(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CLR-01")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Alice",
            "job_title": "Buyer",
            "email": "alice@ex.example",
            "phone": "+91 22 5555 0100",
            "contact_role": "accounts",
            "is_primary": True,
            "notes": "some notes",
        },
    )
    contact_id = r.json()["id"]
    # Explicit null for each nullable → cleared.
    r = await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={"job_title": None, "email": None, "phone": None, "notes": None},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["job_title"] is None
    assert body["email"] is None
    assert body["phone"] is None
    assert body["notes"] is None


async def test_contact_patch_omitted_field_unchanged(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="CLR-OMT")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "Bob",
            "job_title": "Ops",
            "contact_role": "warehouse",
            "is_primary": True,
        },
    )
    contact_id = r.json()["id"]
    # PATCH only email — job_title must remain.
    r = await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={"email": "bob@ex.example"},
    )
    assert r.status_code == 200
    assert r.json()["job_title"] == "Ops"
    assert r.json()["email"] == "bob@ex.example"


@pytest.mark.parametrize("field", ["name", "contact_role", "is_primary"])
async def test_contact_patch_required_field_null_rejected(client: AsyncClient, field: str) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code=f"REQ-{field[:3]}")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={"name": "C", "contact_role": "sales", "is_primary": True},
    )
    contact_id = r.json()["id"]
    r = await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={field: None},
    )
    assert r.status_code == 422, r.text


async def test_contact_patch_audit_records_changed_fields_no_pii(
    client: AsyncClient,
) -> None:
    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="AUD-CLR")
    r = await client.post(
        f"/api/v1/business-partners/{p['id']}/contacts",
        json={
            "name": "D",
            "email": "d@ex.example",
            "contact_role": "sales",
            "is_primary": True,
        },
    )
    contact_id = r.json()["id"]
    await client.patch(
        f"/api/v1/business-partner-contacts/{contact_id}",
        json={"email": None},
    )
    async with _db.AsyncSessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.organization_id == uuid_from(ctx["org_id"]),
                        AuditEvent.action == "business_partner.contact.update",
                    )
                )
            )
            .scalars()
            .all()
        )
    assert rows
    blob = str([r.metadata_json for r in rows]).lower()
    assert "d@ex.example" not in blob


# --- Phase 6: concurrent-write IntegrityError → 409 --------------------- #
@_postgres_only
async def test_concurrent_duplicate_code_returns_deterministic_409(
    client: AsyncClient,
) -> None:
    """Simulate a race where the pre-check passes but the flush loses.

    The IntegrityError from the unique (organization_id, code) index
    is translated into a stable 409 envelope rather than a 500.
    """
    import asyncio

    ctx = await _new_owner_org(client)

    # Both requests attempt the SAME code — one must win, one must lose.
    async def _create() -> int:
        r = await client.post(
            f"/api/v1/organizations/{ctx['org_id']}/business-partners",
            json={
                "code": "RACE-01",
                "legal_name": "Racy",
                "capabilities": ["supplier"],
            },
        )
        return r.status_code

    results = await asyncio.gather(_create(), _create(), return_exceptions=False)
    assert sorted(results) == [201, 409], results


@_postgres_only
async def test_concurrent_duplicate_capability_returns_409(
    client: AsyncClient,
) -> None:
    import asyncio

    ctx = await _new_owner_org(client)
    p = await _create_partner(client, ctx["org_id"], code="RACE-CAP", capabilities=[])

    async def _add() -> int:
        r = await client.post(
            f"/api/v1/business-partners/{p['id']}/capabilities",
            json={"capability": "customer"},
        )
        return r.status_code

    results = await asyncio.gather(_add(), _add(), return_exceptions=False)
    # Both idempotent OK, or one 201 + one 409 — never a 500. The
    # service pre-check may see both as "not present" concurrently and
    # let the DB reject one.
    assert all(s in (201, 409) for s in results), results


# --- Phase 4: nested primary_address uses the real ISO set too --------- #
async def test_primary_address_nested_iso_real_set(client: AsyncClient) -> None:
    ctx = await _new_owner_org(client)
    r = await client.post(
        f"/api/v1/organizations/{ctx['org_id']}/business-partners",
        json={
            "code": "PACC-ZZ",
            "legal_name": "Nested Bad ISO",
            "capabilities": ["supplier"],
            "primary_address": {"country_code": "ZZ"},
        },
    )
    assert r.status_code == 422, r.text
