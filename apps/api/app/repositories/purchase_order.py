"""Release 6.0.3 — Purchase Order repositories.

Pure data access + concurrency primitives. Business rules live in
``app.services.purchase_order``. Every query is organization-scoped or
PO-id-anchored (which the service tenancy-authorises first).

Concurrency primitives (Sprint 1.1 remediation):

* :meth:`PurchaseOrderSequenceRepository.allocate` — atomic org/year
  number allocation. Postgres uses ``INSERT ... ON CONFLICT DO UPDATE
  ... RETURNING``; SQLite falls back to a locked read + upsert.
* :meth:`PurchaseOrderRepository.get_by_id_for_update` — ``SELECT ...
  FOR UPDATE`` on the aggregate root.
* :meth:`PurchaseOrderRepository.acquire_dependency_locks` — locks all
  governed dependencies in a single deterministic global order
  (business_partner → supplier profile → capabilities → farm → inventory_items, each by
  ascending PK) so lifecycle operations never deadlock and no
  check-then-act race can slip between validation and mutation.
"""

from __future__ import annotations

import base64
import binascii
import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapability,
    BusinessPartnerSupplierProfile,
)
from app.models.farm import Farm
from app.models.inventory import InventoryItem
from app.models.purchase_order import (
    NON_TERMINAL_STATUSES,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderSequence,
    PurchaseOrderStatus,
    PurchaseOrderTransition,
)

# Internal hard ceiling on any page the repository will return, applied
# regardless of the requested limit (defence in depth for the future API).
MAX_PAGE_LIMIT = 200
DEFAULT_PAGE_LIMIT = 50


def _clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_PAGE_LIMIT
    return max(1, min(int(limit), MAX_PAGE_LIMIT))


# --------------------------------------------------------------------- #
# Cursor helpers — opaque, deterministic, tie-broken on the UUID PK.
# --------------------------------------------------------------------- #
def encode_po_cursor(created_at: datetime, po_id: uuid.UUID) -> str:
    raw = f"{created_at.isoformat()}|{po_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def decode_po_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        ts_str, id_str = raw.split("|", 1)
        return datetime.fromisoformat(ts_str), uuid.UUID(id_str)
    except (ValueError, TypeError, LookupError, binascii.Error) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"code": "invalid_cursor", "message": "Malformed pagination cursor.", "context": {}},
        ) from exc


def _encode_ts_id_cursor(ts: datetime, row_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{row_id}".encode()).decode("ascii")


def _decode_ts_id_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        ts_str, id_str = raw.split("|", 1)
        return datetime.fromisoformat(ts_str), uuid.UUID(id_str)
    except (ValueError, TypeError, LookupError, binascii.Error) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"code": "invalid_cursor", "message": "Malformed pagination cursor.", "context": {}},
        ) from exc


