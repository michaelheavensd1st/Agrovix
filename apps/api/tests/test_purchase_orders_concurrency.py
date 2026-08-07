"""Release 6.0.3 — Purchase Order PostgreSQL concurrency proofs (§12 / §14.2).

Skipped unless ``DATABASE_URL`` targets PostgreSQL. Each coroutine runs
in its OWN session/transaction so ``SELECT ... FOR UPDATE`` and the
sequence upsert serialise writers exactly as production does.
"""

from __future__ import annotations

import asyncio
import os
from datetime import date
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import text

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
from app.repositories.business_partner import BusinessPartnerRepository
from app.repositories.purchase_order import (
    PurchaseOrderLineRepository,
    PurchaseOrderRepository,
    PurchaseOrderSequenceRepository,
    PurchaseOrderTransitionRepository,
)
from app.services.purchase_order import PurchaseOrderService

pytestmark = pytest.mark.asyncio

_postgres_only = pytest.mark.skipif(
    "postgresql" not in os.environ.get("DATABASE_URL", ""),
    reason="Requires real DB-level concurrency (Postgres); SQLite serialises writers.",
)

TODAY = date(2026, 4, 1)


@pytest_asyncio.fixture(autouse=True)
async def _ensure_engine(_engine):
    """Ensure the shared test engine (schema + seed + session-factory
    swap) is initialised for these fixture-less concurrency tests."""
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


