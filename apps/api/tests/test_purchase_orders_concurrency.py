"""Release 6.0.3 — Purchase Order PostgreSQL concurrency proofs (Sprint 1.1).

Skipped unless ``DATABASE_URL`` targets PostgreSQL. Each coroutine runs
in its OWN session/transaction so ``SELECT ... FOR UPDATE`` and the
sequence upsert serialise writers exactly as production does. Covers the
review's required race matrix:

* sequence allocation uniqueness + monotonicity + per-org/year isolation
* edit vs submit
* submit vs cancel
* approve vs cancel
* simultaneous approvals
* self-approval under concurrency
* supplier capability-removal race
* rollback / readback consistency + received-accumulator DB guards
"""

from __future__ import annotations

import asyncio
import os
import uuid as _u
from datetime import UTC, date, datetime

import pytest
import pytest_asyncio
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from app.db import session as _db
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
from app.models.purchase_order import PurchaseOrder, PurchaseOrderSequence, PurchaseOrderStatus
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

_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serialises writers.",
)

TODAY = date(2026, 4, 1)


@pytest_asyncio.fixture(autouse=True)
async def _ensure_engine(_engine):
    """Initialise the shared test engine (schema + seed + session-factory
    swap) for these fixture-less concurrency tests."""
    yield


def _svc(session) -> PurchaseOrderService:
    return PurchaseOrderService(
        po_repo=PurchaseOrderRepository(session),
        line_repo=PurchaseOrderLineRepository(session),
        transition_repo=PurchaseOrderTransitionRepository(session),
        sequence_repo=PurchaseOrderSequenceRepository(session),
        partner_repo=BusinessPartnerRepository(session),
        audit_repo=AuditRepository(session),
    )


def _bp_svc(session) -> BusinessPartnerService:
    return BusinessPartnerService(
        partner_repo=BusinessPartnerRepository(session),
        capability_repo=BusinessPartnerCapabilityRepository(session),
        profile_repo=BusinessPartnerSupplierProfileRepository(session),
        contact_repo=BusinessPartnerContactRepository(session),
        audit_repo=AuditRepository(session),
    )


async def _seed():
    async with _db.AsyncSessionLocal() as s:
        org = Organization(name="C", slug=f"org-{_u.uuid4().hex[:10]}", is_active=True)
        creator = User(
            email=f"c-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="c",
            is_active=True,
            is_verified=True,
            is_superuser=True,
        )
        approver = User(
            email=f"a-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="a",
            is_active=True,
            is_verified=True,
            is_superuser=True,
        )
        rejecter = User(
            email=f"r-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="r",
            is_active=True,
            is_verified=True,
            is_superuser=True,
        )
        buyer = User(
            email=f"b-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="b",
            is_active=True,
            is_verified=True,
            is_superuser=False,
        )
        decision_actor = User(
            email=f"d-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="d",
            is_active=True,
            is_verified=True,
            is_superuser=False,
        )
        s.add_all([org, creator, approver, rejecter, buyer, decision_actor])
        await s.flush()
        owner_role = (
            await s.execute(select(Role).where(Role.name == "organization_owner"))
        ).scalar_one()
        for actor in (buyer, decision_actor):
            s.add(OrganizationMembership(user_id=actor.id, organization_id=org.id, is_active=True))
            s.add(
                RoleAssignment(
                    user_id=actor.id,
                    role_id=owner_role.id,
                    organization_id=org.id,
                )
            )
        partner = BusinessPartner(
            organization_id=org.id,
            code=f"SUP-{_u.uuid4().hex[:6]}",
            legal_name="Acme",
            is_active=True,
        )
        s.add(partner)
        await s.flush()
        s.add(
            BusinessPartnerCapability(
                business_partner_id=partner.id,
                capability=BusinessPartnerCapabilityCode.SUPPLIER,
            )
        )
        s.add(
            BusinessPartnerSupplierProfile(
                business_partner_id=partner.id,
                qualification_status=BusinessPartnerQualificationStatus.APPROVED,
                preference_tier=BusinessPartnerPreferenceTier.STANDARD,
            )
        )
        item = InventoryItem(
            organization_id=org.id,
            code=f"F-{_u.uuid4().hex[:6]}",
            name="Feed",
            category=InventoryItemCategory.FEED,
            canonical_unit=StockUnit.KG,
            is_active=True,
        )
        s.add(item)
        await s.flush()
        await s.commit()
        return {
            "org_id": org.id,
            "creator_id": creator.id,
            "approver_id": approver.id,
            "rejecter_id": rejecter.id,
            "buyer_id": buyer.id,
            "decision_actor_id": decision_actor.id,
            "partner_id": partner.id,
            "item_id": item.id,
        }


