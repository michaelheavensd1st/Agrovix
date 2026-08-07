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
from datetime import date

import pytest
import pytest_asyncio

from app.db import session as _db
from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapability,
    BusinessPartnerCapabilityCode,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
    BusinessPartnerSupplierProfile,
)
from app.models.inventory import InventoryItem, InventoryItemCategory, StockUnit
from app.models.organization import Organization
from app.models.purchase_order import PurchaseOrder, PurchaseOrderStatus
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
        s.add_all([org, creator, approver, rejecter])
        await s.flush()
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
    assert "submitted" in outcomes
    assert ("edited" in outcomes) or ("invalid_purchase_order_transition" in outcomes), outcomes


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
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    # Both start from DRAFT; both may legitimately succeed in sequence
    # (draft→submitted then submitted→cancelled, or draft→cancelled then
    # submit fails). The PO ends in a single deterministic state.
    assert po.status in (PurchaseOrderStatus.SUBMITTED, PurchaseOrderStatus.CANCELLED)
    assert "cancelled" in outcomes or "submitted" in outcomes


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
    assert "invalid_purchase_order_transition" in outcomes, outcomes
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    assert po.status in (PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.REJECTED)


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
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    assert po.status in (PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.CANCELLED)
    assert "approved" in outcomes or "cancelled" in outcomes


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
    assert approver_outcome in ("approved", "purchase_order_self_approval_forbidden")


@_postgres_only
async def test_capability_removal_race_with_submit():
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

    outcomes = await asyncio.gather(submit(), remove_cap())
    # The partner-row lock serialises the two. Consistent terminal state:
    # either submit wins (cap removal blocked) or cap removal wins (submit
    # fails the supplier-capability check).
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
        cap = await BusinessPartnerCapabilityRepository(s).get(
            ids["partner_id"], BusinessPartnerCapabilityCode.SUPPLIER
        )
    if "removed" in outcomes:
        # capability gone ⇒ the PO must NOT be submitted
        assert cap is None
        assert po.status == PurchaseOrderStatus.DRAFT
        assert "business_partner_not_supplier" in outcomes
    else:
        assert cap is not None
        assert "submitted" in outcomes
        assert "business_partner_supplier_capability_in_use" in outcomes


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
