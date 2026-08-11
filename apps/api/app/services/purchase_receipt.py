"""Locked, atomic Purchase Receipt posting orchestration."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import ClassVar

from fastapi import HTTPException, status
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.farm import Farm
from app.models.inventory import (
    InventoryItem,
    InventoryLot,
    StockUnit,
    StorageLocation,
    Warehouse,
    WarehouseStatus,
)
from app.models.organization import Organization
from app.models.purchase_order import (
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseOrderTransition,
)
from app.models.purchase_receipt import PurchaseReceipt, PurchaseReceiptLine
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.inventory import (
    InventoryItemRepository,
    InventoryLotRepository,
    InventoryTransactionRepository,
    StorageLocationRepository,
    WarehouseRepository,
)
from app.repositories.purchase_order import PurchaseOrderRepository
from app.repositories.purchase_receipt import (
    PurchaseReceiptRepository,
    PurchaseReceiptSequenceRepository,
)
from app.schemas.purchase_receipt import PurchaseReceiptCommand
from app.security.authorize import resolve_permission_scopes
from app.services._authorization_lock import acquire_org_authorization_lock
from app.services.inventory import InventoryService

_QUANTUM = Decimal("0.000001")


def _error(http_status: int, code: str, message: str, **context: object) -> HTTPException:
    return HTTPException(http_status, {"code": code, "message": message, "context": context})


def _exact_canonical(value: Decimal) -> Decimal:
    """Return a six-place canonical value without changing its business value."""
    quantized = value.quantize(_QUANTUM)
    if quantized != value or quantized <= 0:
        raise _error(
            status.HTTP_409_CONFLICT,
            "canonical_quantity_not_representable",
            "The receipt quantity cannot be represented exactly in the canonical unit.",
        )
    return quantized


def canonical_receipt_payload_hash(
    organization_id: uuid.UUID,
    purchase_order_id: uuid.UUID,
    command: PurchaseReceiptCommand,
) -> str:
    """Hash frozen request facts in stable client-line order."""
    payload = {
        "organization_id": str(organization_id),
        "purchase_order_id": str(purchase_order_id),
        "warehouse_id": str(command.warehouse_id),
        "supplier_delivery_reference": command.supplier_delivery_reference,
        "received_at": (
            command.received_at.astimezone(UTC).isoformat() if command.received_at else None
        ),
        "notes": command.notes,
        "lines": [
            {
                "purchase_order_line_id": str(line.purchase_order_line_id),
                "lot_code": line.lot_code.strip(),
                "quantity": format(line.quantity.quantize(_QUANTUM), "f"),
                "storage_location_id": (
                    str(line.storage_location_id) if line.storage_location_id else None
                ),
                "expiry_date": line.expiry_date.isoformat() if line.expiry_date else None,
            }
            for line in command.lines
        ],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


class PurchaseReceiptService:
    """Owns the complete receipt, stock, PO, transition, and audit transaction."""

    _before_authorization_lock_signal: ClassVar[object | None] = None
    _after_authorization_lock_signal: ClassVar[object | None] = None
    _hold_after_authorization_lock_gate: ClassVar[object | None] = None

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.receipt_repo = PurchaseReceiptRepository(session)
        self.sequence_repo = PurchaseReceiptSequenceRepository(session)
        self.po_repo = PurchaseOrderRepository(session)
        self.warehouse_repo = WarehouseRepository(session)
        self.item_repo = InventoryItemRepository(session)
        self.location_repo = StorageLocationRepository(session)
        self.lot_repo = InventoryLotRepository(session)
        self.tx_repo = InventoryTransactionRepository(session)
        self.audit_repo = AuditRepository(session)
        self.inventory = InventoryService(
            session,
            warehouse_repo=self.warehouse_repo,
            item_repo=self.item_repo,
            lot_repo=self.lot_repo,
            tx_repo=self.tx_repo,
            location_repo=self.location_repo,
            audit_repo=self.audit_repo,
        )

    async def _authorize(
        self, actor: User, *, organization_id: uuid.UUID, farm_id: uuid.UUID | None
    ) -> bool:
        """Authorize the locked PO scope; return whether the grant is org-wide."""
        required = "purchase_receipt.create"
        if not actor.is_active:
            raise _error(
                status.HTTP_403_FORBIDDEN, "not_authorized", "Not authorized.", required=required
            )
        scopes = await resolve_permission_scopes(self.session, actor)
        visible_scope = False
        for scope in scopes:
            if (
                (scope.organization_id is None and scope.farm_id is None)
                or (scope.organization_id == organization_id and scope.farm_id is None)
                or (farm_id is not None and scope.farm_id == farm_id)
            ):
                visible_scope = True
            if required not in scope.permissions and "*" not in scope.permissions:
                continue
            if scope.organization_id is None and scope.farm_id is None:
                return True
            if scope.organization_id == organization_id and scope.farm_id is None:
                return True
            if farm_id is not None and scope.farm_id == farm_id:
                return False
        if not visible_scope:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")
        raise _error(
            status.HTTP_403_FORBIDDEN, "not_authorized", "Not authorized.", required=required
        )

    async def _lock_context(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        purchase_order_id: uuid.UUID,
        warehouse_id: uuid.UUID,
        po_line_ids: set[uuid.UUID],
        location_ids: set[uuid.UUID],
    ) -> tuple[
        Warehouse,
        Organization,
        PurchaseOrder,
        list[PurchaseOrderLine],
        dict[uuid.UUID, InventoryItem],
        bool,
    ]:
        """Acquire the frozen deterministic lock order without making auth decisions."""
        before_signal = type(self)._before_authorization_lock_signal
        if before_signal is not None:
            before_signal.set()
        await acquire_org_authorization_lock(self.session, organization_id)
        signal = type(self)._after_authorization_lock_signal
        if signal is not None:
            signal.set()
        hold = type(self)._hold_after_authorization_lock_gate
        if hold is not None:
            await hold.wait()

        organization = (
            await self.session.execute(
                select(Organization)
                .where(Organization.id == organization_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if organization is None:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")

        po = (
            await self.session.execute(
                select(PurchaseOrder)
                .where(
                    PurchaseOrder.id == purchase_order_id,
                    PurchaseOrder.organization_id == organization_id,
                )
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if po is None:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")
        if po.farm_id is not None:
            locked_farm = (
                await self.session.execute(
                    select(Farm)
                    .where(Farm.id == po.farm_id, Farm.organization_id == organization_id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).scalar_one_or_none()
            if locked_farm is None:
                raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")
        org_wide = await self._authorize(actor, organization_id=organization_id, farm_id=po.farm_id)

        warehouse_predicates = [
            Warehouse.id == warehouse_id,
            Warehouse.organization_id == organization_id,
        ]
        if not org_wide:
            warehouse_predicates.append(
                (Warehouse.farm_id.is_(None)) | (Warehouse.farm_id == po.farm_id)
            )
        warehouse = (
            await self.session.execute(
                select(Warehouse)
                .where(*warehouse_predicates)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if warehouse is None or warehouse.deleted_at is not None:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Warehouse not found.")

        all_po_line_ids = set(
            (
                await self.session.execute(
                    select(PurchaseOrderLine.id).where(
                        PurchaseOrderLine.purchase_order_id == purchase_order_id
                    )
                )
            ).scalars()
        )
        po_lines = await self.receipt_repo.lock_po_lines(all_po_line_ids)
        requested_lines = [line for line in po_lines if line.id in po_line_ids]
        item_ids = sorted({line.inventory_item_id for line in requested_lines}, key=str)
        items = list(
            (
                await self.session.execute(
                    select(InventoryItem)
                    .where(
                        InventoryItem.id.in_(item_ids),
                        InventoryItem.organization_id == organization_id,
                    )
                    .order_by(InventoryItem.id.asc())
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).scalars()
        )
        item_by_id = {item.id: item for item in items}
        if location_ids:
            await self.session.execute(
                select(StorageLocation)
                .where(
                    StorageLocation.id.in_(sorted(location_ids, key=str)),
                    StorageLocation.warehouse_id == warehouse.id,
                )
                .order_by(StorageLocation.id.asc())
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        return warehouse, organization, po, po_lines, item_by_id, org_wide

    async def post(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        purchase_order_id: uuid.UUID,
        command: PurchaseReceiptCommand,
        idempotency_key: str,
        request_ctx: dict,
    ) -> tuple[PurchaseReceipt, bool]:
        key = idempotency_key.strip()
        if not key or len(key) > 255:
            raise _error(
                status.HTTP_400_BAD_REQUEST,
                "idempotency_key_required",
                "A valid Idempotency-Key is required.",
            )
        payload_hash = canonical_receipt_payload_hash(organization_id, purchase_order_id, command)
        line_ids = {line.purchase_order_line_id for line in command.lines}
        location_ids = {
            line.storage_location_id for line in command.lines if line.storage_location_id
        }

        warehouse, organization, po, locked_lines, item_by_id, _org_wide = await self._lock_context(
            actor=actor,
            organization_id=organization_id,
            purchase_order_id=purchase_order_id,
            warehouse_id=command.warehouse_id,
            po_line_ids=line_ids,
            location_ids=location_ids,
        )
        if po.organization_id != organization_id or warehouse.organization_id != organization_id:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")
        if warehouse.deleted_at is not None:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Warehouse not found.")
        existing = await self.receipt_repo.get_by_org_and_key(organization_id, key)
        if existing is not None:
            if existing.payload_hash != payload_hash:
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "idempotency_key_payload_conflict",
                    "This Idempotency-Key was used with a different payload.",
                )
            return existing, True

        if organization.deleted_at is not None or not organization.is_active:
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order not found.")
        governed_farm_ids = {
            farm_id for farm_id in (po.farm_id, warehouse.farm_id) if farm_id is not None
        }
        if governed_farm_ids:
            governed_farms = list(
                (
                    await self.session.execute(
                        select(Farm)
                        .where(Farm.id.in_(sorted(governed_farm_ids, key=str)))
                        .execution_options(populate_existing=True)
                    )
                ).scalars()
            )
            if len(governed_farms) != len(governed_farm_ids) or any(
                farm.organization_id != organization_id
                or farm.deleted_at is not None
                or not farm.is_active
                for farm in governed_farms
            ):
                raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Warehouse not found.")
        if warehouse.status == WarehouseStatus.CLOSED:
            raise _error(
                status.HTTP_409_CONFLICT, "warehouse_unavailable", "Warehouse is unavailable."
            )
        if warehouse.farm_id is not None and warehouse.farm_id != po.farm_id:
            raise _error(
                status.HTTP_409_CONFLICT,
                "warehouse_farm_scope_mismatch",
                "Warehouse does not match the Purchase Order farm.",
            )
        if po.status not in (PurchaseOrderStatus.APPROVED, PurchaseOrderStatus.PARTIALLY_RECEIVED):
            raise _error(
                status.HTTP_409_CONFLICT,
                "purchase_order_not_receivable",
                "Purchase Order is not receivable.",
            )
        if not line_ids.issubset({line.id for line in locked_lines}):
            raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order line not found.")

        po_line_by_id = {line.id: line for line in locked_lines}
        additions: dict[uuid.UUID, tuple[Decimal, Decimal]] = {}
        prepared: list[tuple[object, PurchaseOrderLine, InventoryItem, Decimal]] = []
        for command_line in command.lines:
            po_line = po_line_by_id[command_line.purchase_order_line_id]
            if po_line.purchase_order_id != po.id:
                raise _error(
                    status.HTTP_404_NOT_FOUND, "not_found", "Purchase Order line not found."
                )
            item = item_by_id.get(po_line.inventory_item_id)
            if (
                item is None
                or item.organization_id != organization_id
                or item.deleted_at is not None
                or not item.is_active
            ):
                raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Inventory item not found.")
            try:
                ordered_unit = StockUnit(po_line.ordered_unit)
                if item.canonical_unit.value != po_line.canonical_unit:
                    raise ValueError
                canonical = self.inventory._to_canonical(
                    item=item, qty=command_line.quantity, unit=ordered_unit
                )
                canonical = _exact_canonical(canonical)
            except (ValueError, InvalidOperation):
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "ordered_unit_mismatch",
                    "Frozen Purchase Order units do not match the inventory item.",
                ) from None
            quantity = command_line.quantity.quantize(_QUANTUM)
            prior_qty, prior_canonical = additions.get(po_line.id, (Decimal(0), Decimal(0)))
            additions[po_line.id] = (prior_qty + quantity, prior_canonical + canonical)
            prepared.append((command_line, po_line, item, canonical))

        for po_line_id, (quantity, canonical) in additions.items():
            po_line = po_line_by_id[po_line_id]
            if Decimal(po_line.received_quantity) + quantity > Decimal(
                po_line.ordered_quantity
            ) or Decimal(po_line.received_quantity_canonical) + canonical > Decimal(
                po_line.ordered_quantity_canonical
            ):
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "purchase_order_over_receipt",
                    "Receipt exceeds the remaining Purchase Order quantity.",
                    purchase_order_line_id=str(po_line_id),
                )

        # Lock every existing lot in stable topology order before any missing-lot
        # insert. Missing rows are then created through the inventory savepoint
        # race handler, preserving the canonical global lock order.
        lot_by_key: dict[tuple[uuid.UUID, str], InventoryLot] = {}
        sorted_prepared = sorted(
            prepared,
            key=lambda row: (
                str(row[2].id),
                row[0].lot_code.strip(),
                str(row[0].storage_location_id or ""),
            ),
        )
        requested_lot_keys = sorted(
            {(row[2].id, row[0].lot_code.strip()) for row in sorted_prepared},
            key=lambda value: (str(value[0]), value[1]),
        )
        if requested_lot_keys:
            existing_lots = list(
                (
                    await self.session.execute(
                        select(InventoryLot)
                        .where(
                            InventoryLot.warehouse_id == warehouse.id,
                            tuple_(InventoryLot.item_id, InventoryLot.lot_code).in_(
                                requested_lot_keys
                            ),
                        )
                        .order_by(InventoryLot.id.asc())
                        .with_for_update()
                        .execution_options(populate_existing=True)
                    )
                ).scalars()
            )
            lot_by_key.update({(lot.item_id, lot.lot_code): lot for lot in existing_lots})

        for command_line, po_line, item, _ in sorted_prepared:
            if command_line.storage_location_id is not None:
                location = await self.location_repo.get_by_id(command_line.storage_location_id)
                if location is None or location.warehouse_id != warehouse.id:
                    raise _error(
                        status.HTTP_404_NOT_FOUND,
                        "not_found",
                        "Storage location not found.",
                    )
            lot_code = command_line.lot_code.strip()
            key_tuple = (item.id, lot_code)
            lot = lot_by_key.get(key_tuple)
            if lot is not None and lot.deleted_at is not None:
                raise _error(status.HTTP_404_NOT_FOUND, "not_found", "Inventory lot not found.")
            if lot is None:
                lot = await self.inventory._get_or_create_lot_safe(
                    warehouse=warehouse,
                    item=item,
                    lot_code=lot_code,
                    storage_location_id=command_line.storage_location_id,
                    expiry_date=command_line.expiry_date,
                    received_at=command.received_at,
                    unit_cost_amount=po_line.unit_price,
                    unit_cost_currency=po.currency_code,
                )
                lot = await self.lot_repo.get_by_id_for_update(lot.id)
                if lot is None:  # defensive: inserted/reloaded row must exist
                    raise _error(
                        status.HTTP_409_CONFLICT,
                        "lot_creation_conflict",
                        "Receipt lot could not be locked.",
                    )
                lot_by_key[key_tuple] = lot
            if (
                lot.storage_location_id != command_line.storage_location_id
                or lot.expiry_date != command_line.expiry_date
            ):
                raise _error(
                    status.HTTP_409_CONFLICT,
                    "lot_attribute_conflict",
                    "Existing lot attributes conflict with this receipt.",
                )
        locked_lot_by_id = {lot.id: lot for lot in lot_by_key.values()}

        received_at = command.received_at or datetime.now(UTC)
        grn = await self.sequence_repo.allocate(organization_id, received_at.year)
        receipt = PurchaseReceipt(
            id=uuid.uuid4(),
            organization_id=organization_id,
            farm_id=po.farm_id,
            purchase_order_id=po.id,
            warehouse_id=warehouse.id,
            grn=grn,
            supplier_delivery_reference=command.supplier_delivery_reference,
            received_at=received_at,
            received_by_id=actor.id,
            notes=command.notes,
            idempotency_key=key,
            payload_hash=payload_hash,
        )
        transaction_ids: list[str] = []
        for line_number, (command_line, po_line, item, canonical) in enumerate(prepared, 1):
            line_id = uuid.uuid4()
            lot = locked_lot_by_id[lot_by_key[(item.id, command_line.lot_code.strip())].id]
            transaction = await self.inventory.post_receipt_under_locks(
                actor=actor,
                warehouse=warehouse,
                item=item,
                lot=lot,
                quantity_canonical=canonical,
                reference_id=line_id,
                reason=f"Purchase receipt {grn}",
                request_ctx=request_ctx,
                metadata_json={"purchase_order_id": str(po.id), "grn": grn},
            )
            receipt_line = PurchaseReceiptLine(
                id=line_id,
                purchase_receipt_id=receipt.id,
                line_number=line_number,
                purchase_order_line_id=po_line.id,
                inventory_item_id=item.id,
                warehouse_id=warehouse.id,
                storage_location_id=command_line.storage_location_id,
                inventory_lot_id=lot.id,
                inventory_transaction_id=transaction.id,
                lot_code=command_line.lot_code.strip(),
                expiry_date=command_line.expiry_date,
                quantity=command_line.quantity.quantize(_QUANTUM),
                ordered_unit=po_line.ordered_unit,
                quantity_canonical=canonical,
                canonical_unit=po_line.canonical_unit,
                unit_price=po_line.unit_price,
                currency_code=po.currency_code,
            )
            self.session.add(receipt_line)
            transaction_ids.append(str(transaction.id))

        # Materialize every child while the immutable header is deliberately
        # absent. The receipt FK is deferred until transaction end; once the
        # header is inserted below, the database append trigger closes the
        # aggregate permanently.
        await self.session.flush()

        for po_line_id, (quantity, canonical) in additions.items():
            po_line = po_line_by_id[po_line_id]
            po_line.received_quantity = Decimal(po_line.received_quantity) + quantity
            po_line.received_quantity_canonical = (
                Decimal(po_line.received_quantity_canonical) + canonical
            )

        complete = all(
            Decimal(line.received_quantity) == Decimal(line.ordered_quantity)
            and Decimal(line.received_quantity_canonical)
            == Decimal(line.ordered_quantity_canonical)
            for line in po_line_by_id.values()
            if line.purchase_order_id == po.id
        )
        from_status = po.status
        po.status = (
            PurchaseOrderStatus.RECEIVED if complete else PurchaseOrderStatus.PARTIALLY_RECEIVED
        )
        po.version += 1
        transition = PurchaseOrderTransition(
            purchase_order_id=po.id,
            actor_id=actor.id,
            from_status=from_status,
            to_status=po.status,
            occurred_at=datetime.now(UTC),
            reason=None,
            metadata_json={"purchase_receipt_id": str(receipt.id), "grn": grn},
            request_id=request_ctx.get("request_id"),
        )
        self.session.add(transition)
        # The header is inserted last.  The deferred line FK permits aggregate
        # construction while the PostgreSQL INSERT trigger rejects appending a
        # line once this immutable posted header exists.
        self.session.add(receipt)
        await self.session.flush()
        await self.audit_repo.record(
            actor_id=actor.id,
            action="purchase_receipt.post",
            entity_type="purchase_receipt",
            entity_id=str(receipt.id),
            organization_id=organization_id,
            farm_id=po.farm_id,
            metadata={
                "grn": grn,
                "purchase_order_id": str(po.id),
                "inventory_transaction_ids": transaction_ids,
            },
            **request_ctx,
        )
        await self.session.refresh(receipt, attribute_names=["lines"])
        return receipt, False


__all__ = ["PurchaseReceiptService", "canonical_receipt_payload_hash"]