def _line(item_id):
    return {
        "inventory_item_id": str(item_id),
        "ordered_quantity": "10",
        "ordered_unit": "kg",
        "unit_price": "2.50",
    }


async def _create_po(ids, *, order_date=TODAY) -> str:
    async with _db.AsyncSessionLocal() as s:
        creator = await s.get(User, ids["creator_id"])
        po = await _svc(s).create(
            actor=creator,
            organization_id=ids["org_id"],
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=order_date,
            lines=[_line(ids["item_id"])],
        )
        await s.commit()
        return str(po.id)


async def _submit(ids, po_id):
    async with _db.AsyncSessionLocal() as s:
        creator = await s.get(User, ids["creator_id"])
        await _svc(s).submit(actor=creator, organization_id=ids["org_id"], po_id=_u.UUID(po_id))
        await s.commit()


def _code(exc: Exception) -> str:
    return getattr(exc, "detail", {}).get("code", "err") if hasattr(exc, "detail") else "err"


# --------------------------------------------------------------------- #
@_postgres_only
async def test_concurrent_sequence_allocation_unique_monotonic():
    ids = await _seed()
    results = await asyncio.gather(*[_create_po(ids) for _ in range(8)])
    async with _db.AsyncSessionLocal() as s:
        numbers = [(await s.get(PurchaseOrder, _u.UUID(po_id))).po_number for po_id in results]
    assert len(set(numbers)) == 8, numbers
    assert sorted(int(n.split("-")[-1]) for n in numbers) == list(range(1, 9))


@_postgres_only
async def test_different_org_year_independent_sequences():
    ids_a = await _seed()
    ids_b = await _seed()
    a = await _create_po(ids_a)
    b = await _create_po(ids_b, order_date=date(2027, 1, 1))
    async with _db.AsyncSessionLocal() as s:
        po_a = await s.get(PurchaseOrder, _u.UUID(a))
        po_b = await s.get(PurchaseOrder, _u.UUID(b))
    assert po_a.po_number == "PO-2026-000001"
    assert po_b.po_number == "PO-2027-000001"


@_postgres_only
async def test_concurrent_patch_same_version_one_winner():
    ids = await _seed()
    po_id = await _create_po(ids)

    async def patch(note):
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).update_draft(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                    expected_version=1,
                    data={"notes": note},
                )
                await s.commit()
                return "ok"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(patch("A"), patch("B"))
    assert sorted(outcomes) == ["ok", "purchase_order_version_conflict"], outcomes


@_postgres_only
async def test_edit_vs_submit_serialize():
    ids = await _seed()
    po_id = await _create_po(ids)

    async def edit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).update_draft(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                    expected_version=1,
                    data={"notes": "late edit"},
                )
                await s.commit()
                return "edited"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(edit(), submit())
    # Both serialise on the PO lock. Whoever runs second sees consistent
    # state: if submit wins first, the edit sees a non-draft PO.
    assert tuple(outcomes) in {
        ("edited", "submitted"),
        ("invalid_purchase_order_transition", "submitted"),
    }
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        transition_count = await PurchaseOrderTransitionRepository(s).count_for_po(po.id)
        assert po.status == PurchaseOrderStatus.SUBMITTED
        assert transition_count == 2
        assert (po.version, po.notes) in {(3, "late edit"), (2, None)}


@_postgres_only
async def test_submit_vs_cancel_serialize():
    ids = await _seed()
    po_id = await _create_po(ids)

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    async def cancel():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).cancel(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                    reason="stop",
                )
                await s.commit()
                return "cancelled"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(submit(), cancel())
    assert tuple(outcomes) in {
        ("submitted", "cancelled"),
        ("invalid_purchase_order_transition", "cancelled"),
    }
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        transition_count = await PurchaseOrderTransitionRepository(s).count_for_po(po.id)
        audit_count = (
            await s.execute(
                select(func.count())
                .select_from(AuditEvent)
                .where(
                    AuditEvent.entity_type == "purchase_order",
                    AuditEvent.entity_id == str(po.id),
                )
            )
        ).scalar_one()
        assert po.status == PurchaseOrderStatus.CANCELLED
        assert po.version == transition_count
        assert (po.version, audit_count) in {(3, 5), (2, 3)}


