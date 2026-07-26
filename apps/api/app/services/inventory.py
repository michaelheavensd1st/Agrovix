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
from contextlib import suppress
from datetime import UTC, datetime
from decimal import Decimal
from typing import ClassVar

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError, InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession

from app.inventory.units import UnitIncompatibleError, convert, is_compatible
from app.models.farm import Farm
from app.models.inventory import (
    InventoryItem,
    InventoryItemCategory,
    InventoryLot,
    InventoryTransaction,
    InventoryTransactionType,
    StockUnit,
    StorageLocation,
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

    async def update_warehouse(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        data: dict,
        request_ctx: dict,
    ) -> Warehouse:
        """Sprint 4 CRG03 fix — mutations now flow through the service.

        Captures a before/after diff in the audit log and enforces the
        lifecycle contract: CLOSED warehouses cannot be renamed or
        moved (only reopened via ``status=active``); ACTIVE ↔
        MAINTENANCE ↔ CLOSED transitions are always permitted.
        """
        before = {
            "name": warehouse.name,
            "code": warehouse.code,
            "status": warehouse.status.value,
            "farm_id": str(warehouse.farm_id) if warehouse.farm_id else None,
            "site_id": str(warehouse.site_id) if warehouse.site_id else None,
        }
        changed_fields: dict[str, tuple] = {}
        # Status transitions must be validated before non-status mutations
        # so that reopening a CLOSED warehouse works even when other
        # fields are locked.
        target_status: WarehouseStatus | None = None
        if "status" in data and data["status"] is not None:
            target_status = WarehouseStatus(data["status"])

        # Sprint 4 CRG03 verification — CLOSED warehouses are strictly
        # read-only. The ONLY valid PATCH is a status-only payload that
        # transitions the warehouse OUT of CLOSED. Reopening and
        # ordinary mutation must be two separate requests — that keeps
        # the audit trail unambiguous (one row for "reopened", one row
        # for "renamed") and makes the closed-guarantee auditable.
        if warehouse.status == WarehouseStatus.CLOSED:
            payload_keys = {k for k, v in data.items() if v is not None}
            status_only_reopen = (
                payload_keys == {"status"}
                and target_status is not None
                and target_status != WarehouseStatus.CLOSED
            )
            if not status_only_reopen:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "warehouse_closed_no_writes",
                        "message": (
                            "A CLOSED warehouse can only be updated by a "
                            "status-only PATCH that transitions it back "
                            "to 'active' or 'maintenance'. Reopen the "
                            "warehouse first, then submit a separate "
                            "PATCH for any other field changes."
                        ),
                        "warehouse_id": str(warehouse.id),
                        "submitted_fields": sorted(payload_keys),
                    },
                )
        for k, v in data.items():
            if hasattr(warehouse, k):
                old = getattr(warehouse, k)
                if k == "status" and v is not None:
                    v = WarehouseStatus(v)
                if old != v:
                    changed_fields[k] = (
                        old.value if hasattr(old, "value") else old,
                        v.value if hasattr(v, "value") else v,
                    )
                    setattr(warehouse, k, v)
        await self.session.flush()
        await self.session.refresh(warehouse)
        after = {
            "name": warehouse.name,
            "code": warehouse.code,
            "status": warehouse.status.value,
            "farm_id": str(warehouse.farm_id) if warehouse.farm_id else None,
            "site_id": str(warehouse.site_id) if warehouse.site_id else None,
        }
        await self.audit_repo.record(
            actor_id=actor.id,
            action="inventory_warehouse.update",
            entity_type="warehouse",
            entity_id=str(warehouse.id),
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            metadata={
                "before": before,
                "after": after,
                "changed": {k: {"from": v[0], "to": v[1]} for k, v in changed_fields.items()},
            },
            **request_ctx,
        )
        return warehouse

    async def update_item(
        self,
        *,
        actor: User,
        item: InventoryItem,
        data: dict,
        request_ctx: dict,
    ) -> InventoryItem:
        """Sprint 4 CRG03 fix — item edits are audit-logged.

        Rejects any change to ``canonical_unit`` (immutable after
        creation) so historical ledger rows stay comparable.
        """
        if "canonical_unit" in data and data["canonical_unit"] not in (None, item.canonical_unit):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "canonical_unit_immutable",
                    "message": (
                        "Canonical unit cannot be changed after item "
                        "creation. Create a new item if a different "
                        "unit is required."
                    ),
                },
            )
        before = {
            "name": item.name,
            "code": item.code,
            "category": item.category.value,
            "canonical_unit": item.canonical_unit.value,
        }
        changed_fields: dict[str, tuple] = {}
        for k, v in data.items():
            if k == "canonical_unit":
                continue
            if hasattr(item, k):
                old = getattr(item, k)
                if old != v:
                    changed_fields[k] = (
                        old.value if hasattr(old, "value") else old,
                        v.value if hasattr(v, "value") else v,
                    )
                    setattr(item, k, v)
        await self.session.flush()
        await self.session.refresh(item)
        after = {
            "name": item.name,
            "code": item.code,
            "category": item.category.value,
            "canonical_unit": item.canonical_unit.value,
        }
        await self.audit_repo.record(
            actor_id=actor.id,
            action="inventory_item.update",
            entity_type="inventory_item",
            entity_id=str(item.id),
            organization_id=item.organization_id,
            farm_id=None,
            metadata={
                "before": before,
                "after": after,
                "changed": {k: {"from": v[0], "to": v[1]} for k, v in changed_fields.items()},
            },
            **request_ctx,
        )
        return item

    async def create_storage_location(
        self,
        *,
        actor: User,
        warehouse: Warehouse,
        data: dict,
        request_ctx: dict,
    ) -> StorageLocation:
        """Sprint 4 CRG03 fix — storage-location creation flows through service.

        CLOSED warehouses cannot receive new storage locations;
        MAINTENANCE warehouses can (physical bins are a static
        concern, unrelated to stock movements).
        """
        if warehouse.status == WarehouseStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "warehouse_closed_no_writes",
                    "message": "Cannot add storage locations to a CLOSED warehouse.",
                },
            )
        loc = StorageLocation(warehouse_id=warehouse.id, **data)
        self.session.add(loc)
        await self.session.flush()
        await self.audit_repo.record(
            actor_id=actor.id,
            action="inventory_storage_location.create",
            entity_type="inventory_storage_location",
            entity_id=str(loc.id),
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            metadata={"warehouse_id": str(warehouse.id), "code": loc.code, "name": loc.name},
            **request_ctx,
        )
        return loc

    # ---------------------------------------------------------------- #
    # Ledger primitives
    # ---------------------------------------------------------------- #
    async def _lock_lot(self, lot_id: uuid.UUID) -> InventoryLot:
        lot = await self.lot_repo.get_by_id_for_update(lot_id)
        if lot is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Inventory lot not found.")
        return lot

    async def _assert_location_belongs_to_warehouse(
        self,
        *,
        storage_location_id: uuid.UUID | None,
        warehouse: Warehouse,
    ) -> None:
        """Sprint 4.1 P2 Task 3 — reject cross-warehouse storage locations.

        A receipt or transfer must not associate a lot with a
        storage-location bin that belongs to a different warehouse.
        The database keeps ``storage_location.warehouse_id`` but does
        not FK-check it against ``inventory_lot.warehouse_id``, so we
        enforce the invariant here — BEFORE any lot is inserted and
        BEFORE the ledger row is written.
        """
        if storage_location_id is None:
            return
        loc = await self.location_repo.get_by_id(storage_location_id)
        if loc is None or loc.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "storage_location_wrong_warehouse",
                    "message": (
                        "Storage location does not belong to the target warehouse. "
                        "Pick a storage location from the same warehouse."
                    ),
                    "storage_location_id": str(storage_location_id),
                    "target_warehouse_id": str(warehouse.id),
                },
            )

    async def _get_or_create_lot_safe(
        self,
        *,
        warehouse: Warehouse,
        item: InventoryItem,
        lot_code: str,
        storage_location_id: uuid.UUID | None,
        expiry_date=None,
        received_at=None,
        unit_cost_amount=None,
        unit_cost_currency=None,
        metadata_json: dict | None = None,
    ) -> InventoryLot:
        """Sprint 4.1 P2 Task 4 — concurrency-safe lot upsert.

        The naive ``find_or_none → insert if missing`` pattern is
        subject to a race: two concurrent receipts on the same
        ``(warehouse, item, lot_code)`` both find nothing, both
        ``session.add`` an ``InventoryLot``, and the loser explodes on
        the ``uq_inventory_lots_warehouse_item_code`` unique
        constraint (a raw ``IntegrityError`` bubbles up as a 500).

        This helper wraps the INSERT in a SAVEPOINT (`session.begin_nested`)
        and, on ``IntegrityError``, rolls back the savepoint and
        re-selects the lot that the winning transaction created. The
        idempotent replay path further up the stack then behaves
        identically for both retry-of-same-request and race-with-a-
        different-client scenarios.
        """
        existing = await self.lot_repo.find_or_none(
            warehouse_id=warehouse.id, item_id=item.id, lot_code=lot_code
        )
        if existing is not None:
            return existing

        lot = InventoryLot(
            item_id=item.id,
            warehouse_id=warehouse.id,
            storage_location_id=storage_location_id,
            lot_code=lot_code,
            expiry_date=expiry_date,
            received_at=received_at or datetime.now(UTC),
            unit_cost_amount=unit_cost_amount,
            unit_cost_currency=unit_cost_currency,
            metadata_json=metadata_json,
        )
        try:
            async with self.session.begin_nested():
                self.session.add(lot)
                await self.session.flush()
            return lot
        except IntegrityError:
            # The other request won the race and inserted the lot
            # first. Re-select and reuse it. This preserves append-only
            # ledger semantics AND idempotent retry behaviour.
            #
            # After the savepoint rolls back the transient ``lot``
            # instance is typically evicted from the session, but in
            # SQLAlchemy 2.x some code paths leave it lingering in the
            # session's pending state. Any subsequent ORM query would
            # trigger autoflush and retry the failing INSERT, so we
            # defensively expunge the object (best-effort) and run the
            # re-select with autoflush disabled.
            with suppress(InvalidRequestError):
                self.session.expunge(lot)
            with self.session.no_autoflush:
                winner = await self.lot_repo.find_or_none(
                    warehouse_id=warehouse.id, item_id=item.id, lot_code=lot_code
                )
            if winner is None:  # pragma: no cover — should not happen
                raise
            return winner

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

    def _assert_warehouse_status_allows(
        self,
        warehouse: Warehouse,
        tx_type: InventoryTransactionType,
    ) -> None:
        """Central lifecycle-policy gate for every ledger mutation.

        Sprint 4 lifecycle contract:

        * ``ACTIVE`` — full read/write.
        * ``MAINTENANCE`` — inbound + audit-only writes allowed:
          ``RECEIPT``, ``TRANSFER_IN``, ``ADJUSTMENT_INCREASE``,
          ``REVERSAL``. Every outbound movement is refused with
          ``warehouse_under_maintenance`` (409) so operational stock
          is frozen while the site is being serviced.
        * ``CLOSED`` — strictly read-only. Every mutation returns 409
          ``warehouse_closed_no_writes``. Reopen via
          ``PATCH /warehouses/{id}`` (status=active) first.

        The gate runs inside :meth:`_post_ledger` too so any code path
        that reaches the ledger — including the FEEDING → CONSUMPTION
        integration and future reversal / adjustment flows — is
        checked in exactly one place.
        """
        if warehouse.status == WarehouseStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "warehouse_closed_no_writes",
                    "message": "This warehouse is CLOSED and read-only.",
                    "warehouse_id": str(warehouse.id),
                    "warehouse_status": warehouse.status.value,
                },
            )
        if warehouse.status == WarehouseStatus.MAINTENANCE:
            allowed_under_maintenance = {
                InventoryTransactionType.RECEIPT,
                InventoryTransactionType.TRANSFER_IN,
                InventoryTransactionType.ADJUSTMENT_INCREASE,
                InventoryTransactionType.REVERSAL,
            }
            if tx_type not in allowed_under_maintenance:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "warehouse_under_maintenance",
                        "message": (
                            "This warehouse is under MAINTENANCE. Only "
                            "inbound movements (receipts, incoming "
                            "transfers, upward adjustments) and "
                            "reversals are allowed. Blocked type: "
                            f"{tx_type.value}."
                        ),
                        "warehouse_id": str(warehouse.id),
                        "warehouse_status": warehouse.status.value,
                        "transaction_type": tx_type.value,
                    },
                )

    def _assert_warehouse_open(self, warehouse: Warehouse) -> None:
        """Back-compat alias used by legacy call sites — CLOSED only.

        Prefer :meth:`_assert_warehouse_status_allows` at every new
        call site so the MAINTENANCE allow-list is honoured.
        """
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
        bypass_maintenance_gate: bool = False,
    ) -> InventoryTransaction:
        """Insert a ledger row under an already-held lot lock.

        Balance non-negativity is enforced for DECREASE types. The
        warehouse lifecycle gate runs FIRST so a CLOSED warehouse
        blocks everything and MAINTENANCE only accepts the allow-list
        documented in :meth:`_assert_warehouse_status_allows`.
        ``bypass_maintenance_gate=True`` is used by
        :meth:`reversal` for the inverse ledger row so that
        corrections stay possible under MAINTENANCE (CLOSED still
        blocks).
        """
        if bypass_maintenance_gate:
            # Reversal-inverse rows: only the CLOSED-strict rule applies.
            if warehouse.status == WarehouseStatus.CLOSED:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "warehouse_closed_no_writes",
                        "message": "This warehouse is CLOSED and read-only.",
                    },
                )
        else:
            self._assert_warehouse_status_allows(warehouse, tx_type)
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
        self._assert_warehouse_status_allows(warehouse, InventoryTransactionType.RECEIPT)

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

        # Sprint 4.1 P2 Task 3 — cross-warehouse storage-location guard.
        await self._assert_location_belongs_to_warehouse(
            storage_location_id=payload.get("storage_location_id"),
            warehouse=warehouse,
        )

        # Sprint 4.1 P2 Task 4 — concurrent-receipt safe upsert.
        lot = await self._get_or_create_lot_safe(
            warehouse=warehouse,
            item=item,
            lot_code=payload["lot_code"],
            storage_location_id=payload.get("storage_location_id"),
            expiry_date=payload.get("expiry_date"),
            unit_cost_amount=payload.get("unit_cost_amount"),
            unit_cost_currency=payload.get("unit_cost_currency"),
            metadata_json=payload.get("metadata_json"),
        )

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
        self._assert_warehouse_status_allows(warehouse, InventoryTransactionType.ISSUE)
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
        # Source must permit TRANSFER_OUT; destination must permit
        # TRANSFER_IN. Both are checked BEFORE we touch any lots so a
        # MAINTENANCE / CLOSED warehouse on either side aborts early.
        self._assert_warehouse_status_allows(warehouse, InventoryTransactionType.TRANSFER_OUT)
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
        self._assert_warehouse_status_allows(dst_warehouse, InventoryTransactionType.TRANSFER_IN)

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

        # Sprint 4.1 P2 Task 3 — cross-warehouse storage-location guard
        # applies to the destination-side bin, if the caller pinned one.
        await self._assert_location_belongs_to_warehouse(
            storage_location_id=payload.get("destination_storage_location_id"),
            warehouse=dst_warehouse,
        )

        # Sprint 4.1 P2 Task 4 — concurrent-transfer safe upsert on the
        # destination lot. Same race exists as on receipt; same fix
        # applies here.
        dst_lot = await self._get_or_create_lot_safe(
            warehouse=dst_warehouse,
            item=item,
            lot_code=src_lot.lot_code,
            storage_location_id=payload.get("destination_storage_location_id"),
            expiry_date=src_lot.expiry_date,
            unit_cost_amount=src_lot.unit_cost_amount,
            unit_cost_currency=src_lot.unit_cost_currency,
        )
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
        direction = payload["direction"]
        tx_type = (
            InventoryTransactionType.ADJUSTMENT_INCREASE
            if direction == "increase"
            else InventoryTransactionType.ADJUSTMENT_DECREASE
        )
        # Direction-aware lifecycle gate — INCREASE is allowed under
        # MAINTENANCE (reconciliation up), DECREASE is not.
        self._assert_warehouse_status_allows(warehouse, tx_type)
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

    # Inverse type map used by :meth:`reversal`. Class-level so the
    # paired-transfer branch can look up its partner's inverse
    # without redeclaring the mapping.
    _REVERSAL_INVERSE: ClassVar[dict[InventoryTransactionType, InventoryTransactionType]] = {
        InventoryTransactionType.RECEIPT: InventoryTransactionType.ADJUSTMENT_DECREASE,
        InventoryTransactionType.ISSUE: InventoryTransactionType.ADJUSTMENT_INCREASE,
        InventoryTransactionType.CONSUMPTION: InventoryTransactionType.ADJUSTMENT_INCREASE,
        InventoryTransactionType.TRANSFER_OUT: InventoryTransactionType.ADJUSTMENT_INCREASE,
        InventoryTransactionType.TRANSFER_IN: InventoryTransactionType.ADJUSTMENT_DECREASE,
        InventoryTransactionType.ADJUSTMENT_INCREASE: InventoryTransactionType.ADJUSTMENT_DECREASE,
        InventoryTransactionType.ADJUSTMENT_DECREASE: InventoryTransactionType.ADJUSTMENT_INCREASE,
    }

    async def _validate_reversal_original(
        self,
        *,
        original: InventoryTransaction,
        warehouse: Warehouse,
    ) -> tuple[InventoryLot, InventoryItem]:
        """Symmetrically validate the original-side entities of a reversal.

        Sprint 5.4.4 — before deriving authorization scopes or posting
        any ledger row, this helper verifies that the loaded
        transaction's ``warehouse_id``, ``lot_id``, ``item_id`` and
        ``organization_id`` all agree with the loaded lot / item /
        warehouse. Any inconsistency is refused with a specific
        diagnostic code; no writes are attempted.

        Called by both :meth:`resolve_reversal_scopes` (which must
        never derive permission scopes from malformed relationships)
        and :meth:`reversal` (which must never let malformed rows
        reach ``_post_ledger``). Returns the validated
        ``(original_lot, item)`` pair.
        """
        # Caller has already loaded ``warehouse`` for ``original.warehouse_id``,
        # so we assert the invariant defensively without repeating the
        # 404 that the caller already emits.
        if original.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Original transaction not found.",
            )
        if original.organization_id != warehouse.organization_id:
            # Do not surface the mismatched org id — the diagnostic
            # code is enough for ops without leaking cross-tenant
            # detail to the caller.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_org_mismatch",
                    "message": (
                        "Original transaction organization does not match "
                        "its warehouse; refusing to reverse."
                    ),
                    "original_transaction_id": str(original.id),
                },
            )
        original_lot = await self.lot_repo.get_by_id(original.lot_id)
        if original_lot is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Original transaction lot not found.",
            )
        if original_lot.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_lot_warehouse_mismatch",
                    "message": (
                        "Original transaction lot does not belong to the "
                        "request warehouse; refusing to reverse."
                    ),
                    "original_transaction_id": str(original.id),
                },
            )
        if original_lot.item_id != original.item_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_lot_item_mismatch",
                    "message": (
                        "Original transaction lot references a different "
                        "inventory item; refusing to reverse."
                    ),
                    "original_transaction_id": str(original.id),
                },
            )
        item = await self.item_repo.get_by_id(original.item_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
        if item.organization_id != warehouse.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_item_org_mismatch",
                    "message": (
                        "Original transaction item belongs to a different "
                        "organization; refusing to reverse."
                    ),
                    "original_transaction_id": str(original.id),
                },
            )
        return original_lot, item

    async def _validate_paired_transfer(
        self,
        *,
        original: InventoryTransaction,
        warehouse: Warehouse,
        item: InventoryItem,
    ) -> tuple[InventoryTransaction, Warehouse, InventoryLot, InventoryItem]:
        """Symmetrically validate the paired-transfer side of a reversal.

        Sprint 5.4.4 — extends the Sprint 5.4.3 paired-transfer checks
        with full partner-side lot / item / tenant symmetry, so that
        neither :meth:`resolve_reversal_scopes` nor :meth:`reversal`
        can derive scopes or post ledger rows from a malformed
        counterpart. Returns
        ``(partner, partner_warehouse, partner_lot, partner_item)``
        once every invariant holds. Raises on any break; performs no
        writes.
        """
        if original.reference_type != "transfer" or original.reference_id is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_incomplete",
                    "message": (
                        "Transfer ledger row is missing the canonical "
                        "transfer linkage. Refusing to reverse to "
                        "preserve inventory integrity."
                    ),
                    "original_transaction_id": str(original.id),
                    "reference_type": original.reference_type,
                    "reference_id": (
                        str(original.reference_id) if original.reference_id is not None else None
                    ),
                },
            )
        candidates = await self.tx_repo.list_by_reference("transfer", original.reference_id)
        transfer_rows = [
            t
            for t in candidates
            if t.transaction_type
            in (
                InventoryTransactionType.TRANSFER_OUT,
                InventoryTransactionType.TRANSFER_IN,
            )
        ]
        out_rows = [
            t for t in transfer_rows if t.transaction_type == InventoryTransactionType.TRANSFER_OUT
        ]
        in_rows = [
            t for t in transfer_rows if t.transaction_type == InventoryTransactionType.TRANSFER_IN
        ]
        if len(transfer_rows) != 2 or len(out_rows) != 1 or len(in_rows) != 1:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_incomplete",
                    "message": (
                        "Transfer pair does not have exactly one "
                        "TRANSFER_OUT and one TRANSFER_IN. Refusing "
                        "to reverse to preserve inventory integrity."
                    ),
                    "reference_id": str(original.reference_id),
                    "matched_out": len(out_rows),
                    "matched_in": len(in_rows),
                },
            )
        partner = (
            out_rows[0]
            if original.transaction_type == InventoryTransactionType.TRANSFER_IN
            else in_rows[0]
        )
        if partner.id == original.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_incomplete",
                    "message": "Partner row resolves to the original.",
                    "reference_id": str(original.reference_id),
                },
            )
        # ------------------------------------------------------------ #
        # Pair-level attribute invariants.
        # ------------------------------------------------------------ #
        if partner.organization_id != original.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_cross_org",
                    "message": ("Transfer pair spans multiple organizations; refusing to reverse."),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner.item_id != original.item_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_item_mismatch",
                    "message": (
                        "Transfer pair references different inventory items; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner.unit != original.unit:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_unit_mismatch",
                    "message": (
                        "Transfer pair rows disagree on canonical unit; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if Decimal(str(partner.quantity)) != Decimal(str(original.quantity)):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_quantity_mismatch",
                    "message": ("Transfer pair rows disagree on quantity; refusing to reverse."),
                    "reference_id": str(original.reference_id),
                },
            )
        # ------------------------------------------------------------ #
        # Partner warehouse: resolvable, same-org, non-CLOSED, distinct.
        # ------------------------------------------------------------ #
        partner_warehouse = await self.warehouse_repo.get_by_id(partner.warehouse_id)
        if (
            partner_warehouse is None
            or partner_warehouse.organization_id != warehouse.organization_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_cross_org",
                    "message": (
                        "Paired transfer belongs to a different organization; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner.warehouse_id == original.warehouse_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_warehouse_mismatch",
                    "message": (
                        "Transfer pair rows share a warehouse; a "
                        "transfer must straddle two distinct "
                        "warehouses. Refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner_warehouse.status == WarehouseStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "warehouse_closed_no_writes",
                    "message": (
                        "The counterpart warehouse for this transfer "
                        "is CLOSED and read-only. Reopen it before "
                        "reversing the transfer."
                    ),
                    "warehouse_id": str(partner_warehouse.id),
                },
            )
        # ------------------------------------------------------------ #
        # Partner lot: exists, belongs to partner warehouse, references
        # the same canonical item as the partner transaction (and,
        # transitively, the original transaction).
        # ------------------------------------------------------------ #
        partner_lot = await self.lot_repo.get_by_id(partner.lot_id)
        if partner_lot is None or partner_lot.warehouse_id != partner.warehouse_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_lot_mismatch",
                    "message": (
                        "Paired transfer lot does not belong to the "
                        "paired warehouse; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner_lot.item_id != partner.item_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_partner_lot_item_mismatch",
                    "message": (
                        "Paired transfer lot references a different "
                        "inventory item; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        # ------------------------------------------------------------ #
        # Partner item: exists, same-org, and matches the canonical
        # item id already validated on the original side.
        # ------------------------------------------------------------ #
        partner_item = await self.item_repo.get_by_id(partner.item_id)
        if partner_item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Partner item not found.")
        if partner_item.organization_id != warehouse.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_partner_item_org_mismatch",
                    "message": (
                        "Partner transaction item belongs to a different "
                        "organization; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        if partner_item.id != item.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_item_mismatch",
                    "message": (
                        "Original and partner transactions resolve to "
                        "different canonical items; refusing to reverse."
                    ),
                    "reference_id": str(original.reference_id),
                },
            )
        return partner, partner_warehouse, partner_lot, partner_item

    async def resolve_reversal_scopes(
        self,
        *,
        warehouse: Warehouse,
        reverses_transaction_id: uuid.UUID,
    ) -> list[tuple[uuid.UUID, uuid.UUID | None]]:
        """Return the (organization_id, farm_id) scopes the caller must be
        authorized against BEFORE :meth:`reversal` is invoked.

        Sprint 5.4.3 — transfer reversal writes to two warehouses in
        one atomic operation, so authorization MUST cover both
        participating warehouse / farm scopes. The endpoint calls
        this helper to enumerate scopes to check; the actual
        permission enforcement stays in the endpoint layer where
        :func:`_enforce_prod_permission` lives.

        Sprint 5.4.4 — scopes are only returned after full symmetric
        entity validation (:meth:`_validate_reversal_original` and,
        for transfer rows, :meth:`_validate_paired_transfer`). Under
        NO circumstances does this method surface a scope derived
        from malformed or cross-tenant linkage.
        """
        original = await self.tx_repo.get_by_id(reverses_transaction_id)
        if original is None or original.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Original transaction not found.",
            )
        # Symmetric original-side validation runs for every reversal.
        # Only after it passes do we begin composing authorization
        # scopes.
        _, item = await self._validate_reversal_original(original=original, warehouse=warehouse)
        scopes: list[tuple[uuid.UUID, uuid.UUID | None]] = [
            (warehouse.organization_id, warehouse.farm_id),
        ]
        if original.transaction_type not in (
            InventoryTransactionType.TRANSFER_OUT,
            InventoryTransactionType.TRANSFER_IN,
        ):
            return scopes
        # Paired-transfer reversals additionally require the full
        # partner-side symmetric validation before we surface the
        # counterpart's scope.
        _, partner_warehouse, _, _ = await self._validate_paired_transfer(
            original=original, warehouse=warehouse, item=item
        )
        scopes.append((partner_warehouse.organization_id, partner_warehouse.farm_id))
        return scopes

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

        Idempotency contract (CRG03 fix): the ``(lot_id, key)`` replay
        check now runs FIRST — a retried call with the same key
        replays the original 200 response even after the original
        successful call left an ``already_reversed`` state. Only
        callers with a fresh key hit the "already reversed" 409.

        Sprint 5.4.2 — Atomic warehouse-transfer reversal. When the
        caller targets one side of a paired ``TRANSFER_OUT`` /
        ``TRANSFER_IN``, the reversal is treated as one atomic
        business operation across BOTH warehouses. Rather than
        assume a specific linkage column, we first inspected the
        transfer creation flow (:meth:`transfer`) and determined
        that both ledger rows are already atomically written with
        ``reference_type='transfer'`` + a common ``reference_id``.
        This method reuses that existing canonical transfer
        linkage; a new linkage would only be introduced if none
        currently existed — none was needed here, so no schema
        change ships. Concretely:

        * the paired transaction is located via the existing
          ``reference_id`` (no new schema — the existing
          identifier is the canonical link);
        * an inverse ledger row is posted on BOTH lots (source AND
          destination) and a REVERSAL marker is posted for BOTH
          originals;
        * every write happens inside the caller's DB transaction, so
          a failure at any step (including
          ``insufficient_stock`` on the destination side —
          e.g. stock already moved on) rolls back both sides and
          leaves the warehouse balances untouched.

        Reversing either side (OUT or IN) produces the same
        outcome; the frontend only exposes the reversal action on
        the canonical ``transfer_out`` row but the backend accepts
        either as the entry point.
        """
        # CLOSED strictly blocks reversals; MAINTENANCE allows them
        # (reversals are the audit-correction pathway). The inverse
        # ledger row uses ``bypass_maintenance_gate`` so the DECREASE
        # side of a reversal still lands under MAINTENANCE.
        if warehouse.status == WarehouseStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "warehouse_closed_no_writes",
                    "message": "This warehouse is CLOSED and read-only.",
                    "warehouse_id": str(warehouse.id),
                },
            )
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

        # ------------------------------------------------------------ #
        # Symmetric original-side validation (Sprint 5.4.4).
        # ------------------------------------------------------------ #
        # Verify original.warehouse_id / lot_id / item_id /
        # organization_id agree with the loaded warehouse, lot and
        # item BEFORE we consider paired-transfer semantics or
        # locking. Any mismatch is refused with a specific diagnostic
        # code and NO writes are attempted.
        _, item = await self._validate_reversal_original(original=original, warehouse=warehouse)

        # ------------------------------------------------------------ #
        # Paired-transfer detection + hardening
        # (Sprint 5.4.3, extended in Sprint 5.4.4).
        # ------------------------------------------------------------ #
        # A completed transfer is exactly two ledger rows sharing
        # ``reference_type='transfer'`` + a common ``reference_id``
        # (set atomically by :meth:`transfer`). The Sprint 5.4.3
        # hardening tightened this into an inviolable business
        # invariant, and Sprint 5.4.4 added full symmetric
        # lot / tenant validation on BOTH sides:
        #
        #   A warehouse transfer is one atomic business operation
        #   and must either be fully reversed or not reversed at
        #   all. Any TRANSFER_OUT / TRANSFER_IN whose canonical
        #   linkage cannot be verified is refused outright — the
        #   generic single-row reversal path is never used for
        #   transfer transactions.
        partner: InventoryTransaction | None = None
        partner_warehouse: Warehouse | None = None
        partner_item: InventoryItem | None = None
        if original.transaction_type in (
            InventoryTransactionType.TRANSFER_OUT,
            InventoryTransactionType.TRANSFER_IN,
        ):
            (
                partner,
                partner_warehouse,
                _partner_lot_probe,
                partner_item,
            ) = await self._validate_paired_transfer(
                original=original, warehouse=warehouse, item=item
            )

        # ------------------------------------------------------------ #
        # Lot locking. For paired transfers we lock BOTH lots in a
        # deterministic order (sorted by id) so concurrent reversals
        # of paired rows cannot deadlock.
        # ------------------------------------------------------------ #
        if partner is not None and partner.lot_id != original.lot_id:
            first_id, second_id = sorted([original.lot_id, partner.lot_id], key=str)
            lot_first = await self._lock_lot(first_id)
            lot_second = await self._lock_lot(second_id)
            original_lot = lot_first if lot_first.id == original.lot_id else lot_second
            partner_lot = lot_first if lot_first.id == partner.lot_id else lot_second
        else:
            original_lot = await self._lock_lot(original.lot_id)
            partner_lot = original_lot if partner is not None else None

        # Defensive re-check after locking: locked lots must still
        # match the tx warehouse / item they were validated against.
        # A concurrent write cannot change these columns under the
        # row-level lock but we assert to make the invariant explicit
        # for future maintainers.
        if original_lot.warehouse_id != warehouse.id or original_lot.item_id != original.item_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_lot_warehouse_mismatch",
                    "message": (
                        "Original lot state changed between validation "
                        "and locking; refusing to reverse."
                    ),
                    "original_transaction_id": str(original.id),
                },
            )
        if partner is not None:
            assert partner_lot is not None
            if (
                partner_lot.warehouse_id != partner.warehouse_id
                or partner_lot.item_id != partner.item_id
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_partner_lot_item_mismatch",
                        "message": (
                            "Partner lot state changed between "
                            "validation and locking; refusing to reverse."
                        ),
                        "reference_id": str(original.reference_id),
                    },
                )

        p_hash = _payload_hash(
            {
                "op": "reversal",
                "reverses": str(original.id),
                "reason": payload["reason"],
            }
        )
        # Idempotency replay — MUST come before the "already_reversed"
        # check so that a retried call with the same key returns the
        # original successful response (200) instead of a 409. Keyed
        # on the caller-selected lot even for paired transfers so
        # the same client-side retry rules apply.
        replay = await self._check_idempotency(
            lot_id=original_lot.id, key=idempotency_key, payload_hash=p_hash
        )
        if replay is not None:
            return replay, True

        # Only after the replay-lookup do we enforce the once-only
        # rule for fresh reversals. For paired transfers BOTH sides
        # must be un-reversed; otherwise refuse rather than leave the
        # opposite side stranded.
        for target in (original, partner) if partner is not None else (original,):
            already = await self.tx_repo.list_by_reference("inventory_transaction", target.id)
            if any(t.transaction_type == InventoryTransactionType.REVERSAL for t in already):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "already_reversed",
                        "message": "This transaction has already been reversed.",
                        "original_transaction_id": str(target.id),
                    },
                )

        # ------------------------------------------------------------ #
        # Post inverse + marker rows. Every _post_ledger call runs
        # inside the caller's session; a failure at any step raises
        # HTTPException and SQLAlchemy rolls the whole transaction
        # back, so warehouse balances remain unchanged. This is the
        # atomic guarantee for paired transfer reversals.
        # ------------------------------------------------------------ #
        # 1a) Inverse row on the caller-selected side.
        await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=original_lot,
            tx_type=self._REVERSAL_INVERSE[original.transaction_type],
            quantity_canonical=Decimal(str(original.quantity)),
            reason=f"Reversal of {original.id}: {payload['reason']}",
            idempotency_key=None,
            payload_hash=p_hash,
            reference_type="reversal_inverse_of",
            reference_id=original.id,
            request_ctx=request_ctx,
            bypass_maintenance_gate=True,
        )
        # 1b) Inverse row on the partner side (paired-transfer only).
        if partner is not None:
            assert partner_warehouse is not None
            assert partner_lot is not None
            assert partner_item is not None
            await self._post_ledger(
                actor=actor,
                organization_id=partner_warehouse.organization_id,
                farm_id=partner_warehouse.farm_id,
                warehouse=partner_warehouse,
                item=partner_item,
                lot=partner_lot,
                tx_type=self._REVERSAL_INVERSE[partner.transaction_type],
                quantity_canonical=Decimal(str(partner.quantity)),
                reason=f"Reversal of {partner.id}: {payload['reason']}",
                idempotency_key=None,
                payload_hash=p_hash,
                reference_type="reversal_inverse_of",
                reference_id=partner.id,
                request_ctx=request_ctx,
                bypass_maintenance_gate=True,
            )
        # 2a) REVERSAL marker on the caller-selected side. Carries the
        # caller's Idempotency-Key so the partial unique index on
        # (lot_id, idempotency_key) still enforces exactly-once
        # semantics for the request as a whole.
        marker = await self._post_ledger(
            actor=actor,
            organization_id=warehouse.organization_id,
            farm_id=warehouse.farm_id,
            warehouse=warehouse,
            item=item,
            lot=original_lot,
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
        # 2b) REVERSAL marker on the partner side (paired-transfer only).
        # No idempotency key — the caller-selected side owns the key so
        # the partial index still upholds one-key-per-lot uniqueness
        # even if the two lots happen to collide in the future.
        if partner is not None:
            assert partner_warehouse is not None
            assert partner_lot is not None
            assert partner_item is not None
            await self._post_ledger(
                actor=actor,
                organization_id=partner_warehouse.organization_id,
                farm_id=partner_warehouse.farm_id,
                warehouse=partner_warehouse,
                item=partner_item,
                lot=partner_lot,
                tx_type=InventoryTransactionType.REVERSAL,
                quantity_canonical=Decimal(str(partner.quantity)),
                reason=payload["reason"],
                idempotency_key=None,
                payload_hash=p_hash,
                reference_type="inventory_transaction",
                reference_id=partner.id,
                reverses_transaction_id=partner.id,
                request_ctx=request_ctx,
            )
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

        # Sprint 4.1 P2 Code Review (Medium) — tenant / farm authorization
        # MUST run BEFORE the FEEDING category guard, otherwise a caller
        # who is not a member of the lot's organization can distinguish
        # between "the lot exists but is medicine/chemical/supply"
        # (409 inventory_item_not_feed) and "the lot exists and is
        # feed" (409 cross_org_lot_reference), leaking category and
        # existence information across tenants. Load the warehouse and
        # verify org / farm ownership up-front so unauthorized callers
        # observe a single, uniform response regardless of the target
        # lot's category.
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

        # Sprint 4.1 P2 Task 1 — FEEDING events may only draw down feed
        # inventory. Consuming medicine, chemicals, or supplies as feed
        # corrupts inventory accounting AND downstream biomass / FCR
        # projections. Refuse before any ledger write happens.
        #
        # This runs AFTER the tenant / farm authorization above so
        # cross-tenant callers cannot distinguish item categories via
        # differential error codes.
        if item.category != InventoryItemCategory.FEED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "inventory_item_not_feed",
                    "message": (
                        "FEEDING events may only consume inventory items "
                        "of category 'feed'. The referenced lot holds an "
                        f"item of category '{item.category.value}'."
                    ),
                    "item_id": str(item.id),
                    "item_category": item.category.value,
                    "lot_id": str(lot.id),
                },
            )

        self._assert_warehouse_status_allows(warehouse, InventoryTransactionType.CONSUMPTION)

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
