"""Sprint 4 inventory service — the source of truth for stock writes.

Contract (see PRD "Sprint 4"):

* Every stock-affecting operation acquires
  ``SELECT ... FOR UPDATE`` on the lot row for the duration of the
  balance read + ledger insert. Concurrent writers on the same lot
  serialise cleanly under Postgres; SQLite already serialises
  writers so the domain guards still hold.
* Quantities entering the service may be in *any* compatible unit;
  they are converted to the item's ``canonical_unit`` before storage.
  Incompatible units (mass ↔ volume, cross-count) are rejected 409.
* Negative balances are refused 409 ``insufficient_stock``.
* Idempotency: replaying the same ``(lot_id, Idempotency-Key)`` with
  the same payload returns the original row (200 semantics). A
  different payload returns 409 ``idempotency_key_payload_conflict``.
* Posted transactions are IMMUTABLE. Corrections happen via
  :meth:`InventoryService.reversal` or
  :meth:`InventoryService.adjustment`.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.inventory.units import UnitIncompatibleError, convert, is_compatible
from app.models.farm import Farm
from app.models.inventory import (
    InventoryItem,
    InventoryLot,
    InventoryTransaction,
    InventoryTransactionType,
    StockUnit,
    Warehouse,
    WarehouseStatus,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.inventory import (
    InventoryItemRepository,
    InventoryLotRepository,
    InventoryTransactionRepository,
    StorageLocationRepository,
    WarehouseRepository,
)

_INCREASE_TYPES = {
    InventoryTransactionType.RECEIPT,
    InventoryTransactionType.TRANSFER_IN,
    InventoryTransactionType.ADJUSTMENT_INCREASE,
}
_DECREASE_TYPES = {
    InventoryTransactionType.ISSUE,
    InventoryTransactionType.CONSUMPTION,
    InventoryTransactionType.TRANSFER_OUT,
    InventoryTransactionType.ADJUSTMENT_DECREASE,
}


def _payload_hash(payload: dict) -> str:
    """Stable content hash for idempotency-conflict detection."""
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def signed_delta(tx: InventoryTransaction) -> Decimal:
    """Return the signed effect of a ledger row on lot balance."""
    if tx.transaction_type in _INCREASE_TYPES:
        return Decimal(str(tx.quantity))
    if tx.transaction_type in _DECREASE_TYPES:
        return -Decimal(str(tx.quantity))
    return Decimal(0)


class InventoryService:
    """Sprint 4 inventory write service.

    Requires an AsyncSession that is the same one used by the calling
    request — every method assumes the caller's transaction spans the
    lock + insert. Do NOT instantiate one per operation.
    """

    def __init__(
        self,
        session: AsyncSession,
        *,
        warehouse_repo: WarehouseRepository,
        item_repo: InventoryItemRepository,
        lot_repo: InventoryLotRepository,
        tx_repo: InventoryTransactionRepository,
        location_repo: StorageLocationRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.session = session
        self.warehouse_repo = warehouse_repo
        self.item_repo = item_repo
        self.lot_repo = lot_repo
        self.tx_repo = tx_repo
        self.location_repo = location_repo
        self.audit_repo = audit_repo

    # ---------------------------------------------------------------- #
    # Warehouse / item creation helpers
    # ---------------------------------------------------------------- #
    async def create_warehouse(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        data: dict,
        request_ctx: dict,
    ) -> Warehouse:
        wh = Warehouse(organization_id=organization_id, **data)
        self.session.add(wh)
        await self.session.flush()
        await self.audit_repo.record(
            actor_id=actor.id,
            action="inventory_warehouse.create",
            entity_type="warehouse",
            entity_id=str(wh.id),
            organization_id=organization_id,
            farm_id=wh.farm_id,
            metadata={"code": wh.code, "name": wh.name},
            **request_ctx,
        )
        return wh

    async def create_item(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        data: dict,
        request_ctx: dict,
    ) -> InventoryItem:
        item = InventoryItem(organization_id=organization_id, **data)
        self.session.add(item)
        await self.session.flush()
        await self.audit_repo.record(
            actor_id=actor.id,
            action="inventory_item.create",
            entity_type="inventory_item",
            entity_id=str(item.id),
            organization_id=organization_id,
            farm_id=None,
            metadata={"code": item.code, "category": item.category.value},
            **request_ctx,
        )
        return item

    # ---------------------------------------------------------------- #
    # Ledger primitives
    # ---------------------------------------------------------------- #
    async def _lock_lot(self, lot_id: uuid.UUID) -> InventoryLot:
        lot = await self.lot_repo.get_by_id_for_update(lot_id)
        if lot is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Inventory lot not found.")
        return lot

    async def _check_idempotency(
        self,
        *,
        lot_id: uuid.UUID,
        key: str | None,
        payload_hash: str,
    ) -> InventoryTransaction | None:
        """Return existing tx to replay, or None to proceed with insert.

        Raises 409 on same-key-different-payload conflict.
        """
        if key is None:
            return None
        existing = await self.tx_repo.get_by_lot_and_key(lot_id, key)
        if existing is None:
            return None
        if existing.payload_hash != payload_hash:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "idempotency_key_payload_conflict",
                    "message": (
                        "This Idempotency-Key was previously used with a different "
                        "payload on this lot."
                    ),
                    "idempotency_key": key,
                },
            )
        return existing

    def _to_canonical(self, *, item: InventoryItem, qty: Decimal, unit: StockUnit) -> Decimal:
        if not is_compatible(unit, item.canonical_unit):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "unit_incompatible",
                    "message": (
                        f"Cannot convert {unit.value!r} to item's canonical unit "
                        f"{item.canonical_unit.value!r}."
                    ),
                    "source_unit": unit.value,
                    "target_unit": item.canonical_unit.value,
                },
            )
        try:
            return convert(qty, unit, item.canonical_unit)
        except UnitIncompatibleError as exc:  # pragma: no cover — guarded above
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    def _assert_warehouse_open(self, warehouse: Warehouse) -> None:
        if warehouse.status == WarehouseStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "warehouse_closed_no_writes",
                    "message": "This warehouse is CLOSED and read-only.",
                },
            )

    async def _current_balance_canonical(self, lot_id: uuid.UUID) -> Decimal:
        return await self.tx_repo.get_balance_in_canonical(lot_id)

    async def _post_ledger(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        farm_id: uuid.UUID | None,
        warehouse: Warehouse,
        item: InventoryItem,
        lot: InventoryLot,
        tx_type: InventoryTransactionType,
        quantity_canonical: Decimal,
        reason: str | None,
        idempotency_key: str | None,
        payload_hash: str,
        reference_type: str | None = None,
        reference_id: uuid.UUID | None = None,
        reverses_transaction_id: uuid.UUID | None = None,
        request_ctx: dict,
        metadata_json: dict | None = None,
    ) -> InventoryTransaction:
        """Insert a ledger row under an already-held lot lock.

        Balance non-negativity is enforced for DECREASE types.
        """
        # Non-negative guard for decreases (inside the lock).
        if tx_type in _DECREASE_TYPES:
            current = await self._current_balance_canonical(lot.id)
            new_balance = current - quantity_canonical
            if new_balance < 0:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "insufficient_stock",
                        "message": (
                            f"Insufficient stock: available {current} "
                            f"{item.canonical_unit.value}, requested "
                            f"{quantity_canonical} {item.canonical_unit.value}."
                        ),
                        "available": str(current),
                        "requested": str(quantity_canonical),
                        "canonical_unit": item.canonical_unit.value,
                    },
                )

        tx = InventoryTransaction(
            organization_id=organization_id,
            farm_id=farm_id,
            warehouse_id=warehouse.id,
            item_id=item.id,
            lot_id=lot.id,
            transaction_type=tx_type,
            quantity=quantity_canonical,
            unit=item.canonical_unit,
            performed_by_id=actor.id,
            performed_at=datetime.now(UTC),
            reason=reason,
            reference_type=reference_type,
            reference_id=reference_id,
            reverses_transaction_id=reverses_transaction_id,
            idempotency_key=idempotency_key,
            payload_hash=payload_hash if idempotency_key is not None else None,
            metadata_json=metadata_json,
        )
        try:
            async with self.session.begin_nested():
                self.session.add(tx)
                await self.session.flush()
        except IntegrityError as exc:
            # Concurrent request won the idempotency race.
            if idempotency_key is None:
                raise
            existing = await self.tx_repo.get_by_lot_and_key(lot.id, idempotency_key)
            if existing is None:
                raise
            if existing.payload_hash != payload_hash:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "idempotency_key_payload_conflict",
                        "message": (
                            "This Idempotency-Key was previously used with a "
                            "different payload on this lot."
                        ),
                    },
                ) from exc
            return existing

        await self.audit_repo.record(
            actor_id=actor.id,
            action=f"inventory_transaction.{tx_type.value}",
            entity_type="inventory_transaction",
            entity_id=str(tx.id),
            organization_id=organization_id,
            farm_id=farm_id,
            metadata={
                "lot_id": str(lot.id),
                "quantity": str(quantity_canonical),
                "unit": item.canonical_unit.value,
                "reference": (f"{reference_type}:{reference_id}" if reference_type else None),
            },
            **request_ctx,
        )
        return tx

    # ---------------------------------------------------------------- #
    # High-level operations
    # ---------------------------------------------------------------- #
    async def receipt(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        payload: dict,
        request_ctx: dict,
        idempotency_key: str | None,
    ) -> tuple[InventoryTransaction, InventoryLot, bool]:
        """Register incoming stock.

        Creates or reuses the lot at ``(warehouse, item, lot_code)``
        and posts a ``RECEIPT`` transaction. Returns
        ``(tx, lot, is_replay)`` — the tx is the ledger row and
        ``is_replay=True`` indicates an idempotent replay.
        """
        self._assert_warehouse_open(warehouse)

        item_id = payload["item_id"]
        item = await self.item_repo.get_by_id(item_id)
        if item is None or item.organization_id != warehouse.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "item_not_found_in_organization",
                    "message": "Inventory item is not part of this organization.",
                },
            )

        # Reuse existing lot if the caller's (item, lot_code) already
        # exists at this warehouse. Otherwise create one.
        lot = await self.lot_repo.find_or_none(
            warehouse_id=warehouse.id, item_id=item.id, lot_code=payload["lot_code"]
        )
        if lot is None:
            lot = InventoryLot(
                item_id=item.id,
                warehouse_id=warehouse.id,
                storage_location_id=payload.get("storage_location_id"),
                lot_code=payload["lot_code"],
                expiry_date=payload.get("expiry_date"),
                received_at=datetime.now(UTC),
                unit_cost_amount=payload.get("unit_cost_amount"),
                unit_cost_currency=payload.get("unit_cost_currency"),
                metadata_json=payload.get("metadata_json"),
            )
            self.session.add(lot)
            await self.session.flush()

        # Lock the lot BEFORE reading balance / writing the ledger row.
        lot = await self._lock_lot(lot.id)

        qty_canonical = self._to_canonical(item=item, qty=payload["quantity"], unit=payload["unit"])
        p_hash = _payload_hash(
            {
                "op": "receipt",
                "lot_id": str(lot.id),
                "quantity_canonical": str(qty_canonical),
                "unit": item.canonical_unit.value,
            }
        )
        replay = await self._check_idempotency(
            lot_id=lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay, lot, True

        tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=InventoryTransactionType.RECEIPT,
            quantity_canonical=qty_canonical,
            reason=payload.get("reason"),
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            request_ctx=request_ctx,
            metadata_json=payload.get("metadata_json"),
        )
        return tx, lot, False

    async def issue(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        payload: dict,
        request_ctx: dict,
        idempotency_key: str | None,
    ) -> tuple[InventoryTransaction, bool]:
        self._assert_warehouse_open(warehouse)
        lot = await self._lock_lot(payload["lot_id"])
        if lot.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "lot_not_in_warehouse",
                    "message": "Lot belongs to a different warehouse.",
                },
            )
        item = await self.item_repo.get_by_id(lot.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
        qty_canonical = self._to_canonical(item=item, qty=payload["quantity"], unit=payload["unit"])
        p_hash = _payload_hash(
            {
                "op": "issue",
                "lot_id": str(lot.id),
                "quantity_canonical": str(qty_canonical),
            }
        )
        replay = await self._check_idempotency(
            lot_id=lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay, True
        tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=InventoryTransactionType.ISSUE,
            quantity_canonical=qty_canonical,
            reason=payload.get("reason"),
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            request_ctx=request_ctx,
            metadata_json=payload.get("metadata_json"),
        )
        return tx, False

    async def transfer(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        payload: dict,
        request_ctx: dict,
        idempotency_key: str | None,
    ) -> tuple[InventoryTransaction, InventoryTransaction, bool]:
        """Paired TRANSFER_OUT + TRANSFER_IN, atomic.

        Deducts from the source lot, produces (or reuses) a destination
        lot with the same ``(item, lot_code)`` at the target warehouse,
        and adds the same canonical quantity there. Both rows share
        ``reference_type='transfer'`` + ``reference_id`` so they can be
        traced together.
        """
        self._assert_warehouse_open(warehouse)
        dst_warehouse = await self.warehouse_repo.get_by_id(payload["destination_warehouse_id"])
        if dst_warehouse is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Destination warehouse not found.")
        if dst_warehouse.organization_id != warehouse.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cross_org_transfer_forbidden",
                    "message": "Cannot transfer across organizations.",
                },
            )
        self._assert_warehouse_open(dst_warehouse)

        src_lot = await self._lock_lot(payload["lot_id"])
        if src_lot.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": "lot_not_in_warehouse", "message": "Source lot mismatch."},
            )
        item = await self.item_repo.get_by_id(src_lot.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
        qty_canonical = self._to_canonical(item=item, qty=payload["quantity"], unit=payload["unit"])

        # Reuse / create the destination lot.
        dst_lot = await self.lot_repo.find_or_none(
            warehouse_id=dst_warehouse.id, item_id=item.id, lot_code=src_lot.lot_code
        )
        if dst_lot is None:
            dst_lot = InventoryLot(
                item_id=item.id,
                warehouse_id=dst_warehouse.id,
                storage_location_id=payload.get("destination_storage_location_id"),
                lot_code=src_lot.lot_code,
                expiry_date=src_lot.expiry_date,
                received_at=datetime.now(UTC),
                unit_cost_amount=src_lot.unit_cost_amount,
                unit_cost_currency=src_lot.unit_cost_currency,
            )
            self.session.add(dst_lot)
            await self.session.flush()
        dst_lot = await self._lock_lot(dst_lot.id)

        # Shared reference id groups the paired ledger rows.
        transfer_ref = uuid.uuid4()
        p_hash = _payload_hash(
            {
                "op": "transfer",
                "src_lot": str(src_lot.id),
                "dst_lot": str(dst_lot.id),
                "quantity_canonical": str(qty_canonical),
            }
        )

        # Idempotency: keyed on the source lot only. Same key + payload
        # → replay both rows via the reference id.
        replay = await self._check_idempotency(
            lot_id=src_lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            paired = [
                t
                for t in await self.tx_repo.list_by_reference("transfer", replay.reference_id)
                if t.transaction_type == InventoryTransactionType.TRANSFER_IN
            ]
            if not paired:  # defensive — should not happen
                raise RuntimeError("Missing TRANSFER_IN partner for replay row.")
            return replay, paired[0], True

        # OUT — decreases source. Non-negative guard runs inside _post_ledger.
        out_tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=src_lot,
            tx_type=InventoryTransactionType.TRANSFER_OUT,
            quantity_canonical=qty_canonical,
            reason=payload.get("reason"),
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            reference_type="transfer",
            reference_id=transfer_ref,
            request_ctx=request_ctx,
            metadata_json=payload.get("metadata_json"),
        )
        # IN — increases destination. No idempotency key on this row so
        # the partial index still enforces uniqueness on OUT.
        in_tx = await self._post_ledger(
            actor=actor,
            organization_id=dst_warehouse.organization_id,
            farm_id=dst_warehouse.farm_id,
            warehouse=dst_warehouse,
            item=item,
            lot=dst_lot,
            tx_type=InventoryTransactionType.TRANSFER_IN,
            quantity_canonical=qty_canonical,
            reason=payload.get("reason"),
            idempotency_key=None,
            payload_hash=p_hash,
            reference_type="transfer",
            reference_id=transfer_ref,
            request_ctx=request_ctx,
            metadata_json=payload.get("metadata_json"),
        )
        return out_tx, in_tx, False

    async def adjustment(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        payload: dict,
        request_ctx: dict,
        idempotency_key: str | None,
    ) -> tuple[InventoryTransaction, bool]:
        self._assert_warehouse_open(warehouse)
        lot = await self._lock_lot(payload["lot_id"])
        if lot.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": "lot_not_in_warehouse", "message": "Lot mismatch."},
            )
        item = await self.item_repo.get_by_id(lot.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
        qty_canonical = self._to_canonical(item=item, qty=payload["quantity"], unit=payload["unit"])
        direction = payload["direction"]
        tx_type = (
            InventoryTransactionType.ADJUSTMENT_INCREASE
            if direction == "increase"
            else InventoryTransactionType.ADJUSTMENT_DECREASE
        )
        p_hash = _payload_hash(
            {
                "op": "adjustment",
                "lot_id": str(lot.id),
                "quantity_canonical": str(qty_canonical),
                "direction": direction,
                "reason": payload["reason"],
            }
        )
        replay = await self._check_idempotency(
            lot_id=lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay, True
        tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=tx_type,
            quantity_canonical=qty_canonical,
            reason=payload["reason"],
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            request_ctx=request_ctx,
            metadata_json=payload.get("metadata_json"),
        )
        return tx, False

    async def reversal(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        payload: dict,
        request_ctx: dict,
        idempotency_key: str | None,
    ) -> tuple[InventoryTransaction, bool]:
        """Reverse a prior ledger row.

        Posts a paired *inverse* transaction (RECEIPT-of-decrease
        becomes ISSUE-of-original-quantity, etc.) plus a REVERSAL
        marker row referencing the original. Balance projections
        already ignore REVERSAL rows (they carry the audit trail;
        the inverse row carries the balance effect), so double-clicks
        cannot produce a phantom flip.
        """
        self._assert_warehouse_open(warehouse)
        original = await self.tx_repo.get_by_id(payload["reverses_transaction_id"])
        if original is None or original.warehouse_id != warehouse.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Original transaction not found.")
        if original.transaction_type == InventoryTransactionType.REVERSAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cannot_reverse_a_reversal",
                    "message": "A REVERSAL row cannot itself be reversed.",
                },
            )
        # Refuse if the original has already been reversed.
        already = await self.tx_repo.list_by_reference("inventory_transaction", original.id)
        if any(t.transaction_type == InventoryTransactionType.REVERSAL for t in already):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "already_reversed",
                    "message": "This transaction has already been reversed.",
                },
            )

        lot = await self._lock_lot(original.lot_id)
        item = await self.item_repo.get_by_id(lot.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")

        # Inverse type map.
        _inverse: dict[InventoryTransactionType, InventoryTransactionType] = {
            InventoryTransactionType.RECEIPT: InventoryTransactionType.ADJUSTMENT_DECREASE,
            InventoryTransactionType.ISSUE: InventoryTransactionType.ADJUSTMENT_INCREASE,
            InventoryTransactionType.CONSUMPTION: InventoryTransactionType.ADJUSTMENT_INCREASE,
            InventoryTransactionType.TRANSFER_OUT: InventoryTransactionType.ADJUSTMENT_INCREASE,
            InventoryTransactionType.TRANSFER_IN: InventoryTransactionType.ADJUSTMENT_DECREASE,
            InventoryTransactionType.ADJUSTMENT_INCREASE: InventoryTransactionType.ADJUSTMENT_DECREASE,
            InventoryTransactionType.ADJUSTMENT_DECREASE: InventoryTransactionType.ADJUSTMENT_INCREASE,
        }
        inverse_type = _inverse[original.transaction_type]
        p_hash = _payload_hash(
            {
                "op": "reversal",
                "reverses": str(original.id),
                "reason": payload["reason"],
            }
        )
        replay = await self._check_idempotency(
            lot_id=lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay, True

        # 1) Inverse row (carries the balance effect).
        inverse_tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=inverse_type,
            quantity_canonical=Decimal(str(original.quantity)),
            reason=f"Reversal of {original.id}: {payload['reason']}",
            idempotency_key=None,
            payload_hash=p_hash,
            reference_type="reversal_inverse_of",
            reference_id=original.id,
            request_ctx=request_ctx,
        )
        # 2) REVERSAL marker (audit only — zero balance effect).
        marker = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=InventoryTransactionType.REVERSAL,
            quantity_canonical=Decimal(str(original.quantity)),
            reason=payload["reason"],
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            reference_type="inventory_transaction",
            reference_id=original.id,
            reverses_transaction_id=original.id,
            request_ctx=request_ctx,
        )
        del inverse_tx
        return marker, False

    # ---------------------------------------------------------------- #
    # APE integration (FEEDING → CONSUMPTION)
    # ---------------------------------------------------------------- #
    async def consume_for_event(
        self,
        *,
        actor: User,
        farm: Farm,
        lot_id: uuid.UUID,
        quantity: Decimal,
        unit: StockUnit,
        event_id: uuid.UUID,
        idempotency_key: str | None,
        request_ctx: dict,
    ) -> InventoryTransaction:
        """Record a CONSUMPTION tied to a production event.

        Called from :class:`ProductionEventService.create` in the SAME
        DB transaction as the event insert. If either side raises,
        both writes roll back — that's the "atomic FEEDING" guarantee.

        The idempotency key mirrors the caller's event idempotency
        key so retries never double-deduct.
        """
        lot = await self._lock_lot(lot_id)
        item = await self.item_repo.get_by_id(lot.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")

        # Cross-tenant check — the lot must belong to the same org as
        # the farm. Farm-pinned lots must match the farm.
        warehouse = await self.warehouse_repo.get_by_id(lot.warehouse_id)
        if warehouse is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
        if warehouse.organization_id != farm.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cross_org_lot_reference",
                    "message": "Cannot consume from another organization's lot.",
                },
            )
        if warehouse.farm_id is not None and warehouse.farm_id != farm.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cross_farm_lot_reference",
                    "message": "This lot is pinned to a different farm.",
                },
            )
        self._assert_warehouse_open(warehouse)

        qty_canonical = self._to_canonical(item=item, qty=quantity, unit=unit)
        p_hash = _payload_hash(
            {
                "op": "consumption",
                "lot_id": str(lot.id),
                "event_id": str(event_id),
                "quantity_canonical": str(qty_canonical),
            }
        )
        replay = await self._check_idempotency(
            lot_id=lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay
        tx = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=farm.id,
            warehouse=warehouse,
            item=item,
            lot=lot,
            tx_type=InventoryTransactionType.CONSUMPTION,
            quantity_canonical=qty_canonical,
            reason="production_event.FEEDING",
            idempotency_key=idempotency_key,
            payload_hash=p_hash,
            reference_type="production_event",
            reference_id=event_id,
            request_ctx=request_ctx,
        )
        return tx