@_postgres_only
async def test_concurrent_approve_reject_serialize():
    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def act(kind, user_id):
        async with _db.AsyncSessionLocal() as s:
            svc = _svc(s)
            actor = await s.get(User, user_id)
            try:
                if kind == "approve":
                    r = await svc.approve(
                        actor=actor, organization_id=ids["org_id"], po_id=_u.UUID(po_id)
                    )
                    await s.commit()
                    return "approved" if not r.replay else "approve_replay"
                await svc.reject(
                    actor=actor, organization_id=ids["org_id"], po_id=_u.UUID(po_id), reason="no"
                )
                await s.commit()
                return "rejected"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(
        act("approve", ids["approver_id"]), act("reject", ids["rejecter_id"])
    )
    assert tuple(outcomes) in {
        ("approved", "invalid_purchase_order_transition"),
        ("invalid_purchase_order_transition", "rejected"),
    }
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        transition_count = await PurchaseOrderTransitionRepository(s).count_for_po(po.id)
        assert po.status == (
            PurchaseOrderStatus.APPROVED
            if outcomes[0] == "approved"
            else PurchaseOrderStatus.REJECTED
        )
        assert po.version == transition_count == 3


@_postgres_only
async def test_approve_vs_cancel_serialize():
    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def approve():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).approve(
                    actor=await s.get(User, ids["approver_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "approved"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    async def cancel():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).cancel(
                    actor=await s.get(User, ids["approver_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                    reason="stop",
                )
                await s.commit()
                return "cancelled"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(approve(), cancel())
    assert tuple(outcomes) in {
        ("approved", "cancelled"),
        ("invalid_purchase_order_transition", "cancelled"),
    }
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        transition_count = await PurchaseOrderTransitionRepository(s).count_for_po(po.id)
        audit_count = (
            await s.execute(
                select(func.count())
                .select_from(AuditEvent)
                .where(
                    AuditEvent.entity_type == "purchase_order",
                    AuditEvent.entity_id == str(po.id),
                )
            )
        ).scalar_one()
        assert po.status == PurchaseOrderStatus.CANCELLED
        assert po.version == transition_count
        assert (po.version, audit_count) in {(4, 7), (3, 5)}


@_postgres_only
async def test_simultaneous_approvals_single_effect():
    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def approve():
        async with _db.AsyncSessionLocal() as s:
            try:
                r = await _svc(s).approve(
                    actor=await s.get(User, ids["approver_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "approved" if not r.replay else "replay"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(approve(), approve())
    # Exactly one real approval; the other is an idempotent replay.
    assert outcomes.count("approved") == 1 and outcomes.count("replay") == 1, outcomes
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    assert po.status == PurchaseOrderStatus.APPROVED and po.version == 3


@_postgres_only
async def test_self_approval_forbidden_under_concurrency():
    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def approve(user_id):
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).approve(
                    actor=await s.get(User, user_id),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "approved"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    creator_outcome, approver_outcome = await asyncio.gather(
        approve(ids["creator_id"]), approve(ids["approver_id"])
    )
    assert creator_outcome == "purchase_order_self_approval_forbidden"
    assert approver_outcome == "approved"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        assert po.status == PurchaseOrderStatus.APPROVED
        assert po.version == 3
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 3


@_postgres_only
async def test_capability_removal_race_with_po_create():
    ids = await _seed()

    async def create():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).create(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    business_partner_id=ids["partner_id"],
                    currency_code="USD",
                    order_date=TODAY,
                    lines=[_line(ids["item_id"])],
                )
                await s.commit()
                return "created"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    async def remove_cap():
        async with _db.AsyncSessionLocal() as s:
            try:
                partner = await BusinessPartnerRepository(s).get_by_id(
                    ids["partner_id"], with_relations=True
                )
                await _bp_svc(s).remove_capability(
                    actor=await s.get(User, ids["creator_id"]),
                    partner=partner,
                    capability=BusinessPartnerCapabilityCode.SUPPLIER,
                    request_ctx={},
                )
                await s.commit()
                return "removed"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.gather(create(), remove_cap())
    # There is no pre-existing PO dependency: the racing create is what makes
    # the capability material. The shared partner lock produces exactly one
    # legal outcome pair.
    async with _db.AsyncSessionLocal() as s:
        po_count = (
            await s.execute(
                select(func.count())
                .select_from(PurchaseOrder)
                .where(PurchaseOrder.organization_id == ids["org_id"])
            )
        ).scalar_one()
        cap = await BusinessPartnerCapabilityRepository(s).get(
            ids["partner_id"], BusinessPartnerCapabilityCode.SUPPLIER
        )
    if tuple(outcomes) == ("business_partner_not_supplier", "removed"):
        assert cap is None
        assert po_count == 0
    else:
        assert tuple(outcomes) == ("created", "business_partner_supplier_capability_in_use")
        assert cap is not None
        assert po_count == 1


@_postgres_only
async def test_db_rejects_received_above_ordered():
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    ids = await _seed()
    po_id = await _create_po(ids)
    with pytest.raises(IntegrityError):
        async with _db.AsyncSessionLocal() as s:
            line_id = (
                await s.execute(
                    text(
                        "SELECT id FROM purchase_order_lines WHERE purchase_order_id = :p LIMIT 1"
                    ),
                    {"p": _u.UUID(po_id)},
                )
            ).scalar_one()
            await s.execute(
                text("UPDATE purchase_order_lines SET received_quantity = 999 WHERE id = :i"),
                {"i": line_id},
            )
            await s.commit()


@_postgres_only
async def test_db_rejects_received_canonical_above_ordered():
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    ids = await _seed()
    po_id = await _create_po(ids)
    with pytest.raises(IntegrityError):
        async with _db.AsyncSessionLocal() as s:
            line_id = (
                await s.execute(
                    text(
                        "SELECT id FROM purchase_order_lines WHERE purchase_order_id = :p LIMIT 1"
                    ),
                    {"p": _u.UUID(po_id)},
                )
            ).scalar_one()
            await s.execute(
                text(
                    "UPDATE purchase_order_lines "
                    "SET received_quantity_canonical = 999999 WHERE id = :i"
                ),
                {"i": line_id},
            )
            await s.commit()


@_postgres_only
async def test_rollback_readback_consistency():
    ids = await _seed()
    # Allocate + roll back; a fresh committed create must reuse value 1.
    async with _db.AsyncSessionLocal() as s:
        await _svc(s).create(
            actor=await s.get(User, ids["creator_id"]),
            organization_id=ids["org_id"],
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(ids["item_id"])],
        )
        await s.rollback()
    po_id = await _create_po(ids)
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    assert po.po_number == f"PO-{TODAY.year}-000001"


async def _hold_qualification_change(ids, release: asyncio.Event, locked: asyncio.Event):
    async with _db.AsyncSessionLocal() as s:
        partner = await BusinessPartnerRepository(s).get_by_id(
            ids["partner_id"], with_relations=True
        )
        await _bp_svc(s).upsert_supplier_profile(
            actor=await s.get(User, ids["creator_id"]),
            partner=partner,
            data={
                "qualification_status": BusinessPartnerQualificationStatus.BLOCKED,
                "preference_tier": BusinessPartnerPreferenceTier.STANDARD,
            },
            request_ctx={},
        )
        locked.set()
        await release.wait()
        await s.commit()


@_postgres_only
async def test_submit_vs_qualification_downgrade_serializes():
    ids = await _seed()
    po_id = await _create_po(ids)
    release, locked = asyncio.Event(), asyncio.Event()
    downgrade = asyncio.create_task(_hold_qualification_change(ids, release, locked))
    await locked.wait()

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, ids["buyer_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    submitted = asyncio.create_task(submit())
    await asyncio.sleep(0.05)
    release.set()
    await downgrade
    assert await submitted == "business_partner_blocked"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 1


@_postgres_only
async def test_approve_vs_qualification_downgrade_serializes():
    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)
    release, locked = asyncio.Event(), asyncio.Event()
    downgrade = asyncio.create_task(_hold_qualification_change(ids, release, locked))
    await locked.wait()

    async def approve():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).approve(
                    actor=await s.get(User, ids["decision_actor_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "approved"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    approval = asyncio.create_task(approve())
    await asyncio.sleep(0.05)
    release.set()
    await downgrade
    assert await approval == "business_partner_blocked"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        assert po.status == PurchaseOrderStatus.SUBMITTED
        assert po.version == 2
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 2


@_postgres_only
async def test_supplier_deactivation_wins_against_submit():
    ids = await _seed()
    po_id = await _create_po(ids)
    release, locked = asyncio.Event(), asyncio.Event()

    async def deactivate():
        async with _db.AsyncSessionLocal() as s:
            partner = await BusinessPartnerRepository(s).get_by_id(
                ids["partner_id"], with_relations=True
            )
            await _bp_svc(s).deactivate(
                actor=await s.get(User, ids["creator_id"]),
                partner=partner,
                reason="governance",
                request_ctx={},
            )
            locked.set()
            await release.wait()
            await s.commit()

    deactivation = asyncio.create_task(deactivate())
    await locked.wait()

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, ids["buyer_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    submission = asyncio.create_task(submit())
    await asyncio.sleep(0.05)
    release.set()
    await deactivation
    assert await submission == "business_partner_inactive"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 1


@_postgres_only
@pytest.mark.parametrize("revocation_kind", ["membership", "assignment"])
async def test_authorization_revocation_wins_against_submit(revocation_kind):
    ids = await _seed()
    po_id = await _create_po(ids)
    release, locked = asyncio.Event(), asyncio.Event()

    async def revoke():
        async with _db.AsyncSessionLocal() as s:
            if revocation_kind == "membership":
                row = (
                    await s.execute(
                        select(OrganizationMembership).where(
                            OrganizationMembership.user_id == ids["buyer_id"],
                            OrganizationMembership.organization_id == ids["org_id"],
                        )
                    )
                ).scalar_one()
                row.is_active = False
            else:
                row = (
                    await s.execute(
                        select(RoleAssignment).where(
                            RoleAssignment.user_id == ids["buyer_id"],
                            RoleAssignment.organization_id == ids["org_id"],
                        )
                    )
                ).scalar_one()
                row.revoked_at = datetime.now(UTC)
            await s.flush()
            locked.set()
            await release.wait()
            await s.commit()

    revocation = asyncio.create_task(revoke())
    await locked.wait()

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, ids["buyer_id"]),
                    organization_id=ids["org_id"],
                    po_id=_u.UUID(po_id),
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    submission = asyncio.create_task(submit())
    await asyncio.sleep(0.05)
    release.set()
    await revocation
    assert await submission == "not_authorized"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 1


@_postgres_only
async def test_role_assignment_revocation_wins_against_approval():
    ids = await _seed()
    po_id = _u.UUID(await _create_po(ids))
    await _submit(ids, str(po_id))
    release, locked = asyncio.Event(), asyncio.Event()

    async def revoke():
        async with _db.AsyncSessionLocal() as s:
            assignment = (
                await s.execute(
                    select(RoleAssignment).where(
                        RoleAssignment.user_id == ids["decision_actor_id"],
                        RoleAssignment.organization_id == ids["org_id"],
                    )
                )
            ).scalar_one()
            assignment.revoked_at = datetime.now(UTC)
            await s.flush()
            locked.set()
            await release.wait()
            await s.commit()

    revocation = asyncio.create_task(revoke())
    await locked.wait()

    async def approve():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).approve(
                    actor=await s.get(User, ids["decision_actor_id"]),
                    organization_id=ids["org_id"],
                    po_id=po_id,
                )
                await s.commit()
                return "approved"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    approval = asyncio.create_task(approve())
    await asyncio.sleep(0.05)
    release.set()
    await revocation
    assert await approval == "not_authorized"

    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, po_id)
        audit_count = (
            await s.execute(
                select(func.count())
                .select_from(AuditEvent)
                .where(
                    AuditEvent.entity_type == "purchase_order",
                    AuditEvent.entity_id == str(po_id),
                )
            )
        ).scalar_one()
        assert po.status == PurchaseOrderStatus.SUBMITTED
        assert po.version == 2
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po_id) == 2
        assert audit_count == 3


@_postgres_only
@pytest.mark.parametrize(
    ("revocation_kind", "expected"),
    [("farm_membership", "not_authorized"), ("farm", "not_authorized")],
)
async def test_farm_scope_revocation_wins_against_submit(revocation_kind, expected):
    ids = await _seed()
    async with _db.AsyncSessionLocal() as s:
        farm = Farm(
            organization_id=ids["org_id"],
            name="Scoped farm",
            code=f"F-{_u.uuid4().hex[:6]}",
            is_active=True,
        )
        scoped = User(
            email=f"fm-{_u.uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="fm",
            is_active=True,
            is_verified=True,
            is_superuser=False,
        )
        s.add_all([farm, scoped])
        await s.flush()
        role = (await s.execute(select(Role).where(Role.name == "farm_manager"))).scalar_one()
        s.add_all(
            [
                OrganizationMembership(
                    user_id=scoped.id, organization_id=ids["org_id"], is_active=True
                ),
                FarmMembership(user_id=scoped.id, farm_id=farm.id, is_active=True),
                RoleAssignment(
                    user_id=scoped.id,
                    role_id=role.id,
                    organization_id=ids["org_id"],
                    farm_id=farm.id,
                ),
            ]
        )
        await s.commit()
        farm_id, scoped_id = farm.id, scoped.id
    async with _db.AsyncSessionLocal() as s:
        po = await _svc(s).create(
            actor=await s.get(User, ids["creator_id"]),
            organization_id=ids["org_id"],
            farm_id=farm_id,
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(ids["item_id"])],
        )
        await s.commit()
        po_id = po.id

    release, locked = asyncio.Event(), asyncio.Event()

    async def revoke():
        async with _db.AsyncSessionLocal() as s:
            if revocation_kind == "farm_membership":
                row = (
                    await s.execute(
                        select(FarmMembership).where(
                            FarmMembership.user_id == scoped_id,
                            FarmMembership.farm_id == farm_id,
                        )
                    )
                ).scalar_one()
                row.is_active = False
            else:
                row = await s.get(Farm, farm_id)
                row.is_active = False
            await s.flush()
            locked.set()
            await release.wait()
            await s.commit()

    revocation = asyncio.create_task(revoke())
    await locked.wait()

    async def submit():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).submit(
                    actor=await s.get(User, scoped_id),
                    organization_id=ids["org_id"],
                    po_id=po_id,
                )
                await s.commit()
                return "submitted"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    submission = asyncio.create_task(submit())
    await asyncio.sleep(0.05)
    release.set()
    await revocation
    assert await submission == expected
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, po_id)
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 1


@_postgres_only
async def test_opposing_supplier_farm_item_swaps_do_not_deadlock():
    ids = await _seed()
    async with _db.AsyncSessionLocal() as s:
        partner_b = BusinessPartner(
            organization_id=ids["org_id"],
            code=f"SUP-{_u.uuid4().hex[:6]}",
            legal_name="Supplier B",
            is_active=True,
        )
        farm_a = Farm(
            organization_id=ids["org_id"], name="A", code=f"A-{_u.uuid4().hex[:6]}", is_active=True
        )
        farm_b = Farm(
            organization_id=ids["org_id"], name="B", code=f"B-{_u.uuid4().hex[:6]}", is_active=True
        )
        item_b = InventoryItem(
            organization_id=ids["org_id"],
            code=f"I-{_u.uuid4().hex[:6]}",
            name="Item B",
            category=InventoryItemCategory.FEED,
            canonical_unit=StockUnit.KG,
            is_active=True,
        )
        s.add_all([partner_b, farm_a, farm_b, item_b])
        await s.flush()
        s.add_all(
            [
                BusinessPartnerCapability(
                    business_partner_id=partner_b.id,
                    capability=BusinessPartnerCapabilityCode.SUPPLIER,
                ),
                BusinessPartnerSupplierProfile(
                    business_partner_id=partner_b.id,
                    qualification_status=BusinessPartnerQualificationStatus.APPROVED,
                    preference_tier=BusinessPartnerPreferenceTier.STANDARD,
                ),
            ]
        )
        await s.commit()
        partner_b_id, farm_a_id, farm_b_id, item_b_id = (
            partner_b.id,
            farm_a.id,
            farm_b.id,
            item_b.id,
        )

    async def create(partner_id, farm_id, item_id):
        async with _db.AsyncSessionLocal() as s:
            po = await _svc(s).create(
                actor=await s.get(User, ids["creator_id"]),
                organization_id=ids["org_id"],
                business_partner_id=partner_id,
                farm_id=farm_id,
                currency_code="USD",
                order_date=TODAY,
                lines=[_line(item_id)],
            )
            await s.commit()
            return po.id

    po_a = await create(ids["partner_id"], farm_a_id, ids["item_id"])
    po_b = await create(partner_b_id, farm_b_id, item_b_id)

    async def swap(po_id, actor_id, partner_id, farm_id, item_id):
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).update_draft(
                    actor=await s.get(User, actor_id),
                    organization_id=ids["org_id"],
                    po_id=po_id,
                    expected_version=1,
                    data={
                        "business_partner_id": partner_id,
                        "farm_id": farm_id,
                        "lines": [_line(item_id)],
                    },
                )
                await s.commit()
                return "updated"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    outcomes = await asyncio.wait_for(
        asyncio.gather(
            swap(po_a, ids["creator_id"], partner_b_id, farm_b_id, item_b_id),
            swap(po_b, ids["approver_id"], ids["partner_id"], farm_a_id, ids["item_id"]),
        ),
        timeout=10,
    )
    assert outcomes == ["updated", "updated"]
    async with _db.AsyncSessionLocal() as s:
        a, b = await s.get(PurchaseOrder, po_a), await s.get(PurchaseOrder, po_b)
        await s.refresh(a, attribute_names=["lines"])
        await s.refresh(b, attribute_names=["lines"])
        assert (a.business_partner_id, a.farm_id) == (partner_b_id, farm_b_id)
        assert (b.business_partner_id, b.farm_id) == (ids["partner_id"], farm_a_id)
        assert [line.inventory_item_id for line in a.lines] == [item_b_id]
        assert [line.inventory_item_id for line in b.lines] == [ids["item_id"]]
        assert a.version == b.version == 2
        assert await PurchaseOrderTransitionRepository(s).count_for_po(a.id) == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(b.id) == 1
        audit_counts = dict(
            (
                await s.execute(
                    select(AuditEvent.entity_id, func.count())
                    .where(AuditEvent.entity_id.in_([str(a.id), str(b.id)]))
                    .group_by(AuditEvent.entity_id)
                )
            ).all()
        )
        assert audit_counts == {str(a.id): 2, str(b.id): 2}


