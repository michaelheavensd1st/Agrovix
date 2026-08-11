"""Data access and concurrency primitives for Purchase Receipts."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import ClassVar

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.purchase_order import PurchaseOrderLine
from app.models.purchase_receipt import PurchaseReceipt, PurchaseReceiptSequence


class PurchaseReceiptSequenceRepository:
    _before_allocate_lock_signal: ClassVar[object | None] = None
    _after_allocate_lock_signal: ClassVar[object | None] = None
    _hold_after_allocate_lock_gate: ClassVar[object | None] = None

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def allocate(self, organization_id: uuid.UUID, year: int) -> str:
        if year < 2000 or year > 9999:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {
                    "code": "invalid_received_at",
                    "message": "received_at year must be between 2000 and 9999.",
                    "context": {"year": year},
                },
            )
        now = datetime.now(UTC)
        if self.session.get_bind().dialect.name == "postgresql":
            before_signal = type(self)._before_allocate_lock_signal
            if before_signal is not None:
                before_signal.set()
            statement = (
                pg_insert(PurchaseReceiptSequence)
                .values(organization_id=organization_id, year=year, last_value=1, updated_at=now)
                .on_conflict_do_update(
                    index_elements=["organization_id", "year"],
                    set_={
                        "last_value": PurchaseReceiptSequence.last_value + 1,
                        "updated_at": now,
                    },
                )
                .returning(PurchaseReceiptSequence.last_value)
            )
            value = int((await self.session.execute(statement)).scalar_one())
            after_signal = type(self)._after_allocate_lock_signal
            if after_signal is not None:
                after_signal.set()
            hold = type(self)._hold_after_allocate_lock_gate
            if hold is not None:
                await hold.wait()
        else:
            row = (
                await self.session.execute(
                    select(PurchaseReceiptSequence)
                    .where(
                        PurchaseReceiptSequence.organization_id == organization_id,
                        PurchaseReceiptSequence.year == year,
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if row is None:
                row = PurchaseReceiptSequence(
                    organization_id=organization_id, year=year, last_value=1, updated_at=now
                )
                self.session.add(row)
            else:
                row.last_value += 1
                row.updated_at = now
            await self.session.flush()
            value = int(row.last_value)
        return f"GRN-{year}-{value:06d}"


class PurchaseReceiptRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_org_and_key(
        self, organization_id: uuid.UUID, idempotency_key: str
    ) -> PurchaseReceipt | None:
        statement = (
            select(PurchaseReceipt)
            .where(
                PurchaseReceipt.organization_id == organization_id,
                PurchaseReceipt.idempotency_key == idempotency_key,
            )
            .options(selectinload(PurchaseReceipt.lines))
        )
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def get_by_id(self, receipt_id: uuid.UUID) -> PurchaseReceipt | None:
        statement = (
            select(PurchaseReceipt)
            .where(PurchaseReceipt.id == receipt_id)
            .options(selectinload(PurchaseReceipt.lines))
        )
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def lock_po_lines(self, ids: Iterable[uuid.UUID]) -> list[PurchaseOrderLine]:
        ordered = sorted(set(ids), key=str)
        if not ordered:
            return []
        statement = (
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.id.in_(ordered))
            .order_by(PurchaseOrderLine.id.asc())
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list((await self.session.execute(statement)).scalars().all())


__all__ = ["PurchaseReceiptRepository", "PurchaseReceiptSequenceRepository"]
