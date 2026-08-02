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
from sqlalchemy import select
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
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.inventory import (
    InventoryItemRepository,
    InventoryLotRepository,
    InventoryTransactionRepository,
    StorageLocationRepository,
    WarehouseRepository,
)
from app.repositories.org_repo import FarmRepository, OrganizationRepository
from app.security.authorize import has_permission, resolve_permissions
from app.services._authorization_lock import acquire_org_authorization_locks
from app.services._transfer_locks import (
    acquire_transfer_advisory_lock,
    require_exactly_one,
    require_set_equality,
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

    # Sprint 5.4.6 — deterministic-locking test hook. When set (by a
    # PostgreSQL concurrency test), :meth:`_acquire_reversal_context`
    # waits on this event AFTER the unlocked pair-discovery step and
    # BEFORE acquiring transaction-row FOR UPDATE locks. Two racers
    # can register the same event, discover their pair independently,
    # then release the barrier simultaneously — guaranteeing the two
    # requests contend for the transaction locks concurrently. Never
    # set in production code paths.
    _reversal_lock_barrier: ClassVar[object | None] = None

    # Sprint 5.4.6 — one-way "warehouse locks acquired" signal. The
    # reverser calls ``.set()`` on this event immediately AFTER it has
    # acquired the bulk FOR UPDATE lock on every warehouse row in the
    # reversal context. Mutation-race tests use this signal to know
    # exactly when it is safe to fire a concurrent UPDATE that MUST
    # block on the reverser's row lock. Never set in production.
    _reversal_after_warehouse_locks_signal: ClassVar[object | None] = None

    # Sprint 5.4.7 — one-way "farm + organization locks acquired"
    # signal. Set after both the referenced farm rows and the owning
    # organization row are held FOR UPDATE. Mutation-race tests for
    # farm.organization_id / farm.is_active / farm.deleted_at and
    # organization.is_active / organization.deleted_at wait on this
    # before firing their competing UPDATE.
    _reversal_after_farm_org_locks_signal: ClassVar[object | None] = None

    # Sprint 5.4.7 — reverser HOLD gate. When set (asyncio.Event),
    # the reverser awaits this event AFTER signalling that farm +
    # organization row locks are held and BEFORE proceeding. Tests
    # use this to keep the reverser transaction OPEN while asserting
    # a competing UPDATE is genuinely blocked. Never set in
    # production.
    _reversal_hold_after_farm_org_locks_gate: ClassVar[object | None] = None

    # Sprint 5.4.7 — one-way "item locks acquired" signal. Set after
    # the bulk FOR UPDATE on the referenced item rows completes.
    # Item mutation-race tests wait on this before firing their
    # competing UPDATE on ``inventory_items.organization_id`` /
    # ``inventory_items.deleted_at``.
    _reversal_after_item_locks_signal: ClassVar[object | None] = None

    # ---------------------------------------------------------------- #
    # Sprint 5.4.11 — transfer-authorization race hooks.
    # Every hook below is a class-level ``ClassVar`` that production
    # code never touches (default ``None``). The Sprint 5.4.11
    # concurrency test suite temporarily assigns real
    # ``asyncio.Event`` instances so it can drive deterministic races
    # against the locked-authorization pipeline in
    # :meth:`InventoryService.transfer`.
    # ---------------------------------------------------------------- #

    # Waited on BEFORE :meth:`transfer` acquires ANY row locks. Lets a
    # racing "mutator" coroutine commit a permission / membership /
    # role / warehouse-assignment / farm-assignment / organization
    # status change while the transfer request is guaranteed paused,
    # then release the barrier so the transfer proceeds. The transfer
    # then reads the CURRENT authoritative state under lock and MUST
    # refuse against the new state.
    _transfer_pre_lock_barrier: ClassVar[object | None] = None

    # Set immediately AFTER :meth:`transfer` has bulk-locked every
    # warehouse, farm, and organization row referenced by the
    # request. Row-locked mutation races (e.g. flipping
    # ``organization.is_active`` while the transfer holds the FOR
    # UPDATE lock) wait on this signal before firing their competing
    # UPDATE — proving the UPDATE blocks on the transfer lock.
    _transfer_after_locks_signal: ClassVar[object | None] = None

    # Awaited AFTER the locks-acquired signal fires and BEFORE the
    # authorization decision runs. Race tests use it to keep the
    # transfer transaction paused (still holding every FOR UPDATE
    # lock) while proving that a competing UPDATE is genuinely
    # blocked; releasing the gate lets the transfer complete its
    # authorization step and either commit or refuse.
    _transfer_hold_before_authorize_gate: ClassVar[object | None] = None

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
        farm_repo: FarmRepository | None = None,
        org_repo: OrganizationRepository | None = None,
    ) -> None:
        self.session = session
        self.warehouse_repo = warehouse_repo
        self.item_repo = item_repo
        self.lot_repo = lot_repo
        self.tx_repo = tx_repo
        self.location_repo = location_repo
        self.audit_repo = audit_repo
        # Sprint 5.4.7 — farm + organization repositories are required
        # by the reversal locking sequence. Instantiate lazily from the
        # session when the caller did not inject them (older tests).
        self.farm_repo = farm_repo or FarmRepository(session)
        self.org_repo = org_repo or OrganizationRepository(session)

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
        transfer_group_id: uuid.UUID | None = None,
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
            transfer_group_id=transfer_group_id,
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

    async def _authorize_transfer_from_locked(
        self,
        *,
        actor: User,
        source_warehouse: Warehouse,
        dst_warehouse: Warehouse,
        locked_farms: list[Farm] | None = None,
    ) -> None:
        """Sprint 5.4.11 — authorization derived from LOCKED rows.

        Called AFTER :meth:`transfer` has bulk-locked source and
        destination warehouses, their referenced farms, and the
        owning organization. Both scope tuples ``(organization_id,
        farm_id)`` are read directly from the LOCKED warehouse
        rows so no pre-lock ORM object can influence the decision.

        Contract:

        * Superusers bypass every check.
        * The tenancy-leak invariant is preserved: callers who are
          NOT a member of the authoritative locked organization
          (with, for farm-pinned warehouses, either an active
          organization membership OR an active farm membership) see
          HTTP 404 — the same shape as a non-existent warehouse.
        * Members who lack ``inventory_transaction.create`` at the
          scope of the source or destination warehouse see HTTP 403
          with detail ``Missing required permission:
          inventory_transaction.create`` (matches the endpoint's
          former behaviour and existing test assertions).
        * Both scopes are checked — a caller with source-only
          permission cannot pump stock into a destination they do
          not control (Sprint 4 CRG03 dual-authorization contract,
          preserved).
        """
        if actor.is_superuser:
            return
        # Both scopes are read from the LOCKED warehouse rows.
        scopes = {
            (source_warehouse.organization_id, source_warehouse.farm_id),
            (dst_warehouse.organization_id, dst_warehouse.farm_id),
        }
        # A corrupt/racing warehouse→farm edge must not reveal the foreign
        # farm tenant. Authorize its authoritative locked organization too
        # before returning any topology or lifecycle diagnostic.
        for farm in locked_farms or []:
            scopes.add((farm.organization_id, farm.id))
        for organization_id, farm_id in sorted(scopes, key=lambda scope: tuple(map(str, scope))):
            # Membership check — non-members see 404 to preserve the
            # tenancy-leak invariant established in Sprint 1 / CRG02.
            await self._assert_actor_membership_under_lock(
                actor=actor,
                organization_id=organization_id,
                farm_id=farm_id,
            )
            # Permission check — resolve fresh permission codes for
            # the actor at this LOCKED scope. Role assignments,
            # permissions, and memberships are re-read every call
            # so a revocation that committed before this point is
            # observed authoritatively.
            codes = await resolve_permissions(
                self.session,
                actor,
                organization_id=organization_id,
                farm_id=farm_id,
            )
            if not has_permission(codes, "inventory_transaction.create"):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=("Missing required permission: inventory_transaction.create"),
                )

    async def _assert_actor_membership_under_lock(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        farm_id: uuid.UUID | None,
    ) -> None:
        """Sprint 5.4.11 — tenancy 404 for non-members.

        Mirrors the endpoint's ``_assert_org_membership`` /
        ``_assert_farm_membership_or_org_access`` helpers so the
        service-layer authorization pipeline produces the same 404
        shape a non-member would have seen under the previous
        endpoint-layer check — no membership 403 leak.
        """
        # Active org membership always wins (org-scope reader).
        org_mem = (
            await self.session.execute(
                select(OrganizationMembership).where(
                    OrganizationMembership.user_id == actor.id,
                    OrganizationMembership.organization_id == organization_id,
                    OrganizationMembership.is_active.is_(True),
                    OrganizationMembership.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if org_mem is not None:
            return
        # For farm-pinned scopes, an active farm membership is
        # equally sufficient. Otherwise the caller is not a member of
        # the authoritative locked org and MUST see 404.
        if farm_id is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
        farm_mem = (
            await self.session.execute(
                select(FarmMembership).where(
                    FarmMembership.user_id == actor.id,
                    FarmMembership.farm_id == farm_id,
                    FarmMembership.is_active.is_(True),
                    FarmMembership.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if farm_mem is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")

    async def transfer(
        self,
        *,
        actor: User,
        warehouse_id: uuid.UUID,
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

        Sprint 5.4.11 — locked authorization + authoritative
        permission resolution. The endpoint hands us only the caller
        identity and identifiers (``warehouse_id`` +
        ``payload["destination_warehouse_id"]``). Every authorization
        decision runs INSIDE this method, AFTER we have acquired
        canonical ``SELECT ... FOR UPDATE`` locks on the warehouses,
        their referenced farms, and the owning organization. We then
        reload authoritative rows via the identity map (the locked
        rows), derive authorization scopes from those locked rows,
        and only then query membership + role-assignment tables to
        resolve permissions. A permission, membership, role,
        warehouse assignment, farm assignment, or organization
        status change that commits BEFORE our lock-acquisition sees
        our authorization check refuse against the new state; a
        change racing against the lock either blocks (row-locked
        columns such as ``warehouse.farm_id``, ``farm.is_active``,
        ``organization.is_active``) or, if independently locked
        (``role_assignments``, ``organization_memberships``,
        ``farm_memberships``), lands before our fresh authorization
        query reads it. Either way the transfer is rejected using
        the authoritative locked state — never a stale pre-lock
        view.
        """
        dst_warehouse_id = payload["destination_warehouse_id"]

        # Sprint 5.4.11 — pre-lock race barrier. Concurrency tests
        # register an ``asyncio.Event`` so the mutator coroutine can
        # commit its permission / membership / role / warehouse-
        # assignment / farm / organization change BEFORE the
        # transfer request acquires any row locks. Production leaves
        # this ``None`` and the branch is a no-op.
        pre_lock_barrier = type(self)._transfer_pre_lock_barrier
        if pre_lock_barrier is not None:
            pre_wait = getattr(pre_lock_barrier, "wait", None)
            if pre_wait is not None:
                pre_res = pre_wait()
                if hasattr(pre_res, "__await__"):
                    await pre_res

        # (1) Bulk-lock BOTH warehouses FOR UPDATE in ascending id
        # order. This is the ONLY place we acquire warehouse locks
        # in the transfer path — deterministic across every caller
        # (A→B and B→A collapse to the same lock order).
        wh_ids_sorted = sorted({warehouse_id, dst_warehouse_id}, key=str)
        locked_whs = await self.warehouse_repo.list_by_ids_for_update(wh_ids_sorted)
        wh_by_id = {w.id: w for w in locked_whs}
        # Missing / soft-deleted warehouse ⇒ tenancy-safe 404.
        # Sprint 5.4.12 — the message is the SAME for source and
        # destination so a caller cannot distinguish "the warehouse
        # I named exists but I lack access to it" from "no such
        # warehouse" from the destination-side response alone.
        if warehouse_id not in wh_by_id or wh_by_id[warehouse_id].deleted_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
        if dst_warehouse_id not in wh_by_id or wh_by_id[dst_warehouse_id].deleted_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
        warehouse = wh_by_id[warehouse_id]
        dst_warehouse = wh_by_id[dst_warehouse_id]

        # (2) Bulk-lock every referenced farm FOR UPDATE in ascending
        # id order. Soft-deleted / inactive farms REFUSE the transfer
        # under lock; a concurrent flip of ``farm.is_active`` /
        # ``farm.deleted_at`` blocks on this lock until we commit,
        # and if the flip landed BEFORE we acquired the lock we
        # observe the new state here and refuse.
        farm_ids_set: set[uuid.UUID] = set()
        for wh in (warehouse, dst_warehouse):
            if wh.farm_id is not None:
                farm_ids_set.add(wh.farm_id)
        farm_ids = sorted(farm_ids_set, key=str)
        locked_farms = await self.farm_repo.list_by_ids_for_update(farm_ids)
        farm_by_id: dict[uuid.UUID, Farm] = {f.id: f for f in locked_farms}
        for fid in farm_ids:
            if fid not in farm_by_id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")

        # (3) Bulk-lock the owning organization(s) FOR UPDATE.
        # Cross-org transfers are refused below; typically both
        # warehouses share ONE org and we lock exactly one row.
        org_ids = sorted({warehouse.organization_id, dst_warehouse.organization_id}, key=str)
        locked_orgs = await self.org_repo.list_by_ids_for_update(org_ids)
        org_by_id = {o.id: o for o in locked_orgs}
        for oid in org_ids:
            if oid not in org_by_id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Warehouse not found.")
        # (4) Sprint 5.4.12 — AUTHORIZATION ADVISORY LOCK.
        # Acquire the transaction-scoped per-organization
        # authorization advisory lock BEFORE any read against
        # ``organization_memberships`` / ``farm_memberships`` /
        # ``role_assignments`` / ``roles`` / ``role_permissions``.
        # Every mutation of those tables acquires the SAME lock
        # first (see :mod:`app.services._authorization_lock` and
        # its callers in :mod:`app.services.invitation_service`,
        # :mod:`app.services.organization_service`). Two orgs are
        # independent — a transfer within org A does not block
        # authorization work on org B.
        await acquire_org_authorization_locks(
            self.session,
            {warehouse.organization_id, dst_warehouse.organization_id},
        )

        # Sprint 5.4.11 test hook — locks + advisory lock are now
        # held. Race tests wait on this signal to know that a
        # competing authorization mutation which also participates
        # in the advisory-lock protocol MUST block until this
        # transaction commits or rolls back.
        locks_signal = type(self)._transfer_after_locks_signal
        if locks_signal is not None:
            lset = getattr(locks_signal, "set", None)
            if lset is not None:
                lset()

        # Sprint 5.4.11 / 5.4.12 test hook — hold transfer AFTER
        # every row lock AND the authorization advisory lock are
        # acquired, BEFORE the authorization decision runs. Race
        # tests use this gate to prove concurrent revocations
        # genuinely block against the advisory-lock protocol.
        hold = type(self)._transfer_hold_before_authorize_gate
        if hold is not None:
            hold_wait = getattr(hold, "wait", None)
            if hold_wait is not None:
                res = hold_wait()
                if hasattr(res, "__await__"):
                    await res

        # (5) LOCKED AUTHORIZATION. Every authorization decision from
        # here on is derived exclusively from the LOCKED warehouse /
        # farm / organization rows above. Membership + permission
        # queries run UNDER the per-org authorization advisory lock
        # acquired in step (6) — no concurrent revocation can
        # commit until the outer transaction ends.
        await self._authorize_transfer_from_locked(
            actor=actor,
            source_warehouse=warehouse,
            dst_warehouse=dst_warehouse,
            locked_farms=locked_farms,
        )

        # Only an actor authorized for BOTH locked scopes may learn
        # cross-tenant topology or organization/farm lifecycle state.
        # Unauthorized destination access above always collapses to the
        # tenancy-safe Warehouse-not-found response.
        if warehouse.organization_id != dst_warehouse.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cross_org_transfer_forbidden",
                    "message": "Cannot transfer across organizations.",
                },
            )
        for f in locked_farms:
            if f.organization_id != warehouse.organization_id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_organization_mismatch",
                        "message": "Locked farm belongs to a different organization.",
                        "farm_id": str(f.id),
                        "farm_organization_id": str(f.organization_id),
                        "expected_organization_id": str(warehouse.organization_id),
                    },
                )
            if f.deleted_at is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_deleted",
                        "message": "Referenced farm is soft-deleted.",
                        "farm_id": str(f.id),
                    },
                )
            if not f.is_active:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_inactive",
                        "message": "Referenced farm is inactive.",
                        "farm_id": str(f.id),
                    },
                )
        for o in locked_orgs:
            if o.deleted_at is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_organization_deleted",
                        "message": "Organization is soft-deleted.",
                        "organization_id": str(o.id),
                    },
                )
            if not o.is_active:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_organization_inactive",
                        "message": "Organization is inactive.",
                        "organization_id": str(o.id),
                    },
                )

        # (6) Existing status assertions — MAINTENANCE / CLOSED
        # policy on either side aborts early with the pre-existing
        # diagnostic codes.
        self._assert_warehouse_status_allows(warehouse, InventoryTransactionType.TRANSFER_OUT)
        self._assert_warehouse_status_allows(dst_warehouse, InventoryTransactionType.TRANSFER_IN)

        # Sprint 5.4.8 — resolve the source lot WITHOUT FOR UPDATE.
        # Locking the caller-specified lot first would make lock
        # order request-direction-dependent (A→B locks A first, B→A
        # locks B first) and reintroduce the AB/BA deadlock. The
        # authoritative bulk FOR UPDATE below acquires both lot rows
        # in ascending id order — the SAME order for every caller.
        src_lot = await self.lot_repo.get_by_id(payload["lot_id"])
        if src_lot is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Source lot not found.")
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
        # Sprint 5.4.8 — deterministic bulk lot lock in ascending id
        # order. Request direction (A→B vs B→A) MUST NOT determine
        # lock order — both callers must lock the same lowest-id lot
        # first, so AB/BA deadlocks are eliminated entirely. If both
        # ids collide (self-transfer), the single-element bulk lock
        # is a no-op set.
        lot_ids_sorted = sorted({src_lot.id, dst_lot.id}, key=str)
        locked_lots = await self.lot_repo.list_by_ids_for_update(lot_ids_sorted)
        require_set_equality(locked_lots, resource="lot", requested_ids=set(lot_ids_sorted))
        lots_by_id = {lot.id: lot for lot in locked_lots}
        src_lot = lots_by_id[src_lot.id]
        dst_lot = lots_by_id[dst_lot.id]
        # Post-lock re-validation of the source lot's authoritative
        # warehouse / item association — a concurrent UPDATE between
        # the initial resolve and this lock would trip this.
        if src_lot.warehouse_id != warehouse.id or src_lot.item_id != item.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "lot_association_changed",
                    "message": (
                        "Source lot's warehouse or item association "
                        "changed under lock; refusing to transfer."
                    ),
                    "lot_id": str(src_lot.id),
                },
            )
        if dst_lot.warehouse_id != dst_warehouse.id or dst_lot.item_id != item.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "lot_association_changed",
                    "message": (
                        "Destination lot's warehouse or item association "
                        "changed under lock; refusing to transfer."
                    ),
                    "lot_id": str(dst_lot.id),
                },
            )

        # Sprint 5.4.8 — immutable transfer-group identity. Same value
        # as the legacy ``reference_id`` today (both are freshly
        # generated UUIDs) but the transfer_group_id is column-level
        # immutable via a Postgres trigger, so a hostile UPDATE
        # cannot change the advisory-lock key for this pair.
        transfer_group = uuid.uuid4()
        transfer_ref = transfer_group

        # Sprint 5.4.7/5.4.8 — acquire the transfer-topology advisory
        # lock BEFORE writing either side of the pair. Keyed on the
        # IMMUTABLE ``transfer_group_id`` (Sprint 5.4.8), which
        # cannot drift under concurrent tenant mutation.
        await acquire_transfer_advisory_lock(self.session, transfer_group_id=transfer_group)

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
            transfer_group_id=transfer_group,
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
            transfer_group_id=transfer_group,
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
        # Sprint 5.4.5 — farm-consistency invariant. A ledger row's
        # farm_id MUST match its warehouse's farm_id. A concurrent
        # UPDATE that changed the tx's farm_id would move
        # authorization scope out from under the caller if we did
        # not verify this every time.
        if original.farm_id != warehouse.farm_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_original_farm_mismatch",
                    "message": (
                        "Original transaction farm does not match its "
                        "warehouse; refusing to reverse."
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
        # Sprint 5.4.5 — partner-side farm-consistency invariant.
        # The partner tx's ``farm_id`` MUST match its warehouse's
        # ``farm_id``. Blocks a hostile / bug-driven UPDATE that
        # tries to move the counterpart transaction under a
        # different farm's authorization scope.
        if partner.farm_id != partner_warehouse.farm_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_partner_farm_mismatch",
                    "message": (
                        "Partner transaction farm does not match its "
                        "warehouse; refusing to reverse."
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

    async def _acquire_reversal_context(
        self,
        *,
        warehouse: Warehouse,
        reverses_transaction_id: uuid.UUID,
    ) -> dict:
        """Acquire the authoritative locked reversal context.

        Sprint 5.4.5 — the race-safe backbone of atomic transfer
        reversal. Every caller (:meth:`resolve_reversal_scopes` and
        :meth:`reversal`) routes through here so that authorization
        decisions and ledger writes both operate against the SAME
        locked row state.

        Sprint 5.4.6 — the ORIGINAL sequence locked the caller's
        target row before pair order was known, which under
        PostgreSQL creates the classic AB / BA deadlock between two
        callers reversing the same pair from opposite ends. The
        corrected sequence never locks a caller-selected side before
        the pair has been ordered:

          1.  Read the target transaction UNLOCKED (via
              ``get_by_id``) — purely to learn its type and, for
              transfer rows, its ``reference_id``.
          2.  Enumerate the pair via ``list_by_reference`` (unlocked).
          3.  Sort the two transaction ids ascending and acquire
              BOTH row locks in a single deterministic query
              (``WHERE id IN (:sorted_ids) ORDER BY id ASC
              FOR UPDATE``). Two racers therefore always contend
              for the SAME lock first.
          4.  Adopt the locked rows as authoritative; re-verify
              reference / topology / warehouse invariants against
              the locked state.
          5.  Collect the referenced warehouse and item ids from
              the locked rows, sort them ascending, and lock those
              too via bulk FOR UPDATE queries. Authorization
              scopes are derived EXCLUSIVELY from the locked
              warehouse rows (never from pre-lock ORM objects).
          6.  Sort lot ids ascending; bulk-lock lots FOR UPDATE.
              The write phase re-uses these already-locked rows.
          7.  Run the full symmetric + farm + pair validation
              suite against the fully locked context.

        The returned dict carries the LOCKED ``original`` /
        ``partner`` transactions, LOCKED warehouses, LOCKED items,
        LOCKED lots, and the authorization scopes derived
        exclusively from the locked warehouse state.

        Idempotency within a session: subsequent calls under the
        same session return the same locked rows without releasing
        the locks; ``populate_existing`` re-syncs the identity map
        but the DB-level FOR UPDATE lock is per-transaction, not
        per-statement, so it holds until the outer transaction
        commits or rolls back.
        """
        # (1) UNLOCKED read of the target — just to discover pair
        # identity. Locking here would defeat the ascending-id
        # ordering below whenever the caller's target has the
        # higher id.
        original_probe = await self.tx_repo.get_by_id(reverses_transaction_id)
        if original_probe is None or original_probe.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Original transaction not found.",
            )
        if original_probe.transaction_type == InventoryTransactionType.REVERSAL:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "cannot_reverse_a_reversal",
                    "message": "A REVERSAL row cannot itself be reversed.",
                },
            )

        # For non-transfer reversals we still lock the single target
        # row so the write phase sees an authoritative view. Sprint
        # 5.4.8 extends this path with organization + farm locking so
        # authorization is decided from a fully locked graph, and
        # replaces destructuring with the safe `require_exactly_one`
        # helper (no ValueError leaks on 0 / ≥ 2 rows).
        if original_probe.transaction_type not in (
            InventoryTransactionType.TRANSFER_OUT,
            InventoryTransactionType.TRANSFER_IN,
        ):
            locked_txs = await self.tx_repo.list_by_ids_for_update([original_probe.id])
            original_locked = require_exactly_one(
                locked_txs,
                resource="inventory_transaction",
                identifier=original_probe.id,
            )
            locked_whs = await self.warehouse_repo.list_by_ids_for_update(
                [original_locked.warehouse_id]
            )
            locked_wh = require_exactly_one(
                locked_whs,
                resource="warehouse",
                identifier=original_locked.warehouse_id,
            )
            # Sprint 5.4.8 — lock the farm (if any) and the owning org.
            farm_ids_single = [locked_wh.farm_id] if locked_wh.farm_id is not None else []
            locked_farms_single = await self.farm_repo.list_by_ids_for_update(farm_ids_single)
            if farm_ids_single:
                locked_farm = require_exactly_one(
                    locked_farms_single,
                    resource="farm",
                    identifier=farm_ids_single[0],
                )
                if locked_farm.deleted_at is not None:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        {
                            "code": "transfer_farm_deleted",
                            "message": "Referenced farm is soft-deleted.",
                            "farm_id": str(locked_farm.id),
                        },
                    )
                if not locked_farm.is_active:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        {
                            "code": "transfer_farm_inactive",
                            "message": "Referenced farm is inactive.",
                            "farm_id": str(locked_farm.id),
                        },
                    )
            locked_orgs_single = await self.org_repo.list_by_ids_for_update(
                [locked_wh.organization_id]
            )
            locked_org_single = require_exactly_one(
                locked_orgs_single,
                resource="organization",
                identifier=locked_wh.organization_id,
            )
            if locked_org_single.deleted_at is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_organization_deleted",
                        "message": "Organization is soft-deleted.",
                        "organization_id": str(locked_org_single.id),
                    },
                )
            if not locked_org_single.is_active:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_organization_inactive",
                        "message": "Organization is inactive.",
                        "organization_id": str(locked_org_single.id),
                    },
                )
            locked_items_single = await self.item_repo.list_by_ids_for_update(
                [original_locked.item_id]
            )
            locked_item = require_exactly_one(
                locked_items_single,
                resource="inventory_item",
                identifier=original_locked.item_id,
            )
            locked_lots_single = await self.lot_repo.list_by_ids_for_update(
                [original_locked.lot_id]
            )
            locked_lot = require_exactly_one(
                locked_lots_single,
                resource="inventory_lot",
                identifier=original_locked.lot_id,
            )
            _, item_v = await self._validate_reversal_original(
                original=original_locked, warehouse=locked_wh
            )
            assert item_v.id == locked_item.id
            return {
                "original": original_locked,
                "warehouse": locked_wh,
                "item": locked_item,
                "original_lot": locked_lot,
                "partner": None,
                "partner_warehouse": None,
                "partner_item": None,
                "partner_lot": None,
                "organization": locked_org_single,
                "original_farm": locked_farms_single[0] if locked_farms_single else None,
                "partner_farm": None,
                "scopes": [(locked_wh.organization_id, locked_wh.farm_id)],
            }

        # (2) Enumerate the pair via the shared reference_id. The
        # linkage MUST be present on the target row — if it isn't we
        # refuse before locking anything else.
        if original_probe.reference_type != "transfer" or original_probe.reference_id is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_incomplete",
                    "message": ("Transfer ledger row is missing the canonical transfer linkage."),
                    "original_transaction_id": str(original_probe.id),
                },
            )

        # Sprint 5.4.6 / 5.4.7 — test-only barrier at the advisory-lock
        # boundary. Concurrency proofs use this hook to force BOTH
        # racers to reach the SAME synchronization point (immediately
        # before the transfer-topology advisory lock) so the race that
        # follows is deterministic. Production never sets this; the
        # attribute is ``None`` and the pre-advisory path is a no-op.
        barrier = type(self)._reversal_lock_barrier
        if barrier is not None:
            wait = getattr(barrier, "wait", None)
            if wait is not None:
                res = wait()
                if hasattr(res, "__await__"):
                    await res

        # Sprint 5.4.7/5.4.8 — (2a) Acquire the transfer-topology
        # advisory lock BEFORE authoritative topology discovery.
        # Sprint 5.4.8 keys the lock on the IMMUTABLE
        # ``transfer_group_id`` column (backfilled from
        # ``reference_id`` at migration time for legacy rows). This
        # serialises any concurrent code path that would add /
        # remove / mutate rows into this transfer identity. The
        # lock releases automatically at commit / rollback.
        group_key = (
            original_probe.transfer_group_id
            if original_probe.transfer_group_id is not None
            else original_probe.reference_id
        )
        await acquire_transfer_advisory_lock(self.session, transfer_group_id=group_key)

        # (2b) Re-read the target transaction after acquiring the
        # advisory lock — an earlier concurrent reversal may have
        # committed already (`already_reversed`) and we want the
        # freshest view before we begin locking rows.
        refreshed_target = await self.tx_repo.get_by_id(reverses_transaction_id)
        if refreshed_target is None or refreshed_target.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Original transaction not found.",
            )
        if (
            refreshed_target.reference_type != "transfer"
            or refreshed_target.reference_id != original_probe.reference_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_topology_changed",
                    "message": (
                        "Transfer identity of the target changed between "
                        "the initial read and advisory-lock acquisition."
                    ),
                    "original_transaction_id": str(refreshed_target.id),
                },
            )
        original_probe = refreshed_target

        candidates = await self.tx_repo.list_by_reference("transfer", original_probe.reference_id)
        transfer_rows = [
            t
            for t in candidates
            if t.transaction_type
            in (
                InventoryTransactionType.TRANSFER_OUT,
                InventoryTransactionType.TRANSFER_IN,
            )
        ]
        if len(transfer_rows) != 2:
            # Sprint 5.4.7 — a topology of anything other than exactly
            # one OUT + one IN under the advisory lock is malformed
            # and refused with a distinct diagnostic. Zero writes,
            # zero markers, zero audits.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_topology_malformed",
                    "message": (
                        "Transfer identity contains an invalid number of "
                        "TRANSFER_OUT/TRANSFER_IN rows; refusing to reverse."
                    ),
                    "reference_id": str(original_probe.reference_id),
                    "row_count": len(transfer_rows),
                },
            )
        # Exactly one OUT and one IN.
        out_rows = [
            t for t in transfer_rows if t.transaction_type == InventoryTransactionType.TRANSFER_OUT
        ]
        in_rows = [
            t for t in transfer_rows if t.transaction_type == InventoryTransactionType.TRANSFER_IN
        ]
        if len(out_rows) != 1 or len(in_rows) != 1:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_topology_malformed",
                    "message": (
                        "Transfer identity must contain exactly one "
                        "TRANSFER_OUT and one TRANSFER_IN row."
                    ),
                    "reference_id": str(original_probe.reference_id),
                    "out_count": len(out_rows),
                    "in_count": len(in_rows),
                },
            )
        partner_candidate = next(t for t in transfer_rows if t.id != original_probe.id)

        # (3) Bulk-lock BOTH transaction rows in a single query,
        # ordered by id ASC. This is the ONLY place we acquire the
        # transaction locks — deterministic across every caller.
        ordered_tx_ids = sorted([original_probe.id, partner_candidate.id], key=str)
        locked_txs = await self.tx_repo.list_by_ids_for_update(ordered_tx_ids)
        if len(locked_txs) != 2:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": (
                        "Transfer pair row disappeared between initial "
                        "read and lock acquisition; refusing to reverse."
                    ),
                    "reference_id": str(original_probe.reference_id),
                },
            )
        by_id = {t.id: t for t in locked_txs}
        original_locked = by_id[original_probe.id]
        partner_locked = by_id[partner_candidate.id]

        # (4) Post-lock relationship revalidation — reference_type /
        # reference_id must still form the same pair. A concurrent
        # UPDATE between steps (2) and (3) would trip this.
        if (
            original_locked.reference_type != "transfer"
            or original_locked.reference_id is None
            or partner_locked.reference_type != "transfer"
            or partner_locked.reference_id != original_locked.reference_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": (
                        "Transfer pair linkage changed between initial "
                        "read and lock acquisition; refusing to reverse."
                    ),
                },
            )
        if original_locked.warehouse_id != warehouse.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": (
                        "Original transaction warehouse changed between "
                        "initial read and lock acquisition."
                    ),
                    "original_transaction_id": str(original_locked.id),
                },
            )

        # Sprint 5.4.7 — (4b) Repeat the topology discovery WHILE
        # holding both the advisory lock and the two transaction row
        # locks. Under the advisory lock no writer can add / mutate
        # a third row, but this re-check catches any pre-existing
        # malformed state (e.g. a third row that was inserted before
        # any advisory locking was in place). Any deviation → 409.
        recheck = await self.tx_repo.list_by_reference("transfer", original_locked.reference_id)
        recheck_transfers = [
            t
            for t in recheck
            if t.transaction_type
            in (
                InventoryTransactionType.TRANSFER_OUT,
                InventoryTransactionType.TRANSFER_IN,
            )
        ]
        if len(recheck_transfers) != 2 or {t.id for t in recheck_transfers} != {
            original_locked.id,
            partner_locked.id,
        }:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_topology_malformed",
                    "message": (
                        "Transfer identity topology changed under lock; " "refusing to reverse."
                    ),
                    "reference_id": str(original_locked.reference_id),
                    "row_count": len(recheck_transfers),
                },
            )

        # (5) Lock the two warehouses referenced by the locked
        # transactions, in ascending id order. Scopes are derived
        # ONLY from these locked rows; the endpoint's pre-lock
        # ``warehouse`` object is used solely for path identity
        # matching (and its .id must match ``original_locked.warehouse_id``,
        # already asserted above).
        wh_ids = sorted({original_locked.warehouse_id, partner_locked.warehouse_id}, key=str)
        locked_whs = await self.warehouse_repo.list_by_ids_for_update(wh_ids)
        wh_by_id = {w.id: w for w in locked_whs}
        if (
            original_locked.warehouse_id not in wh_by_id
            or partner_locked.warehouse_id not in wh_by_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "A referenced warehouse disappeared under lock.",
                },
            )
        original_warehouse = wh_by_id[original_locked.warehouse_id]
        partner_warehouse_locked = wh_by_id[partner_locked.warehouse_id]

        # Sprint 5.4.6 test hook — signal that all warehouse row
        # locks are now held by this transaction. Mutation-race
        # tests use this to know it is safe to fire a competing
        # UPDATE that MUST block on our lock. Production leaves the
        # signal unset and pays no cost.
        wh_signal = type(self)._reversal_after_warehouse_locks_signal
        if wh_signal is not None:
            wh_set = getattr(wh_signal, "set", None)
            if wh_set is not None:
                wh_set()

        # Sprint 5.4.7 — (5a) Lock the referenced farm rows FOR
        # UPDATE in ascending id order. Authorization scopes and
        # farm-consistency invariants are derived from these locked
        # rows so a concurrent UPDATE of ``farm.organization_id`` /
        # ``farm.is_active`` / ``farm.deleted_at`` cannot slip
        # between authorization and write.
        farm_ids_set: set[uuid.UUID] = set()
        for wh in (original_warehouse, partner_warehouse_locked):
            if wh.farm_id is not None:
                farm_ids_set.add(wh.farm_id)
        farm_ids = sorted(farm_ids_set, key=str)
        locked_farms = await self.farm_repo.list_by_ids_for_update(farm_ids)
        farm_by_id: dict[uuid.UUID, Farm] = {f.id: f for f in locked_farms}
        # Every referenced farm_id MUST resolve to a locked row.
        missing_farms = [fid for fid in farm_ids if fid not in farm_by_id]
        if missing_farms:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "A referenced farm disappeared under lock.",
                    "missing_farm_ids": [str(fid) for fid in missing_farms],
                },
            )
        # Refuse if any referenced farm is soft-deleted / inactive
        # UNDER LOCK. Diagnostics are distinct so callers can
        # distinguish 'deleted' from 'deactivated'.
        for f in locked_farms:
            if f.deleted_at is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_deleted",
                        "message": ("Referenced farm is soft-deleted; refusing to " "reverse."),
                        "farm_id": str(f.id),
                    },
                )
            if not f.is_active:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_inactive",
                        "message": ("Referenced farm is inactive; refusing to " "reverse."),
                        "farm_id": str(f.id),
                    },
                )

        # Sprint 5.4.7 — (5b) Lock the owning organization row FOR
        # UPDATE. Both warehouses MUST belong to the same
        # organization (validated below); we therefore lock exactly
        # one org row per reversal.
        org_ids = sorted(
            {original_warehouse.organization_id, partner_warehouse_locked.organization_id},
            key=str,
        )
        locked_orgs = await self.org_repo.list_by_ids_for_update(org_ids)
        org_by_id = {o.id: o for o in locked_orgs}
        if any(oid not in org_by_id for oid in org_ids):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "A referenced organization disappeared under lock.",
                },
            )
        # Under the locked view, both warehouses must share ONE org.
        if original_warehouse.organization_id != partner_warehouse_locked.organization_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": (
                        "Transfer pair spans multiple organizations under "
                        "lock; refusing to reverse."
                    ),
                },
            )
        locked_org = org_by_id[original_warehouse.organization_id]
        if locked_org.deleted_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_organization_deleted",
                    "message": ("Organization is soft-deleted; refusing to reverse."),
                    "organization_id": str(locked_org.id),
                },
            )
        if not locked_org.is_active:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_organization_inactive",
                    "message": ("Organization is inactive; refusing to reverse."),
                    "organization_id": str(locked_org.id),
                },
            )

        # Sprint 5.4.7 test hook — signal that farm + organization
        # row locks are now held. Farm / org mutation tests wait on
        # this signal before firing their competing UPDATE.
        farm_org_signal = type(self)._reversal_after_farm_org_locks_signal
        if farm_org_signal is not None:
            fo_set = getattr(farm_org_signal, "set", None)
            if fo_set is not None:
                fo_set()

        # Sprint 5.4.7 test hook — hold the reverser transaction OPEN
        # (still holding every lock acquired so far) until the test
        # explicitly releases it. Production leaves this ``None`` and
        # never pauses.
        hold = type(self)._reversal_hold_after_farm_org_locks_gate
        if hold is not None:
            hold_wait = getattr(hold, "wait", None)
            if hold_wait is not None:
                res = hold_wait()
                if hasattr(res, "__await__"):
                    await res

        # Sprint 5.4.7 — (5c) Farm ⟷ Organization ⟷ Warehouse
        # invariants against the fully locked state. Any deviation
        # returns 409 with a distinct diagnostic — Zero writes.
        for f in locked_farms:
            if f.organization_id != locked_org.id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_farm_organization_mismatch",
                        "message": ("Locked farm belongs to a different organization."),
                        "farm_id": str(f.id),
                        "farm_organization_id": str(f.organization_id),
                        "expected_organization_id": str(locked_org.id),
                    },
                )
        for wh in (original_warehouse, partner_warehouse_locked):
            if wh.farm_id is not None and wh.farm_id not in farm_by_id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_warehouse_farm_mismatch",
                        "message": (
                            "Warehouse references a farm that could not "
                            "be locked; refusing to reverse."
                        ),
                        "warehouse_id": str(wh.id),
                        "warehouse_farm_id": str(wh.farm_id),
                    },
                )

        # (5b) Lock the referenced items. Both sides should reference
        # the same canonical item; still lock both ids defensively in
        # case a caller supplies a tampered row.
        item_ids = sorted({original_locked.item_id, partner_locked.item_id}, key=str)
        locked_items = await self.item_repo.list_by_ids_for_update(item_ids)
        item_by_id = {it.id: it for it in locked_items}
        if original_locked.item_id not in item_by_id or partner_locked.item_id not in item_by_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "A referenced item disappeared under lock.",
                },
            )
        original_item_locked = item_by_id[original_locked.item_id]
        partner_item_locked = item_by_id[partner_locked.item_id]

        # Sprint 5.4.7 — item ⟷ organization invariant against the
        # locked state.
        for it in locked_items:
            if it.organization_id != locked_org.id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    {
                        "code": "transfer_item_organization_mismatch",
                        "message": (
                            "Item belongs to a different organization "
                            "under lock; refusing to reverse."
                        ),
                        "item_id": str(it.id),
                        "item_organization_id": str(it.organization_id),
                        "expected_organization_id": str(locked_org.id),
                    },
                )

        # Sprint 5.4.7 test hook — item locks acquired. Item
        # mutation-race tests wait on this signal before firing.
        item_signal = type(self)._reversal_after_item_locks_signal
        if item_signal is not None:
            it_set = getattr(item_signal, "set", None)
            if it_set is not None:
                it_set()

        # (6) Lock the two lot rows in ascending id order. The
        # reversal write phase re-uses these already-locked rows —
        # no additional lot lock is needed downstream.
        lot_ids = sorted({original_locked.lot_id, partner_locked.lot_id}, key=str)
        locked_lots = await self.lot_repo.list_by_ids_for_update(lot_ids)
        lot_by_id = {lot.id: lot for lot in locked_lots}
        if original_locked.lot_id not in lot_by_id or partner_locked.lot_id not in lot_by_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "A referenced lot disappeared under lock.",
                },
            )
        original_lot_locked = lot_by_id[original_locked.lot_id]
        partner_lot_locked = lot_by_id[partner_locked.lot_id]

        # (7) Full validation against the fully locked context.
        _, item_v = await self._validate_reversal_original(
            original=original_locked, warehouse=original_warehouse
        )
        (
            partner,
            partner_warehouse,
            _partner_lot_probe,
            partner_item,
        ) = await self._validate_paired_transfer(
            original=original_locked, warehouse=original_warehouse, item=item_v
        )
        if partner.id != partner_locked.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "transfer_pair_changed_during_reversal",
                    "message": "Partner row identity changed under lock.",
                },
            )
        # The validation helpers loaded item/lot rows via the
        # standard repos — those calls hit the identity map and
        # returned the LOCKED entities. Assert we validated the same
        # authoritative rows we're about to write against.
        assert item_v.id == original_item_locked.id
        assert partner_item.id == partner_item_locked.id
        assert partner_warehouse.id == partner_warehouse_locked.id

        scopes: list[tuple[uuid.UUID, uuid.UUID | None]] = [
            (original_warehouse.organization_id, original_warehouse.farm_id),
            (partner_warehouse_locked.organization_id, partner_warehouse_locked.farm_id),
        ]
        return {
            "original": original_locked,
            "warehouse": original_warehouse,
            "item": original_item_locked,
            "original_lot": original_lot_locked,
            "partner": partner_locked,
            "partner_warehouse": partner_warehouse_locked,
            "partner_item": partner_item_locked,
            "partner_lot": partner_lot_locked,
            "organization": locked_org,
            "original_farm": farm_by_id.get(original_warehouse.farm_id),
            "partner_farm": farm_by_id.get(partner_warehouse_locked.farm_id),
            "scopes": scopes,
        }

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

        Sprint 5.4.5 — scope resolution now runs through
        :meth:`_acquire_reversal_context`, which acquires row-level
        FOR UPDATE locks on both transfer transaction rows BEFORE
        deriving any scope. The locks persist for the remainder of
        the request transaction, so a concurrent UPDATE cannot
        change the ledger row's ``farm_id`` / ``item_id`` /
        ``reference_id`` between this call and :meth:`reversal`.
        """
        context = await self._acquire_reversal_context(
            warehouse=warehouse,
            reverses_transaction_id=reverses_transaction_id,
        )
        return list(context["scopes"])

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
        # ------------------------------------------------------------ #
        # Race-safe context acquisition (Sprint 5.4.5).
        # ------------------------------------------------------------ #
        # ``_acquire_reversal_context`` locks the transaction row(s)
        # FOR UPDATE, re-fetches authoritative state, and re-runs
        # the full symmetric + farm-consistency validation. If the
        # endpoint already invoked ``resolve_reversal_scopes`` in
        # the same request, the locks it acquired are still held
        # here (same session / same DB transaction), so this call is
        # effectively a validated re-hydration of the shared locked
        # context.
        context = await self._acquire_reversal_context(
            warehouse=warehouse,
            reverses_transaction_id=payload["reverses_transaction_id"],
        )
        # Sprint 5.4.6 — adopt the LOCKED warehouse from the context
        # as authoritative. The endpoint's ``warehouse`` object was
        # only used to identify the URL path; every downstream
        # write and audit row is now anchored to the locked row.
        warehouse = context["warehouse"]
        original = context["original"]
        item = context["item"]
        original_lot = context["original_lot"]
        partner: InventoryTransaction | None = context["partner"]
        partner_warehouse: Warehouse | None = context["partner_warehouse"]
        partner_item: InventoryItem | None = context["partner_item"]
        partner_lot = context["partner_lot"]
        # ``_acquire_reversal_context`` already locked the lot rows
        # in ascending id order via ``list_by_ids_for_update``.
        # Nothing further to lock here — the write phase re-uses
        # the already-locked, revalidated lot rows.

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