@_postgres_only
async def test_farm_deactivation_wins_against_update_draft():
    ids = await _seed()
    async with _db.AsyncSessionLocal() as s:
        farm = Farm(
            organization_id=ids["org_id"],
            name="Update race farm",
            code=f"UF-{_u.uuid4().hex[:6]}",
            is_active=True,
        )
        s.add(farm)
        await s.commit()
        farm_id = farm.id

    async with _db.AsyncSessionLocal() as s:
        po = await _svc(s).create(
            actor=await s.get(User, ids["creator_id"]),
            organization_id=ids["org_id"],
            farm_id=farm_id,
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(ids["item_id"])],
        )
        await s.commit()
        po_id = po.id

    release, locked = asyncio.Event(), asyncio.Event()

    async def deactivate():
        async with _db.AsyncSessionLocal() as s:
            farm = await s.get(Farm, farm_id)
            farm.is_active = False
            await s.flush()
            locked.set()
            await release.wait()
            await s.commit()

    deactivation = asyncio.create_task(deactivate())
    await locked.wait()

    async def update():
        async with _db.AsyncSessionLocal() as s:
            try:
                await _svc(s).update_draft(
                    actor=await s.get(User, ids["creator_id"]),
                    organization_id=ids["org_id"],
                    po_id=po_id,
                    expected_version=1,
                    data={"notes": "must not commit against an inactive farm"},
                )
                await s.commit()
                return "updated"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    mutation = asyncio.create_task(update())
    await asyncio.sleep(0.05)
    release.set()
    await deactivation
    assert await mutation == "not_found"

    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, po_id)
        farm = await s.get(Farm, farm_id)
        transition_count = await PurchaseOrderTransitionRepository(s).count_for_po(po_id)
        audit_count = (
            await s.execute(
                select(func.count())
                .select_from(AuditEvent)
                .where(
                    AuditEvent.entity_type == "purchase_order",
                    AuditEvent.entity_id == str(po_id),
                )
            )
        ).scalar_one()
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert po.farm_id == farm_id
        assert po.notes is None
        assert farm.is_active is False
        assert transition_count == 1
        assert audit_count == 1


