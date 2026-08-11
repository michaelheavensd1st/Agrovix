"""Data access and concurrency primitives for Purchase Receipts."""

from __future__ import annotations

import base64
import binascii
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import ClassVar

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, false, or_, select, true
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.membership import OrganizationMembership
from app.models.purchase_order import PurchaseOrder, PurchaseOrderLine
from app.models.purchase_receipt import PurchaseReceipt, PurchaseReceiptSequence
from app.security.authorize import PermissionScope

DEFAULT_PAGE_LIMIT = 50
MAX_PAGE_LIMIT = 200


def encode_receipt_cursor(created_at: datetime, receipt_id: uuid.UUID) -> str:
    raw = f"{created_at.astimezone(UTC).isoformat()}|{receipt_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode("ascii")


def decode_receipt_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        encoded = cursor.encode("ascii")
        decoded = base64.b64decode(encoded, altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(decoded) != encoded:
            raise ValueError
        raw = decoded.decode("utf-8")
        timestamp, receipt_id = raw.split("|", 1)
        parsed_timestamp = datetime.fromisoformat(timestamp)
        parsed_receipt_id = uuid.UUID(receipt_id)
        if parsed_timestamp.tzinfo is None or parsed_timestamp.utcoffset() is None:
            raise ValueError
        canonical_timestamp = parsed_timestamp.astimezone(UTC).isoformat()
        if timestamp != canonical_timestamp or receipt_id != str(parsed_receipt_id):
            raise ValueError
        return parsed_timestamp, parsed_receipt_id
    except (UnicodeError, ValueError, TypeError, LookupError, binascii.Error) as exc:
        raise _invalid_cursor() from exc


def _invalid_cursor() -> HTTPException:
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"code": "invalid_cursor", "message": "Malformed pagination cursor.", "context": {}},
    )


def _visibility_predicate(model, user_id: uuid.UUID, scopes: list[PermissionScope]):
    if any(scope.organization_id is None and scope.farm_id is None for scope in scopes):
        return true()
    predicates = []
    for scope in scopes:
        if scope.organization_id is not None and scope.farm_id is None:
            predicates.append(model.organization_id == scope.organization_id)
        elif scope.organization_id is not None and scope.farm_id is not None:
            predicates.append(
                and_(
                    model.organization_id == scope.organization_id,
                    model.farm_id == scope.farm_id,
                )
            )
    if not scopes:
        predicates.append(
            exists(
                select(OrganizationMembership.id).where(
                    OrganizationMembership.user_id == user_id,
                    OrganizationMembership.organization_id == model.organization_id,
                    OrganizationMembership.is_active.is_(True),
                    OrganizationMembership.deleted_at.is_(None),
                )
            )
        )
    return or_(*predicates) if predicates else false()


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

    async def get_visible_purchase_order(
        self,
        purchase_order_id: uuid.UUID,
        user_id: uuid.UUID,
        scopes: list[PermissionScope],
    ) -> PurchaseOrder | None:
        statement = select(PurchaseOrder).where(
            PurchaseOrder.id == purchase_order_id,
            _visibility_predicate(PurchaseOrder, user_id, scopes),
        )
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def get_visible_by_id(
        self,
        receipt_id: uuid.UUID,
        user_id: uuid.UUID,
        scopes: list[PermissionScope],
    ) -> PurchaseReceipt | None:
        statement = (
            select(PurchaseReceipt)
            .where(
                PurchaseReceipt.id == receipt_id,
                _visibility_predicate(PurchaseReceipt, user_id, scopes),
            )
            .options(selectinload(PurchaseReceipt.lines))
        )
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def list_by_purchase_order(
        self,
        purchase_order_id: uuid.UUID,
        organization_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> tuple[list[PurchaseReceipt], str | None]:
        limit = max(1, min(int(limit), MAX_PAGE_LIMIT))
        statement = select(PurchaseReceipt).where(
            PurchaseReceipt.purchase_order_id == purchase_order_id,
            PurchaseReceipt.organization_id == organization_id,
        )
        if cursor:
            created_at, receipt_id = decode_receipt_cursor(cursor)
            statement = statement.where(
                or_(
                    PurchaseReceipt.created_at < created_at,
                    and_(
                        PurchaseReceipt.created_at == created_at,
                        PurchaseReceipt.id < receipt_id,
                    ),
                )
            )
        statement = (
            statement.order_by(PurchaseReceipt.created_at.desc(), PurchaseReceipt.id.desc())
            .limit(limit + 1)
            .options(selectinload(PurchaseReceipt.lines))
        )
        rows = list((await self.session.execute(statement)).scalars().unique())
        next_cursor = None
        if len(rows) > limit:
            rows = rows[:limit]
            tail = rows[-1]
            next_cursor = encode_receipt_cursor(tail.created_at, tail.id)
        return rows, next_cursor

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


__all__ = [
    "PurchaseReceiptRepository",
    "PurchaseReceiptSequenceRepository",
    "decode_receipt_cursor",
    "encode_receipt_cursor",
]