async def _seed():
    async with _db.AsyncSessionLocal() as s:
        org = Organization(name="C", slug=f"org-{uuid4().hex[:10]}", is_active=True)
        creator = User(
            email=f"c-{uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="c",
            is_active=True,
            is_verified=True,
        )
        approver = User(
            email=f"a-{uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="a",
            is_active=True,
            is_verified=True,
        )
        rejecter = User(
            email=f"r-{uuid4().hex[:8]}@x.dev",
            hashed_password="x",
            full_name="r",
            is_active=True,
            is_verified=True,
        )
        s.add_all([org, creator, approver, rejecter])
        await s.flush()
        partner = BusinessPartner(
            organization_id=org.id,
            code=f"SUP-{uuid4().hex[:6]}",
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
            code=f"F-{uuid4().hex[:6]}",
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


async def _create_po(ids) -> str:
    async with _db.AsyncSessionLocal() as s:
        org = await s.get(Organization, ids["org_id"])
        creator = await s.get(User, ids["creator_id"])
        po = await _svc(s).create(
            actor=creator,
            organization=org,
            business_partner_id=ids["partner_id"],
            currency_code="USD",
            order_date=TODAY,
            lines=[_line(ids["item_id"])],
        )
        await s.commit()
        return str(po.id)


async def _submit(ids, po_id):
    async with _db.AsyncSessionLocal() as s:
        creator = await s.get(User, ids["creator_id"])
        svc = _svc(s)
        po = await svc.load_for_tenant(
            __import__("uuid").UUID(po_id), expected_org_id=ids["org_id"], for_update=True
        )
        await svc.submit(actor=creator, po=po)
        await s.commit()


# --------------------------------------------------------------------- #
@_postgres_only
async def test_concurrent_sequence_allocation_unique_monotonic():
    ids = await _seed()
    results = await asyncio.gather(*[_create_po(ids) for _ in range(8)])
    async with _db.AsyncSessionLocal() as s:
        numbers = []
        for po_id in results:
            po = await s.get(PurchaseOrder, __import__("uuid").UUID(po_id))
            numbers.append(po.po_number)
    assert len(set(numbers)) == 8, numbers
    suffixes = sorted(int(n.split("-")[-1]) for n in numbers)
    assert suffixes == list(range(1, 9))


@_postgres_only
async def test_different_org_year_independent_sequences():
    ids_a = await _seed()
    ids_b = await _seed()
    a = await _create_po(ids_a)
    b = await _create_po(ids_b)
    async with _db.AsyncSessionLocal() as s:
        import uuid as _u

        po_a = await s.get(PurchaseOrder, _u.UUID(a))
        po_b = await s.get(PurchaseOrder, _u.UUID(b))
    assert po_a.po_number.endswith("000001")
    assert po_b.po_number.endswith("000001")


@_postgres_only
async def test_concurrent_patch_same_version_one_winner():
    import uuid as _u

    ids = await _seed()
    po_id = await _create_po(ids)

    async def patch(note):
        async with _db.AsyncSessionLocal() as s:
            svc = _svc(s)
            creator = await s.get(User, ids["creator_id"])
            po = await svc.load_for_tenant(
                _u.UUID(po_id), expected_org_id=ids["org_id"], for_update=True
            )
            try:
                await svc.update_draft(
                    actor=creator, po=po, expected_version=1, data={"notes": note}
                )
                await s.commit()
                return "ok"
            except Exception as exc:
                await s.rollback()
                return getattr(exc, "detail", {}).get("code", "err")

    outcomes = await asyncio.gather(patch("A"), patch("B"))
    assert sorted(outcomes) == ["ok", "purchase_order_version_conflict"], outcomes


@_postgres_only
async def test_concurrent_approve_reject_serialize():
    import uuid as _u

    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def approve():
        async with _db.AsyncSessionLocal() as s:
            svc = _svc(s)
            actor = await s.get(User, ids["approver_id"])
            po = await svc.load_for_tenant(
                _u.UUID(po_id), expected_org_id=ids["org_id"], for_update=True
            )
            try:
                r = await svc.approve(actor=actor, po=po)
                await s.commit()
                return "approved" if not r.replay else "approve_replay"
            except Exception as exc:
                await s.rollback()
                return getattr(exc, "detail", {}).get("code", "err")

    async def reject():
        async with _db.AsyncSessionLocal() as s:
            svc = _svc(s)
            actor = await s.get(User, ids["rejecter_id"])
            po = await svc.load_for_tenant(
                _u.UUID(po_id), expected_org_id=ids["org_id"], for_update=True
            )
            try:
                await svc.reject(actor=actor, po=po, reason="no")
                await s.commit()
                return "rejected"
            except Exception as exc:
                await s.rollback()
                return getattr(exc, "detail", {}).get("code", "err")

    outcomes = await asyncio.gather(approve(), reject())
    # Exactly one wins; the loser sees an invalid-transition conflict.
    assert "invalid_purchase_order_transition" in outcomes, outcomes
    assert ("approved" in outcomes) or ("rejected" in outcomes), outcomes
    async with _db.AsyncSessionLocal() as s:
        po = await s.get(PurchaseOrder, _u.UUID(po_id))
    assert po.status in (PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.REJECTED)


@_postgres_only
async def test_self_approval_forbidden_under_concurrency():
    import uuid as _u

    ids = await _seed()
    po_id = await _create_po(ids)
    await _submit(ids, po_id)

    async def approve(user_id):
        async with _db.AsyncSessionLocal() as s:
            svc = _svc(s)
            actor = await s.get(User, user_id)
            po = await svc.load_for_tenant(
                _u.UUID(po_id), expected_org_id=ids["org_id"], for_update=True
            )
            try:
                await svc.approve(actor=actor, po=po)
                await s.commit()
                return "approved"
            except Exception as exc:
                await s.rollback()
                return getattr(exc, "detail", {}).get("code", "err")

    creator_outcome, approver_outcome = await asyncio.gather(
        approve(ids["creator_id"]), approve(ids["approver_id"])
    )
    # The creator can NEVER approve, no matter the race ordering.
    assert creator_outcome in ("purchase_order_self_approval_forbidden",)
    assert approver_outcome in ("approved", "purchase_order_self_approval_forbidden")


@_postgres_only
async def test_db_rejects_received_above_ordered():
    import uuid as _u

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
            # ordered_quantity is 10 — drive received above it.
            await s.execute(
                text("UPDATE purchase_order_lines SET received_quantity = 999 WHERE id = :i"),
                {"i": line_id},
            )
            await s.commit()