@_postgres_only
@pytest.mark.parametrize("operation", ["submit", "update"])
async def test_inventory_deactivation_wins_against_po_mutation(operation):
    ids = await _seed()
    po_id = _u.UUID(await _create_po(ids))
    release, locked = asyncio.Event(), asyncio.Event()

    async def deactivate():
        async with _db.AsyncSessionLocal() as s:
            item = await s.get(InventoryItem, ids["item_id"])
            item.is_active = False
            await s.flush()
            locked.set()
            await release.wait()
            await s.commit()

    deactivation = asyncio.create_task(deactivate())
    await locked.wait()

    async def mutate():
        async with _db.AsyncSessionLocal() as s:
            try:
                svc = _svc(s)
                actor = await s.get(User, ids["buyer_id"])
                if operation == "submit":
                    await svc.submit(actor=actor, organization_id=ids["org_id"], po_id=po_id)
                else:
                    po = await s.get(PurchaseOrder, po_id)
                    await s.refresh(po, attribute_names=["lines"])
                    await svc.update_draft(
                        actor=actor,
                        organization_id=ids["org_id"],
                        po_id=po_id,
                        expected_version=1,
                        data={"lines": [_line(ids["item_id"]) | {"id": str(po.lines[0].id)}]},
                    )
                await s.commit()
                return "mutated"
            except Exception as exc:
                await s.rollback()
                return _code(exc)

    mutation = asyncio.create_task(mutate())
    await asyncio.sleep(0.05)
    release.set()
    await deactivation
    assert await mutation == "not_found"
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, po_id)
        assert po.status == PurchaseOrderStatus.DRAFT
        assert po.version == 1
        assert await PurchaseOrderTransitionRepository(s).count_for_po(po.id) == 1


