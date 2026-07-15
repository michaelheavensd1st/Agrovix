"""Repositories for Sprint 4 inventory."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import (
    InventoryItem,
    InventoryLot,
    InventoryTransaction,
    InventoryTransactionType,
    StorageLocation,
    Warehouse,
)


# --------------------------------------------------------------------- #
# Sign map — INCREASE types add to the balance, DECREASE types subtract.
# REVERSAL is handled specially in the service (flip the referenced row).
# --------------------------------------------------------------------- #
_INCREASE = {
    InventoryTransactionType.RECEIPT,
    InventoryTransactionType.TRANSFER_IN,
    InventoryTransactionType.ADJUSTMENT_INCREASE,
}
_DECREASE = {
    InventoryTransactionType.ISSUE,
    InventoryTransactionType.CONSUMPTION,
    InventoryTransactionType.TRANSFER_OUT,
    InventoryTransactionType.ADJUSTMENT_DECREASE,
}


class WarehouseRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, wh_id: uuid.UUID) -> Warehouse | None:
        stmt = select(Warehouse).where(Warehouse.id == wh_id, Warehouse.deleted_at.is_(None))
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def list_for_org(self, org_id: uuid.UUID) -> Sequence[Warehouse]:
        stmt = (
            select(Warehouse)
            .where(Warehouse.organization_id == org_id, Warehouse.deleted_at.is_(None))
            .order_by(Warehouse.name)
        )
        return list((await self.session.execute(stmt)).scalars().all())


class StorageLocationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, sl_id: uuid.UUID) -> StorageLocation | None:
        stmt = select(StorageLocation).where(
            StorageLocation.id == sl_id, StorageLocation.deleted_at.is_(None)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def list_for_warehouse(self, wh_id: uuid.UUID) -> Sequence[StorageLocation]:
        stmt = (
            select(StorageLocation)
            .where(StorageLocation.warehouse_id == wh_id, StorageLocation.deleted_at.is_(None))
            .order_by(StorageLocation.name)
        )
        return list((await self.session.execute(stmt)).scalars().all())


class InventoryItemRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, item_id: uuid.UUID) -> InventoryItem | None:
        stmt = select(InventoryItem).where(
            InventoryItem.id == item_id, InventoryItem.deleted_at.is_(None)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def list_for_org(self, org_id: uuid.UUID) -> Sequence[InventoryItem]:
        stmt = (
            select(InventoryItem)
            .where(
                InventoryItem.organization_id == org_id,
                InventoryItem.deleted_at.is_(None),
            )
            .order_by(InventoryItem.name)
        )
        return list((await self.session.execute(stmt)).scalars().all())


class InventoryLotRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, lot_id: uuid.UUID) -> InventoryLot | None:
        stmt = select(InventoryLot).where(
            InventoryLot.id == lot_id, InventoryLot.deleted_at.is_(None)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_by_id_for_update(self, lot_id: uuid.UUID) -> InventoryLot | None:
        """Row-lock the lot inside the current transaction.

        Every stock-affecting operation MUST call this before reading
        the balance. Postgres emits ``SELECT ... FOR UPDATE``; SQLite
        silently no-ops (StaticPool serialises writers).
        """
        stmt = (
            select(InventoryLot)
            .where(InventoryLot.id == lot_id, InventoryLot.deleted_at.is_(None))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def find_or_none(
        self, *, warehouse_id: uuid.UUID, item_id: uuid.UUID, lot_code: str
    ) -> InventoryLot | None:
        stmt = select(InventoryLot).where(
            InventoryLot.warehouse_id == warehouse_id,
            InventoryLot.item_id == item_id,
            InventoryLot.lot_code == lot_code,
            InventoryLot.deleted_at.is_(None),
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def list_for_warehouse(self, wh_id: uuid.UUID) -> Sequence[InventoryLot]:
        stmt = (
            select(InventoryLot)
            .where(
                InventoryLot.warehouse_id == wh_id,
                InventoryLot.deleted_at.is_(None),
            )
            .order_by(InventoryLot.created_at.desc())
        )
        return list((await self.session.execute(stmt)).scalars().all())


class InventoryTransactionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, tx_id: uuid.UUID) -> InventoryTransaction | None:
        stmt = select(InventoryTransaction).where(InventoryTransaction.id == tx_id)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_by_lot_and_key(
        self, lot_id: uuid.UUID, idempotency_key: str
    ) -> InventoryTransaction | None:
        stmt = select(InventoryTransaction).where(
            InventoryTransaction.lot_id == lot_id,
            InventoryTransaction.idempotency_key == idempotency_key,
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_balance_in_canonical(self, lot_id: uuid.UUID) -> Decimal:
        """Return the current balance of ``lot_id`` in its item's
        canonical unit.

        This is the *authoritative* balance projection: every ledger
        row is normalised into the item's canonical unit at write
        time (see :class:`InventoryService`), so the balance is just
        a signed sum. Callers must hold the FOR UPDATE lock on the
        lot before invoking this for a decision.
        """
        stmt = select(
            func.coalesce(
                func.sum(
                    # Note: the DB stores unsigned quantities; sign is
                    # derived from the transaction type on read.
                    _signed_sql_expression()
                ),
                0,
            )
        ).where(InventoryTransaction.lot_id == lot_id)
        result = (await self.session.execute(stmt)).scalar_one()
        return Decimal(str(result))

    async def list_for_lot(
        self,
        lot_id: uuid.UUID,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[Sequence[InventoryTransaction], str | None]:
        stmt = (
            select(InventoryTransaction)
            .where(InventoryTransaction.lot_id == lot_id)
            .order_by(
                InventoryTransaction.performed_at.desc(),
                InventoryTransaction.id.desc(),
            )
            .limit(limit + 1)
        )
        rows = list((await self.session.execute(stmt)).scalars().all())
        next_cursor = str(rows[limit].id) if len(rows) > limit else None
        return rows[:limit], next_cursor

    async def list_by_reference(
        self, reference_type: str, reference_id: uuid.UUID
    ) -> Sequence[InventoryTransaction]:
        stmt = select(InventoryTransaction).where(
            InventoryTransaction.reference_type == reference_type,
            InventoryTransaction.reference_id == reference_id,
        )
        return list((await self.session.execute(stmt)).scalars().all())


# --------------------------------------------------------------------- #
# SQL-side signed-sum expression
# --------------------------------------------------------------------- #
def _signed_sql_expression():
    """Return a SQLAlchemy CASE expression: +qty for increases, -qty for
    decreases, 0 for REVERSAL rows (their effect is delivered by the
    paired inverse row inserted at reversal time — we do NOT flip on
    read to keep the projection simple).
    """
    from sqlalchemy import case

    return case(
        (
            InventoryTransaction.transaction_type.in_([t.value for t in _INCREASE]),
            InventoryTransaction.quantity,
        ),
        (
            InventoryTransaction.transaction_type.in_([t.value for t in _DECREASE]),
            -InventoryTransaction.quantity,
        ),
        else_=0,
    )


__all__ = [
    "InventoryItemRepository",
    "InventoryLotRepository",
    "InventoryTransactionRepository",
    "StorageLocationRepository",
    "WarehouseRepository",
]