# --------------------------------------------------------------------- #
# Sequence allocation — §10.2 / §12.3
# --------------------------------------------------------------------- #
class PurchaseOrderSequenceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def allocate(self, organization_id: uuid.UUID, year: int) -> str:
        """Allocate the next monotonic PO number for ``(org, year)``."""
        now = datetime.now(UTC)
        is_pg = self.session.get_bind().dialect.name == "postgresql"
        if is_pg:
            stmt = (
                pg_insert(PurchaseOrderSequence)
                .values(organization_id=organization_id, year=year, last_value=1, updated_at=now)
                .on_conflict_do_update(
                    index_elements=["organization_id", "year"],
                    set_={
                        "last_value": PurchaseOrderSequence.last_value + 1,
                        "updated_at": now,
                    },
                )
                .returning(PurchaseOrderSequence.last_value)
            )
            last_value = int((await self.session.execute(stmt)).scalar_one())
        else:
            row = (
                await self.session.execute(
                    select(PurchaseOrderSequence)
                    .where(
                        PurchaseOrderSequence.organization_id == organization_id,
                        PurchaseOrderSequence.year == year,
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if row is None:
                row = PurchaseOrderSequence(
                    organization_id=organization_id, year=year, last_value=1, updated_at=now
                )
                self.session.add(row)
            else:
                row.last_value += 1
                row.updated_at = now
            await self.session.flush()
            last_value = int(row.last_value)
        return f"PO-{year}-{last_value:06d}"


# --------------------------------------------------------------------- #
# Purchase Order aggregate root.
# --------------------------------------------------------------------- #
class PurchaseOrderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **kwargs) -> PurchaseOrder:
        row = PurchaseOrder(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def get_by_id(self, po_id: uuid.UUID, *, with_lines: bool = True) -> PurchaseOrder | None:
        stmt = select(PurchaseOrder).where(PurchaseOrder.id == po_id)
        if with_lines:
            stmt = stmt.options(selectinload(PurchaseOrder.lines))
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_by_id_for_update(self, po_id: uuid.UUID) -> PurchaseOrder | None:
        """Locked read (``SELECT ... FOR UPDATE``; no-op on SQLite)."""
        stmt = (
            select(PurchaseOrder)
            .where(PurchaseOrder.id == po_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def _lock_pks(self, model, ids: Iterable[uuid.UUID]) -> None:
        """Lock a set of rows FOR UPDATE in ascending-PK order.

        Ascending order across every caller guarantees a single global
        lock-acquisition order and therefore deadlock freedom.
        """
        ordered = sorted({i for i in ids if i is not None}, key=str)
        if not ordered:
            return
        await self.session.execute(
            select(model.id).where(model.id.in_(ordered)).order_by(model.id.asc()).with_for_update()
        )

    async def acquire_dependency_locks(
        self,
        *,
        business_partner_id: uuid.UUID,
        farm_id: uuid.UUID | None,
        inventory_item_ids: Iterable[uuid.UUID],
    ) -> None:
        """Deterministic global lock order for all governed dependencies."""
        # 1) supplier row
        await self._lock_pks(BusinessPartner, [business_partner_id])
        # 2) supplier profile row (qualification authority)
        await self.session.execute(
            select(BusinessPartnerSupplierProfile.id)
            .where(BusinessPartnerSupplierProfile.business_partner_id == business_partner_id)
            .order_by(BusinessPartnerSupplierProfile.id.asc())
            .with_for_update()
        )
        # 3) supplier capability rows (by ascending PK)
        cap_ids = (
            (
                await self.session.execute(
                    select(BusinessPartnerCapability.id)
                    .where(BusinessPartnerCapability.business_partner_id == business_partner_id)
                    .order_by(BusinessPartnerCapability.id.asc())
                    .with_for_update()
                )
            )
            .scalars()
            .all()
        )
        _ = cap_ids
        # 4) farm row
        if farm_id is not None:
            await self._lock_pks(Farm, [farm_id])
        # 5) inventory item rows (by ascending PK)
        await self._lock_pks(InventoryItem, list(inventory_item_ids))

    async def count_non_terminal_for_partner(self, partner_id: uuid.UUID) -> int:
        stmt = (
            select(func.count())
            .select_from(PurchaseOrder)
            .where(
                PurchaseOrder.business_partner_id == partner_id,
                PurchaseOrder.status.in_(NON_TERMINAL_STATUSES),
            )
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def list_page(
        self,
        organization_id: uuid.UUID,
        *,
        farm_ids: list[uuid.UUID] | None = None,
        org_scope: bool = True,
        business_partner_id: uuid.UUID | None = None,
        statuses: Iterable[PurchaseOrderStatus] | None = None,
        supplier_search: str | None = None,
        supplier_reference: str | None = None,
        order_date_from: date | None = None,
        order_date_to: date | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> tuple[list[PurchaseOrder], str | None]:
        """Cursor page ordered ``(created_at DESC, id DESC)``.

        Filters compose (AND):

        * ``statuses`` — repeatable status membership filter.
        * ``supplier_search`` — po_number / legal_name / trading_name (ci).
        * ``supplier_reference`` — case-insensitive substring on the header
          supplier reference.
        * ``order_date_from`` / ``order_date_to`` — inclusive date window.
        """
        limit = _clamp_limit(limit)
        base = select(PurchaseOrder).where(PurchaseOrder.organization_id == organization_id)
        if not org_scope:
            base = base.where(PurchaseOrder.farm_id.in_(farm_ids or []))
        if business_partner_id is not None:
            base = base.where(PurchaseOrder.business_partner_id == business_partner_id)
        status_list = list(statuses or [])
        if status_list:
            base = base.where(PurchaseOrder.status.in_(status_list))
        if supplier_search:
            like = f"%{supplier_search.lower()}%"
            base = base.where(
                or_(
                    func.lower(PurchaseOrder.po_number).like(like),
                    func.lower(PurchaseOrder.supplier_legal_name).like(like),
                    func.lower(func.coalesce(PurchaseOrder.supplier_trading_name, "")).like(like),
                )
            )
        if supplier_reference:
            ref_like = f"%{supplier_reference.lower()}%"
            base = base.where(
                func.lower(func.coalesce(PurchaseOrder.supplier_reference, "")).like(ref_like)
            )
        if order_date_from is not None:
            base = base.where(PurchaseOrder.order_date >= order_date_from)
        if order_date_to is not None:
            base = base.where(PurchaseOrder.order_date <= order_date_to)
        if cursor:
            cur_ts, cur_id = decode_po_cursor(cursor)
            base = base.where(
                or_(
                    PurchaseOrder.created_at < cur_ts,
                    and_(PurchaseOrder.created_at == cur_ts, PurchaseOrder.id < cur_id),
                )
            )
        stmt = (
            base.order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.id.desc())
            .limit(limit + 1)
            .options(selectinload(PurchaseOrder.lines))
        )
        rows = list((await self.session.execute(stmt)).scalars().unique())
        next_cursor: str | None = None
        if len(rows) > limit:
            rows = rows[:limit]
            tail = rows[-1]
            next_cursor = encode_po_cursor(tail.created_at, tail.id)
        return rows, next_cursor


# --------------------------------------------------------------------- #
# Lines.
# --------------------------------------------------------------------- #
class PurchaseOrderLineRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **kwargs) -> PurchaseOrderLine:
        row = PurchaseOrderLine(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def list_for_po(self, po_id: uuid.UUID) -> list[PurchaseOrderLine]:
        stmt = (
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.purchase_order_id == po_id)
            .order_by(PurchaseOrderLine.line_number.asc())
        )
        return list((await self.session.execute(stmt)).scalars().all())


# --------------------------------------------------------------------- #
# Transitions (append-only).
# --------------------------------------------------------------------- #
class PurchaseOrderTransitionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, **kwargs) -> PurchaseOrderTransition:
        row = PurchaseOrderTransition(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def last_for_po(self, po_id: uuid.UUID) -> PurchaseOrderTransition | None:
        stmt = (
            select(PurchaseOrderTransition)
            .where(PurchaseOrderTransition.purchase_order_id == po_id)
            .order_by(
                PurchaseOrderTransition.occurred_at.desc(),
                PurchaseOrderTransition.id.desc(),
            )
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def count_for_po(self, po_id: uuid.UUID) -> int:
        stmt = (
            select(func.count())
            .select_from(PurchaseOrderTransition)
            .where(PurchaseOrderTransition.purchase_order_id == po_id)
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def page_for_po(
        self, po_id: uuid.UUID, *, cursor: str | None = None, limit: int | None = None
    ) -> tuple[list[PurchaseOrderTransition], str | None]:
        """Chronological (occurred_at ASC, id ASC) history page."""
        limit = _clamp_limit(limit)
        stmt = select(PurchaseOrderTransition).where(
            PurchaseOrderTransition.purchase_order_id == po_id
        )
        if cursor:
            cur_ts, cur_id = _decode_ts_id_cursor(cursor)
            stmt = stmt.where(
                or_(
                    PurchaseOrderTransition.occurred_at > cur_ts,
                    and_(
                        PurchaseOrderTransition.occurred_at == cur_ts,
                        PurchaseOrderTransition.id > cur_id,
                    ),
                )
            )
        stmt = stmt.order_by(
            PurchaseOrderTransition.occurred_at.asc(), PurchaseOrderTransition.id.asc()
        ).limit(limit + 1)
        rows = list((await self.session.execute(stmt)).scalars().all())
        next_cursor: str | None = None
        if len(rows) > limit:
            rows = rows[:limit]
            tail = rows[-1]
            next_cursor = _encode_ts_id_cursor(tail.occurred_at, tail.id)
        return rows, next_cursor


async def count_non_terminal_purchase_orders_for_partner(
    session: AsyncSession, partner_id: uuid.UUID
) -> int:
    """Standalone helper used by the Business Partner capability guard."""
    return await PurchaseOrderRepository(session).count_non_terminal_for_partner(partner_id)


__all__ = [
    "DEFAULT_PAGE_LIMIT",
    "MAX_PAGE_LIMIT",
    "PurchaseOrderLineRepository",
    "PurchaseOrderRepository",
    "PurchaseOrderSequenceRepository",
    "PurchaseOrderTransitionRepository",
    "count_non_terminal_purchase_orders_for_partner",
    "decode_po_cursor",
    "encode_po_cursor",
]