@_postgres_only
async def test_duplicate_po_number_translation_and_clean_rollback():
    ids = await _seed()
    first_po_id = _u.UUID(await _create_po(ids))
    async with _db.AsyncSessionLocal() as s:
        sequence = await s.get(PurchaseOrderSequence, (ids["org_id"], TODAY.year))
        sequence.last_value = 0
        await s.commit()
    try:
        await _create_po(ids)
    except Exception as exc:
        assert _code(exc) == "duplicate_purchase_order_number"
    else:  # pragma: no cover - authoritative unique constraint must fire
        pytest.fail("Expected duplicate PO number conflict")
    async with _db.AsyncSessionLocal() as s:
        po_numbers = list(
            (
                await s.execute(
                    select(PurchaseOrder.po_number).where(
                        PurchaseOrder.organization_id == ids["org_id"]
                    )
                )
            ).scalars()
        )
        sequence = await s.get(PurchaseOrderSequence, (ids["org_id"], TODAY.year))
        assert po_numbers == [f"PO-{TODAY.year}-000001"]
        assert await s.get(PurchaseOrder, first_po_id) is not None
        assert sequence.last_value == 0
        sequence.last_value = 1
        await s.commit()
    po_id = await _create_po(ids)
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        numbers = list(
            (
                await s.execute(
                    select(PurchaseOrder.po_number)
                    .where(PurchaseOrder.organization_id == ids["org_id"])
                    .order_by(PurchaseOrder.po_number)
                )
            ).scalars()
        )
        assert po.po_number == f"PO-{TODAY.year}-000002"
        assert numbers == [f"PO-{TODAY.year}-000001", f"PO-{TODAY.year}-000002"]


