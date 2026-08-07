"""Release 6.0.3 — Purchase Order domain tests (Phase 1, service-level).

These exercise the aggregate service directly (no HTTP endpoints ship
in Phase 1). SQLite-hermetic; the Postgres concurrency proofs live in
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
from app.models.organization import Organization
from app.models.purchase_order import (
    PurchaseOrderStatus,
)
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


# --------------------------------------------------------------------- #
# Fixture helpers
# --------------------------------------------------------------------- #
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
    )
    approver = User(
        email=f"approver-{uuid4().hex[:8]}@x.dev",
        hashed_password="x",
        full_name="Approver",
        is_active=True,
        is_verified=True,
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
    count_item = InventoryItem(
        organization_id=org.id,
        code=f"NET-{uuid4().hex[:6]}",
        name="Cast net",
        category=InventoryItemCategory.SUPPLY,
        canonical_unit=StockUnit.COUNT,
        is_active=True,
    )
    session.add_all([feed, count_item])
    await session.flush()
    await session.commit()
    return {
        "org": org,
        "creator": creator,
        "approver": approver,
        "farm": farm,
        "partner": partner,
        "feed": feed,
        "count_item": count_item,
    }


def _line(item_id, *, qty="10", unit="kg", price="5.50", note=None, desc=None) -> dict:
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
    return d


async def _create_draft(session, env, *, lines=None, **overrides):
    svc = _po_service(session)
    kwargs = {
        "actor": env["creator"],
        "organization": env["org"],
        "business_partner_id": env["partner"].id,
        "currency_code": "USD",
        "order_date": TODAY,
        "lines": lines if lines is not None else [_line(env["feed"].id)],
    }
    kwargs.update(overrides)
    po = await svc.create(**kwargs)
    await session.commit()
    return po


# --------------------------------------------------------------------- #
# Create
# --------------------------------------------------------------------- #
async def test_create_generates_number_snapshots_decimals(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, qty="12.500000", unit="kg", price="4.20")]
    )
    assert po.status == PurchaseOrderStatus.DRAFT
    assert po.po_number == f"PO-{TODAY.year}-000001"
    assert po.version == 1
    assert po.supplier_code == env["partner"].code
    assert po.supplier_legal_name == "Acme Feeds Ltd"
    assert po.supplier_trading_name == "Acme"
    line = po.lines[0]
    assert line.line_number == 1
    assert line.item_code == env["feed"].code
    assert line.item_name == "Grower crumble"
    assert line.item_sku == "SKU-1"
    assert line.canonical_unit == "kg"
    assert Decimal(str(line.ordered_quantity)) == Decimal("12.5")
    svc = _po_service(db_session)
    assert svc.subtotal(po) == Decimal("52.500000")
    # initial transition null -> DRAFT + create audit event.
    tcount = await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id)
    assert tcount == 1
    audit = (
        await db_session.execute(
            select(func.count()).select_from(AuditEvent).where(AuditEvent.entity_id == str(po.id))
        )
    ).scalar_one()
    assert audit == 1  # only purchase_order.create (no transition audit on create)


async def test_create_number_monotonic_same_org_year(db_session):
    env = await _seed_env(db_session)
    po1 = await _create_draft(db_session, env)
    po2 = await _create_draft(db_session, env)
    assert po1.po_number == f"PO-{TODAY.year}-000001"
    assert po2.po_number == f"PO-{TODAY.year}-000002"


async def test_create_rejects_invalid_currency(db_session):
    env = await _seed_env(db_session)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="ZZZ",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "invalid_currency"


async def test_create_rejects_delivery_before_order(db_session):
    env = await _seed_env(db_session)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            expected_delivery_date=TODAY - timedelta(days=1),
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.detail["code"] == "purchase_order_invalid_delivery_date"


async def test_zero_price_requires_note(db_session):
    env = await _seed_env(db_session)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id, price="0")],
        )
    assert exc.value.detail["code"] == "purchase_order_line_note_required"
    # With a note it succeeds.
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, price="0", note="free sample")]
    )
    assert po.lines[0].unit_price == 0


async def test_unit_conversion_and_incompatibility(db_session):
    env = await _seed_env(db_session)
    # g -> kg exact conversion.
    po = await _create_draft(
        db_session, env, lines=[_line(env["feed"].id, qty="2500", unit="g", price="1")]
    )
    assert Decimal(str(po.lines[0].ordered_quantity_canonical)) == Decimal("2.5")
    # count -> kg incompatible.
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id, unit="count")],
        )
    assert exc.value.detail["code"] == "unit_incompatible"
    # Unknown unit string.
    with pytest.raises(Exception) as exc2:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id, unit="tonne")],
        )
    assert exc2.value.detail["code"] == "ordered_unit_mismatch"


async def test_draft_selection_requires_supplier_capability(db_session):
    env = await _seed_env(db_session, supplier_capability=False, make_profile=False)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.detail["code"] == "business_partner_not_supplier"


async def test_draft_selection_inactive_supplier(db_session):
    env = await _seed_env(db_session, partner_active=False)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=env["partner"].id,
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.detail["code"] == "business_partner_inactive"


async def test_create_foreign_partner_is_tenant_hidden(db_session):
    env = await _seed_env(db_session)
    other = await _seed_env(db_session)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.create(
            actor=env["creator"],
            organization=env["org"],
            business_partner_id=other["partner"].id,  # foreign tenant
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(env["feed"].id)],
        )
    assert exc.value.status_code == 404


# --------------------------------------------------------------------- #
# Draft update / versioning
# --------------------------------------------------------------------- #
async def test_update_version_conflict(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.update_draft(
            actor=env["creator"], po=po, expected_version=99, data={"notes": "x"}
        )
    assert exc.value.detail["code"] == "purchase_order_version_conflict"
    assert exc.value.detail["context"]["current_version"] == 1


async def test_update_noop_keeps_version(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    result = await svc.update_draft(
        actor=env["creator"], po=po, expected_version=1, data={"notes": None}
    )
    assert result.version == 1


async def test_update_changes_bump_version_and_audit_lines(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    updated = await svc.update_draft(
        actor=env["creator"],
        po=po,
        expected_version=1,
        data={
            "notes": "Rush order",
            "lines": [_line(env["feed"].id, qty="5"), _line(env["feed"].id, qty="7")],
        },
    )
    await db_session.commit()
    assert updated.version == 2
    assert len(updated.lines) == 2
    assert [ln.line_number for ln in updated.lines] == [1, 2]


async def test_update_on_non_draft_rejected(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.update_draft(
            actor=env["creator"], po=po, expected_version=po.version, data={"notes": "x"}
        )
    assert exc.value.detail["code"] == "invalid_purchase_order_transition"


# --------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------- #
async def test_submit_requires_line(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env, lines=[])
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], po=po)
    assert exc.value.detail["code"] == "purchase_order_requires_line"


async def test_submit_requires_approved_qualification(db_session):
    env = await _seed_env(db_session, qualification=BusinessPartnerQualificationStatus.UNQUALIFIED)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], po=po)
    assert exc.value.detail["code"] == "business_partner_not_approved"


async def test_submit_blocked_supplier(db_session):
    env = await _seed_env(db_session, qualification=BusinessPartnerQualificationStatus.BLOCKED)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    with pytest.raises(Exception) as exc:
        await svc.submit(actor=env["creator"], po=po)
    assert exc.value.detail["code"] == "business_partner_blocked"


async def test_full_lifecycle_submit_approve(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    r_sub = await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    assert r_sub.replay is False
    assert po.status == PurchaseOrderStatus.SUBMITTED
    assert po.submitted_by_id == env["creator"].id
    assert po.version == 2

    r_app = await svc.approve(actor=env["approver"], po=po)
    await db_session.commit()
    assert r_app.replay is False
    assert po.status == PurchaseOrderStatus.APPROVED
    assert po.approved_by_id == env["approver"].id
    assert po.version == 3
    # transitions: create + submit + approve = 3
    assert await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id) == 3


async def test_self_approval_forbidden(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.approve(actor=env["creator"], po=po)  # creator == approver
    assert exc.value.detail["code"] == "purchase_order_self_approval_forbidden"


async def test_submit_replay_is_idempotent(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    version_after_first = po.version
    r = await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    assert r.replay is True
    assert po.version == version_after_first
    # create + submit only — replay adds no transition.
    assert await PurchaseOrderTransitionRepository(db_session).count_for_po(po.id) == 2


async def test_withdraw_and_replay(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    r = await svc.withdraw(actor=env["creator"], po=po, reason="need edits")
    await db_session.commit()
    assert r.replay is False
    assert po.status == PurchaseOrderStatus.DRAFT
    assert po.submitted_by_id is None
    # replay: withdraw again while DRAFT (last op was withdraw).
    r2 = await svc.withdraw(actor=env["creator"], po=po, reason="again")
    await db_session.commit()
    assert r2.replay is True


async def test_reject_revise_flow(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    await svc.reject(actor=env["approver"], po=po, reason="price too high")
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.REJECTED
    assert po.rejected_by_id == env["approver"].id
    await svc.revise(actor=env["creator"], po=po, reason="reworked")
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.DRAFT
    assert po.rejected_by_id is None
    # revise replay.
    r2 = await svc.revise(actor=env["creator"], po=po, reason="again")
    await db_session.commit()
    assert r2.replay is True


async def test_reject_requires_reason(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    await svc.submit(actor=env["creator"], po=po)
    await db_session.commit()
    with pytest.raises(Exception) as exc:
        await svc.reject(actor=env["approver"], po=po, reason="  ")
    assert exc.value.status_code == 422
    assert exc.value.detail["code"] == "reason_required"


async def test_cancel_from_various_states_and_replay(db_session):
    env = await _seed_env(db_session)
    svc = _po_service(db_session)
    # from DRAFT
    po = await _create_draft(db_session, env)
    await svc.cancel(actor=env["creator"], po=po, reason="not needed")
    await db_session.commit()
    assert po.status == PurchaseOrderStatus.CANCELLED
    r = await svc.cancel(actor=env["creator"], po=po, reason="again")
    assert r.replay is True
    # from APPROVED (unreceived)
    po2 = await _create_draft(db_session, env)
    await svc.submit(actor=env["creator"], po=po2)
    await db_session.commit()
    await svc.approve(actor=env["approver"], po=po2)
    await db_session.commit()
    await svc.cancel(actor=env["approver"], po=po2, reason="supplier failed")
    await db_session.commit()
    assert po2.status == PurchaseOrderStatus.CANCELLED


async def test_invalid_transitions(db_session):
    env = await _seed_env(db_session)
    po = await _create_draft(db_session, env)
    svc = _po_service(db_session)
    # approve a DRAFT
    with pytest.raises(Exception) as exc:
        await svc.approve(actor=env["approver"], po=po)
    assert exc.value.detail["code"] == "invalid_purchase_order_transition"
    # reject a DRAFT
    with pytest.raises(Exception) as exc2:
        await svc.reject(actor=env["approver"], po=po, reason="x")
    assert exc2.value.detail["code"] == "invalid_purchase_order_transition"


# --------------------------------------------------------------------- #
# Supplier capability governance (Business Partner service, §2)
# --------------------------------------------------------------------- #
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
    await svc.cancel(actor=env["creator"], po=po, reason="done")
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
