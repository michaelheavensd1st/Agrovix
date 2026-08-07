"""Release 6.0.3 — Purchase Order domain tests (Sprint 1.1 hardened).

Service-level (no HTTP endpoints ship in this milestone). SQLite-hermetic;
the Postgres concurrency proofs live in
``test_purchase_orders_concurrency.py``.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.models.audit import AuditEvent
from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapability,
    BusinessPartnerCapabilityCode,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
    BusinessPartnerSupplierProfile,
)
from app.models.farm import Farm
from app.models.inventory import InventoryItem, InventoryItemCategory, StockUnit
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.purchase_order import PurchaseOrderStatus
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import (
    BusinessPartnerCapabilityRepository,
    BusinessPartnerContactRepository,
    BusinessPartnerRepository,
    BusinessPartnerSupplierProfileRepository,
)
from app.repositories.purchase_order import (
    PurchaseOrderLineRepository,
    PurchaseOrderRepository,
    PurchaseOrderSequenceRepository,
    PurchaseOrderTransitionRepository,
)
from app.services.business_partner import BusinessPartnerService
from app.services.purchase_order import PurchaseOrderService

pytestmark = pytest.mark.asyncio

TODAY = date(2026, 3, 1)


def _po_service(session) -> PurchaseOrderService:
    return PurchaseOrderService(
        po_repo=PurchaseOrderRepository(session),
        line_repo=PurchaseOrderLineRepository(session),
        transition_repo=PurchaseOrderTransitionRepository(session),
        sequence_repo=PurchaseOrderSequenceRepository(session),
        partner_repo=BusinessPartnerRepository(session),
        audit_repo=AuditRepository(session),
    )


def _bp_service(session) -> BusinessPartnerService:
    return BusinessPartnerService(
        partner_repo=BusinessPartnerRepository(session),
        capability_repo=BusinessPartnerCapabilityRepository(session),
        profile_repo=BusinessPartnerSupplierProfileRepository(session),
        contact_repo=BusinessPartnerContactRepository(session),
        audit_repo=AuditRepository(session),
    )


async def _seed_env(
    session,
    *,
    qualification=BusinessPartnerQualificationStatus.APPROVED,
    supplier_capability=True,
    partner_active=True,
    make_profile=True,
):
    org = Organization(name="Env Co", slug=f"org-{uuid4().hex[:10]}", is_active=True)
    creator = User(
        email=f"creator-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="Creator",
        is_active=True,
        is_verified=True,
        is_superuser=True,
    )
    approver = User(
        email=f"approver-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="Approver",
        is_active=True,
        is_verified=True,
        is_superuser=True,
    )
    session.add_all([org, creator, approver])
    await session.flush()

    farm = Farm(organization_id=org.id, name="Farm A", code=f"F-{uuid4().hex[:6]}", is_active=True)
    partner = BusinessPartner(
        organization_id=org.id,
        code=f"SUP-{uuid4().hex[:6]}",
        legal_name="Acme Feeds Ltd",
        trading_name="Acme",
        is_active=partner_active,
    )
    session.add_all([farm, partner])
    await session.flush()

    if supplier_capability:
        session.add(
            BusinessPartnerCapability(
                business_partner_id=partner.id,
                capability=BusinessPartnerCapabilityCode.SUPPLIER,
            )
        )
    if make_profile:
        session.add(
            BusinessPartnerSupplierProfile(
                business_partner_id=partner.id,
                qualification_status=qualification,
                preference_tier=BusinessPartnerPreferenceTier.STANDARD,
            )
        )

    feed = InventoryItem(
        organization_id=org.id,
        code=f"FEED-{uuid4().hex[:6]}",
        name="Grower crumble",
        category=InventoryItemCategory.FEED,
        canonical_unit=StockUnit.KG,
        sku="SKU-1",
        is_active=True,
    )
    feed2 = InventoryItem(
        organization_id=org.id,
        code=f"FEED2-{uuid4().hex[:6]}",
        name="Layer mash",
        category=InventoryItemCategory.FEED,
        canonical_unit=StockUnit.KG,
        is_active=True,
    )
    count_item = InventoryItem(
        organization_id=org.id,
        code=f"NET-{uuid4().hex[:6]}",
        name="Cast net",
        category=InventoryItemCategory.SUPPLY,
        canonical_unit=StockUnit.COUNT,
        is_active=True,
    )
    session.add_all([feed, feed2, count_item])
    await session.flush()
    await session.commit()
    return {
        "org": org,
        "creator": creator,
        "approver": approver,
        "farm": farm,
        "partner": partner,
        "feed": feed,
        "feed2": feed2,
        "count_item": count_item,
    }


def _line(item_id, *, qty="10", unit="kg", price="5.50", note=None, desc=None, id=None) -> dict:
    d = {
        "inventory_item_id": str(item_id),
        "ordered_quantity": qty,
        "ordered_unit": unit,
        "unit_price": price,
    }
    if note is not None:
        d["line_note"] = note
    if desc is not None:
        d["description"] = desc
    if id is not None:
        d["id"] = str(id)
    return d


async def _create_draft(session, env, *, lines=None, **overrides):
    svc = _po_service(session)
    kwargs = {
        "actor": env["creator"],
        "organization_id": env["org"].id,
        "business_partner_id": env["partner"].id,
        "currency_code": "USD",
        "order_date": TODAY,
        "lines": lines if lines is not None else [_line(env["feed"].id)],
    }
    kwargs.update(overrides)
    po = await svc.create(**kwargs)
    await session.commit()
    return po


# ===================================================================== #
# Create
# ===================================================================== #
async def test_create_generates_number_snapshots_decimals(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, qty="12.500000", unit="kg", price="4.20")]
    )
    assert po.status == PurchaseOrderStatus.DRAFT
    assert po.po_number == f"PO-{TODAY.year}-000001"
    assert po.version == 1
    assert po.supplier_legal_name == "Acme Feeds Ltd"
    line = po.lines[0]
    assert line.line_number == 1
    assert line.canonical_unit == "kg"
    assert Decimal(str(line.ordered_quantity)) == Decimal("12.500000")
    assert _po_service(db_session).subtotal(po) == Decimal("52.500000")
    assert await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id) == 1
    audit = (
        await db_session.execute(
            select(func.count()).select_from(AuditEvent).where(AuditEvent.entity_id == str(po.id))
        )
    ).scalar_one()
    assert audit == 1


async def test_create_number_monotonic_same_org_year(db_session):
    env = await _seed_env(db_session)
    po1 = await _create_draft(db_session, env)
    po2 = await _create_draft(db_session, env)
    assert po1.po_number == f"PO-{TODAY.year}-000001"
    assert po2.po_number == f"PO-{TODAY.year}-000002"


async def test_create_rejects_invalid_currency(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, currency_code="ZZZ")
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "invalid_currency"


async def test_create_rejects_delivery_before_order(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, expected_delivery_date=TODAY - timedelta(days=1))
    assert exc.value.detail["code"] == "purchase_order_invalid_delivery_date"


async def test_zero_price_requires_note(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, lines=[_line(env["feed"].id, price="0")])
    assert exc.value.detail["code"] == "purchase_order_line_note_required"
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, price="0", note="free sample")]
    )
    assert po.lines[0].unit_price == 0


async def test_unit_conversion_and_incompatibility(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, qty="2500", unit="g", price="1")]
    )
    assert Decimal(str(po.lines[0].ordered_quantity_canonical)) == Decimal("2.500000")
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, lines=[_line(env["feed"].id, unit="count")])
    assert exc.value.detail["code"] == "unit_incompatible"
    with pytest.raises(Exception) as exc2:
        await _create_draft(db_session, env, lines=[_line(env["feed"].id, unit="tonne")])
    assert exc2.value.detail["code"] == "ordered_unit_mismatch"


async def test_draft_selection_requires_supplier_capability(db_session):
    env = await _seed_env(db_session, supplier_capability=False, make_profile=False)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env)
    assert exc.value.detail["code"] == "business_partner_not_supplier"


async def test_draft_selection_inactive_supplier(db_session):
    env = await _seed_env(db_session, partner_active=False)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env)
    assert exc.value.detail["code"] == "business_partner_inactive"


async def test_create_foreign_partner_is_tenant_hidden(db_session):
    env = await _seed_env(db_session)
    other = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, business_partner_id=other["partner"].id)
    assert exc.value.status_code == 404


# ===================================================================== #
# Decimal precision (objective 6)
# ===================================================================== #
async def test_subtotal_exact_quantization(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, qty="3", unit="kg", price="1.111111")]
    )
    assert _po_service(db_session).subtotal(po) == Decimal("3.333333")


async def test_reject_more_than_six_decimals(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, lines=[_line(env["feed"].id, qty="1.1234567")])
    assert exc.value.detail["code"] == "invalid_decimal"


async def test_reject_out_of_range_quantity(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, lines=[_line(env["feed"].id, qty="1000000000000")])
    assert exc.value.detail["code"] == "value_out_of_range"


# ===================================================================== #
# Delivery-address + bounded-string validation (objective 7)
# ===================================================================== #
async def test_delivery_address_rejects_unknown_key(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, delivery_address={"planet": "earth"})
    assert exc.value.detail["code"] == "invalid_delivery_address"


async def test_delivery_address_rejects_bad_country(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(
            db_session, env, delivery_address={"city": "Nairobi", "country_code": "ZZ"}
        )
    assert exc.value.detail["code"] == "invalid_country_code"


async def test_delivery_address_valid_normalizes(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session, env, delivery_address={"city": "Nairobi", "country_code": "ke"}
    )
    assert po.delivery_address["country_code"] == "KE"


async def test_supplier_reference_length_bounded(db_session):
    env = await _seed_env(db_session)
    with pytest.raises(Exception) as exc:
        await _create_draft(db_session, env, supplier_reference="x" * 121)
    assert exc.value.detail["code"] == "value_too_long"


# ===================================================================== #
# Draft update / versioning / stable line identity (objective 4)
# ===================================================================== #
async def test_update_version_conflict(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.update_draft(
            actor=env["creator"],
            organization_id=env["org"].id,
            po_id=po.id,
            expected_version=99,
            data={"notes": "x"},
        )
    assert exc.value.detail["code"] == "purchase_order_version_conflict"


async def test_update_noop_keeps_version(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    result = await svc.update_draft(
        actor=env["creator"],
        organization_id=env["org"].id,
        po_id=po.id,
        expected_version=1,
        data={"notes": None},
    )
    assert result.version == 1


async def test_line_edit_preserves_uuid(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env, lines=[_line(env["feed"].id, qty="5")])
    original_id = po.lines[0].id
    svc = _po_service(db_session)
    updated = await svc.update_draft(
        actor=env["creator"],
        organization_id=env["org"].id,
        po_id=po.id,
        expected_version=1,
        data={"lines": [_line(env["feed"].id, qty="9", id=original_id)]},
    )
    await db_session.commit()
    assert updated.version == 2
    assert updated.lines[0].id == original_id  # UUID preserved, not recreated
    assert Decimal(str(updated.lines[0].ordered_quantity)) == Decimal("9.000000")


async def test_line_reorder_add_remove_audit(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session,
        env,
        lines=[_line(env["feed"].id, qty="1"), _line(env["feed2"].id, qty="2")],
    )
    id_a, id_b = po.lines[0].id, po.lines[1].id
    svc = _po_service(db_session)
    # Reorder (swap) + add a third line; keep a & b by id.
    updated = await svc.update_draft(
        actor=env["creator"],
        organization_id=env["org"].id,
        po_id=po.id,
        expected_version=1,
        data={
            "lines": [
                _line(env["feed2"].id, qty="2", id=id_b),
                _line(env["feed"].id, qty="1", id=id_a),
                _line(env["count_item"].id, qty="3", unit="count", price="1"),
            ]
        },
    )
    await db_session.commit()
    ids = [ln.id for ln in updated.lines]
    assert id_a in ids and id_b in ids  # preserved
    assert len(updated.lines) == 3
    # Now remove line a by omission.
    updated2 = await svc.update_draft(
        actor=env["creator"],
        organization_id=env["org"].id,
        po_id=po.id,
        expected_version=updated.version,
        data={
            "lines": [
                _line(env["feed2"].id, qty="2", id=id_b),
                _line(
                    updated.lines[2].inventory_item_id,
                    qty="3",
                    unit="count",
                    price="1",
                    id=updated.lines[2].id,
                ),
            ]
        },
    )
    await db_session.commit()
    assert id_a not in [ln.id for ln in updated2.lines]


async def test_line_diff_rejects_duplicate_and_unknown_ids(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env, lines=[_line(env["feed"].id)])
    lid = po.lines[0].id
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.update_draft(
            actor=env["creator"],
            organization_id=env["org"].id,
            po_id=po.id,
            expected_version=1,
            data={"lines": [_line(env["feed"].id, id=lid), _line(env["feed"].id, id=lid)]},
        )
    assert exc.value.detail["code"] == "duplicate_line_id"
    with pytest.raises(Exception) as exc2:
        await svc.update_draft(
            actor=env["creator"],
            organization_id=env["org"].id,
            po_id=po.id,
            expected_version=1,
            data={"lines": [_line(env["feed"].id, id=uuid4())]},
        )
    assert exc2.value.detail["code"] == "unknown_line_id"


async def test_update_on_non_draft_rejected(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.update_draft(
            actor=env["creator"],
            organization_id=env["org"].id,
            po_id=po.id,
            expected_version=po.version,
            data={"notes": "x"},
        )
    assert exc.value.detail["code"] == "invalid_purchase_order_transition"


# ===================================================================== #
# Lifecycle
# ===================================================================== #
async def test_submit_requires_line(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env, lines=[])
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.detail["code"] == "purchase_order_requires_line"


async def test_submit_requires_approved_qualification(db_session):
    env = await _seed_env(db_session, qualification=BusinessPartnerQualificationStatus.UNQUALIFIED)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.detail["code"] == "business_partner_not_approved"


async def test_submit_blocked_supplier(db_session):
    env = await _seed_env(db_session, qualification=BusinessPartnerQualificationStatus.BLOCKED)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.detail["code"] == "business_partner_blocked"


async def test_submission_rebuild_rejects_deactivated_item(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    # Deactivate the item AFTER the draft is created.
    item = await db_session.get(InventoryItem, env["feed"].id)
    item.is_active = False
    db_session.add(item)
    await db_session.commit()
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.status_code == 404  # rebuild uses authoritative locked data


async def test_full_lifecycle_submit_approve(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    r_sub = await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    assert r_sub.replay is False
    assert po.status == PurchaseOrderStatus.SUBMITTED and po.version == 2
    r_app = await svc.approve(actor=env["approver"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    assert r_app.replay is False
    assert po.status == PurchaseOrderStatus.APPROVED and po.version == 3
    assert await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id) == 3


async def test_self_approval_forbidden(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.approve(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.detail["code"] == "purchase_order_self_approval_forbidden"


async def test_submit_replay_is_idempotent(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    v = po.version
    r = await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    assert r.replay is True and po.version == v
    assert await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id) == 2


async def test_withdraw_and_replay(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    r = await svc.withdraw(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="edits"
    )
    await db_session.commit()
    assert r.replay is False and po.status == PurchaseOrderStatus.DRAFT
    assert po.submitted_by_id is None
    r2 = await svc.withdraw(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="again"
    )
    await db_session.commit()
    assert r2.replay is True


async def test_reject_revise_flow(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    await svc.reject(
        actor=env["approver"], organization_id=env["org"].id, po_id=po.id, reason="too high"
    )
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.REJECTED
    await svc.revise(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="reworked"
    )
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.DRAFT and po.rejected_by_id is None
    r2 = await svc.revise(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="again"
    )
    await db_session.commit()
    assert r2.replay is True


async def test_reject_requires_reason(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.reject(
            actor=env["approver"], organization_id=env["org"].id, po_id=po.id, reason="  "
        )
    assert exc.value.detail["code"] == "reason_required"


async def test_cancel_and_replay(db_session):
    env = await _seed_env(db_session)
    svc = _po_service(db_session)
    po = await _create_draft(db_session, env)
    await svc.cancel(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="not needed"
    )
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.CANCELLED
    r = await svc.cancel(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="again"
    )
    assert r.replay is True


async def test_cancel_blocked_by_received_canonical_accumulator(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    await svc.approve(actor=env["approver"], organization_id=env["org"].id, po_id=po.id)
    await db_session.commit()
    # Simulate a future receipt on the CANONICAL accumulator only.
    line = po.lines[0]
    line.received_quantity_canonical = Decimal("1.000000")
    db_session.add(line)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.cancel(
            actor=env["approver"], organization_id=env["org"].id, po_id=po.id, reason="x"
        )
    assert exc.value.detail["code"] == "purchase_order_has_receipts"


async def test_invalid_transitions(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.approve(actor=env["approver"], organization_id=env["org"].id, po_id=po.id)
    assert exc.value.detail["code"] == "invalid_purchase_order_transition"


# ===================================================================== #
# In-transaction authorization revalidation (objective 2)
# ===================================================================== #
async def _grant(session, user, org, role_name, *, farm=None):
    role = (await session.execute(select(Role).where(Role.name == role_name))).scalar_one()
    session.add(OrganizationMembership(user_id=user.id, organization_id=org.id, is_active=True))
    if farm is not None:
        session.add(FarmMembership(user_id=user.id, farm_id=farm.id, is_active=True))
    session.add(
        RoleAssignment(
            user_id=user.id,
            role_id=role.id,
            organization_id=org.id,
            farm_id=farm.id if farm else None,
        )
    )
    await session.flush()


async def test_authorization_allows_org_grant(db_session):
    env = await _seed_env(db_session)
    user = User(
        email=f"u-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="U",
        is_active=True,
        is_verified=True,
        is_superuser=False,
    )
    db_session.add(user)
    await db_session.flush()
    await _grant(db_session, user, env["org"], "organization_owner")
    await db_session.commit()
    svc = _po_service(db_session)
    po = await svc.create(
        actor=user,
        organization_id=env["org"].id,
        business_partner_id=env["partner"].id,
        currency_code="USD",
        order_date=TODAY,
        lines=[_line(env["feed"].id)],
    )
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.DRAFT


async def test_authorization_denies_without_grant(db_session):
    env = await _seed_env(db_session)
    user = User(
        email=f"u-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="U",
        is_active=True,
        is_verified=True,
        is_superuser=False,
    )
    db_session.add(user)
    await db_session.flush()
    await _grant(db_session, user, env["org"], "viewer")  # read-only
    await db_session.commit()
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=user,
            organization_id=env["org"].id,
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.status_code == 403


async def test_authorization_revoked_membership_denies(db_session):
    env = await _seed_env(db_session)
    user = User(
        email=f"u-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="U",
        is_active=True,
        is_verified=True,
        is_superuser=False,
    )
    db_session.add(user)
    await db_session.flush()
    await _grant(db_session, user, env["org"], "organization_owner")
    await db_session.commit()
    # Revoke org membership.
    m = (
        await db_session.execute(
            select(OrganizationMembership).where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.organization_id == env["org"].id,
            )
        )
    ).scalar_one()
    m.is_active = False
    db_session.add(m)
    await db_session.commit()
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=user,
            organization_id=env["org"].id,
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.status_code == 403


# ===================================================================== #
# Numbering validation (objective 10)
# ===================================================================== #
async def test_numbering_year_boundary(db_session):
    env = await _seed_env(db_session)
    dec = await _create_draft(db_session, env, order_date=date(2026, 12, 31))
    jan = await _create_draft(db_session, env, order_date=date(2027, 1, 1))
    assert dec.po_number == "PO-2026-000001"
    assert jan.po_number == "PO-2027-000001"  # independent per-year sequence


async def test_numbering_same_org_different_year_independent(db_session):
    env = await _seed_env(db_session)
    a = await _create_draft(db_session, env, order_date=date(2026, 5, 1))
    b = await _create_draft(db_session, env, order_date=date(2026, 6, 1))
    c = await _create_draft(db_session, env, order_date=date(2027, 2, 1))
    assert a.po_number == "PO-2026-000001"
    assert b.po_number == "PO-2026-000002"
    assert c.po_number == "PO-2027-000001"


async def test_numbering_rollback_leaves_no_gap_on_next(db_session):
    env = await _seed_env(db_session)
    org_id, partner_id, feed_id, creator_id = (
        env["org"].id,
        env["partner"].id,
        env["feed"].id,
        env["creator"].id,
    )
    svc = _po_service(db_session)
    # First allocation, then roll back the whole transaction.
    await svc.create(
        actor=env["creator"],
        organization_id=org_id,
        business_partner_id=partner_id,
        currency_code="USD",
        order_date=TODAY,
        lines=[_line(feed_id)],
    )
    await db_session.rollback()
    # Next committed create reuses value 1 (rolled-back increment released).
    creator = await db_session.get(User, creator_id)
    po = await svc.create(
        actor=creator,
        organization_id=org_id,
        business_partner_id=partner_id,
        currency_code="USD",
        order_date=TODAY,
        lines=[_line(feed_id)],
    )
    await db_session.commit()
    assert po.po_number == f"PO-{TODAY.year}-000001"


# ===================================================================== #
# Supplier capability governance (objective — §2)
# ===================================================================== #
async def test_capability_removal_blocked_by_non_terminal_po(db_session):
    env = await _seed_env(db_session)
    await _create_draft(db_session, env)  # DRAFT — non-terminal
    bp = _bp_service(db_session)
    partner = await BusinessPartnerRepository(db_session).get_by_id(
        env["partner"].id, with_relations=True
    )
    with pytest.raises(Exception) as exc:
        await bp.remove_capability(
            actor=env["creator"],
            partner=partner,
            capability=BusinessPartnerCapabilityCode.SUPPLIER,
            request_ctx={},
        )
    assert exc.value.detail["code"] == "business_partner_supplier_capability_in_use"
    assert exc.value.detail["context"]["dependent_purchase_order_count"] == 1


async def test_capability_removal_allowed_after_terminal(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.cancel(
        actor=env["creator"], organization_id=env["org"].id, po_id=po.id, reason="done"
    )
    await db_session.commit()
    bp = _bp_service(db_session)
    partner = await BusinessPartnerRepository(db_session).get_by_id(
        env["partner"].id, with_relations=True
    )
    await bp.remove_capability(
        actor=env["creator"],
        partner=partner,
        capability=BusinessPartnerCapabilityCode.SUPPLIER,
        request_ctx={},
    )
    await db_session.commit()
    remaining = await BusinessPartnerCapabilityRepository(db_session).get(
        env["partner"].id, BusinessPartnerCapabilityCode.SUPPLIER
    )
    assert remaining is None