@_postgres_only
async def test_real_unrelated_integrity_error_is_not_mislabeled(monkeypatch):
    ids = await _seed()
    async with _db.AsyncSessionLocal() as s:
        svc = _svc(s)
        original_create = svc.po_repo.create

        async def unrelated_failure(**_kwargs):
            # A real PostgreSQL NOT NULL violation, deliberately unrelated to
            # uq_purchase_order_org_number, must escape as IntegrityError.
            await s.execute(
                text("INSERT INTO purchase_orders (id) VALUES (:id)"),
                {"id": _u.uuid4()},
            )

        monkeypatch.setattr(svc.po_repo, "create", unrelated_failure)
        with pytest.raises(IntegrityError) as exc:
            await svc.create(
                actor=await s.get(User, ids["creator_id"]),
                organization_id=ids["org_id"],
                business_partner_id=ids["partner_id"],
                currency_code="USD",
                order_date=TODAY,
                lines=[_line(ids["item_id"])],
            )
        assert "duplicate_purchase_order_number" not in str(exc.value)
        await s.rollback()
        monkeypatch.setattr(svc.po_repo, "create", original_create)
        po = await svc.create(
            actor=await s.get(User, ids["creator_id"]),
            organization_id=ids["org_id"],
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(ids["item_id"])],
        )
        await s.commit()
        assert po.po_number == f"PO-{TODAY.year}-000001"
