"""Release 6.0.3 — Purchase Order service.

All Purchase Order business rules from ``docs/release_6.0/purchase-orders.md``
live here. Repositories are pure data access; the (future 6.0.3 API)
endpoint layer will be a thin request/response shell. Every mutation
runs inside the caller-provided session transaction — the service
NEVER commits independently.

Phase-1 scope (this module):

* aggregate create with server-generated number, snapshots, exact
  decimals, canonical unit conversion, initial transition + audit;
* draft header/line mutation with optimistic ``version`` precondition;
* full lifecycle state machine (submit / withdraw / approve / reject /
  revise / cancel) with append-only transitions + bounded audit;
* independent-approval invariant (a creator can never approve);
* supplier governance (draft-selection vs submission/approval rules);
* replay detection from the append-only transition history.

Endpoint permission/tenant wiring and Pydantic request schemas are
Release 6.0.3 Phase-2 concerns and are intentionally NOT built here.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException, status

from app.core.currency_codes import is_valid_currency
from app.inventory.units import UnitIncompatibleError, convert
from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapabilityCode,
    BusinessPartnerQualificationStatus,
)
from app.models.farm import Farm
from app.models.inventory import InventoryItem, StockUnit
from app.models.organization import Organization
from app.models.purchase_order import (
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseOrderTransition,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import BusinessPartnerRepository
from app.repositories.purchase_order import (
    PurchaseOrderLineRepository,
    PurchaseOrderRepository,
    PurchaseOrderSequenceRepository,
    PurchaseOrderTransitionRepository,
)

# Max fractional digits for money + quantities (§4.3).
_MAX_DECIMAL_PLACES = 6

# Reason-required lifecycle operations (§5 / §8.2).
_REASON_REQUIRED = frozenset({"withdraw", "reject", "revise", "cancel"})


def _now() -> datetime:
    return datetime.now(UTC)


def _conflict(code: str, message: str, *, context: dict | None = None) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, {"code": code, "message": message, "context": context or {}}
    )


def _unprocessable(code: str, message: str, *, context: dict | None = None) -> HTTPException:
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        {"code": code, "message": message, "context": context or {}},
    )


def _tenant_hidden(entity: str = "Purchase Order") -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {"code": "not_found", "message": f"{entity} not found.", "context": {}},
    )


def _parse_decimal(raw: object, *, field: str) -> Decimal:
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise _unprocessable(
            "invalid_decimal", f"{field} is not a valid decimal.", context={"field": field}
        ) from exc
    if not value.is_finite():
        raise _unprocessable(
            "invalid_decimal", f"{field} must be finite.", context={"field": field}
        )
    exponent = value.as_tuple().exponent
    if isinstance(exponent, int) and exponent < -_MAX_DECIMAL_PLACES:
        raise _unprocessable(
            "invalid_decimal",
            f"{field} must have at most {_MAX_DECIMAL_PLACES} fractional digits.",
            context={"field": field},
        )
    return value


def _resolve_unit(raw: str) -> StockUnit:
    try:
        return StockUnit(raw)
    except ValueError as exc:
        raise _conflict(
            "ordered_unit_mismatch",
            "Ordered unit is not a recognised stock unit for the item.",
            context={"ordered_unit": str(raw)},
        ) from exc


@dataclass
class LifecycleResult:
    """Return payload for a lifecycle operation."""

    purchase_order: PurchaseOrder
    replay: bool = False


class PurchaseOrderService:
    def __init__(
        self,
        *,
        po_repo: PurchaseOrderRepository,
        line_repo: PurchaseOrderLineRepository,
        transition_repo: PurchaseOrderTransitionRepository,
        sequence_repo: PurchaseOrderSequenceRepository,
        partner_repo: BusinessPartnerRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.po_repo = po_repo
        self.line_repo = line_repo
        self.transition_repo = transition_repo
        self.sequence_repo = sequence_repo
        self.partner_repo = partner_repo
        self.audit_repo = audit_repo
        self.session = po_repo.session

    # ================================================================= #
    # Tenancy helpers
    # ================================================================= #
    async def load_for_tenant(
        self, po_id: uuid.UUID, *, expected_org_id: uuid.UUID, for_update: bool = False
    ) -> PurchaseOrder:
        if for_update:
            po = await self.po_repo.get_by_id_for_update(po_id)
            if po is not None:
                await self.session.refresh(po, attribute_names=["lines"])
        else:
            po = await self.po_repo.get_by_id(po_id, with_lines=True)
        if po is None or po.organization_id != expected_org_id:
            raise _tenant_hidden()
        return po

    async def _load_supplier(
        self, organization_id: uuid.UUID, partner_id: uuid.UUID
    ) -> BusinessPartner:
        partner = await self.partner_repo.get_by_id(partner_id, with_relations=True)
        if partner is None or partner.organization_id != organization_id:
            raise _tenant_hidden("Business Partner")
        if partner.deleted_at is not None:
            # Administratively deleted → tenant-hidden (§2).
            raise _tenant_hidden("Business Partner")
        return partner

    async def _load_farm(self, organization_id: uuid.UUID, farm_id: uuid.UUID) -> Farm:
        farm = await self.session.get(Farm, farm_id)
        if farm is None or farm.organization_id != organization_id:
            raise _tenant_hidden("Farm")
        if farm.deleted_at is not None or not farm.is_active:
            raise _tenant_hidden("Farm")
        return farm

    async def _load_item(self, organization_id: uuid.UUID, item_id: uuid.UUID) -> InventoryItem:
        item = await self.session.get(InventoryItem, item_id)
        if item is None or item.organization_id != organization_id:
            raise _tenant_hidden("Inventory Item")
        if item.deleted_at is not None or not item.is_active:
            raise _tenant_hidden("Inventory Item")
        return item

    # ================================================================= #
    # Supplier governance (§2)
    # ================================================================= #
    @staticmethod
    def _has_supplier_capability(partner: BusinessPartner) -> bool:
        return any(
            c.capability == BusinessPartnerCapabilityCode.SUPPLIER for c in partner.capabilities
        )

    def _validate_supplier(self, partner: BusinessPartner, *, for_submission: bool) -> None:
        if not partner.is_active:
            raise _conflict("business_partner_inactive", "The supplier is not active.")
        if not self._has_supplier_capability(partner):
            raise _conflict(
                "business_partner_not_supplier",
                "The partner does not have the supplier capability.",
            )
        if not for_submission:
            return
        profile = partner.supplier_profile
        if profile is None:
            raise _conflict(
                "business_partner_not_approved",
                "The supplier has no approved qualification.",
            )
        if profile.qualification_status == BusinessPartnerQualificationStatus.BLOCKED:
            raise _conflict("business_partner_blocked", "The supplier is blocked.")
        if profile.qualification_status != BusinessPartnerQualificationStatus.APPROVED:
            raise _conflict(
                "business_partner_not_approved",
                "The supplier is not approved for purchasing.",
            )

    # ================================================================= #
    # Line building
    # ================================================================= #
    def _build_line_values(self, *, item: InventoryItem, line_number: int, raw: dict) -> dict:
        ordered_quantity = _parse_decimal(raw["ordered_quantity"], field="ordered_quantity")
        if ordered_quantity <= 0:
            raise _unprocessable("invalid_quantity", "ordered_quantity must be greater than zero.")
        unit_price = _parse_decimal(raw["unit_price"], field="unit_price")
        if unit_price < 0:
            raise _unprocessable("invalid_price", "unit_price must be zero or positive.")

        line_note = raw.get("line_note") or None
        if isinstance(line_note, str):
            line_note = line_note.strip() or None
        if unit_price == 0 and not line_note:
            raise _conflict(
                "purchase_order_line_note_required",
                "A zero unit price requires a non-empty line note.",
                context={"line_number": line_number},
            )

        ordered_unit = _resolve_unit(str(raw["ordered_unit"]))
        canonical_unit = item.canonical_unit
        try:
            qty_canonical = convert(ordered_quantity, ordered_unit, canonical_unit)
        except UnitIncompatibleError as exc:
            raise _conflict(
                "unit_incompatible",
                "Ordered unit is not convertible to the item's canonical unit.",
                context={
                    "ordered_unit": ordered_unit.value,
                    "canonical_unit": canonical_unit.value,
                },
            ) from exc

        description = raw.get("description")
        if isinstance(description, str):
            description = description.strip()
        if not description:
            description = item.name

        return {
            "line_number": line_number,
            "inventory_item_id": item.id,
            "item_code": item.code,
            "item_name": item.name,
            "item_sku": item.sku,
            "description": description,
            "line_note": line_note,
            "ordered_quantity": ordered_quantity,
            "ordered_unit": ordered_unit.value,
            "canonical_unit": canonical_unit.value,
            "ordered_quantity_canonical": qty_canonical,
            "unit_price": unit_price,
        }

    async def _replace_lines(self, po: PurchaseOrder, lines: list[dict]) -> list[uuid.UUID]:
        # Ensure the collection is loaded (awaited) before mutating it so
        # neither ``clear`` nor iteration triggers a sync lazy-load.
        await self.session.refresh(po, attribute_names=["lines"])
        po.lines.clear()
        await self.session.flush()
        created_ids: list[uuid.UUID] = []
        for index, raw in enumerate(lines, start=1):
            item = await self._load_item(
                po.organization_id, uuid.UUID(str(raw["inventory_item_id"]))
            )
            values = self._build_line_values(item=item, line_number=index, raw=raw)
            line = PurchaseOrderLine(purchase_order_id=po.id, **values)
            po.lines.append(line)
            await self.session.flush()
            created_ids.append(line.id)
        return created_ids

    # ================================================================= #
    # Create
    # ================================================================= #
    async def create(
        self,
        *,
        actor: User,
        organization: Organization,
        business_partner_id: uuid.UUID,
        currency_code: str,
        order_date: date,
        expected_delivery_date: date | None = None,
        delivery_address: dict | None = None,
        supplier_reference: str | None = None,
        notes: str | None = None,
        farm_id: uuid.UUID | None = None,
        lines: list[dict] | None = None,
        request_ctx: dict | None = None,
    ) -> PurchaseOrder:
        request_ctx = request_ctx or {}
        currency = (currency_code or "").upper()
        if not is_valid_currency(currency):
            raise _unprocessable(
                "invalid_currency", "currency_code is not an official ISO 4217 code."
            )
        if expected_delivery_date is not None and expected_delivery_date < order_date:
            raise _conflict(
                "purchase_order_invalid_delivery_date",
                "Expected delivery date cannot precede the order date.",
            )

        farm = None
        if farm_id is not None:
            farm = await self._load_farm(organization.id, farm_id)

        partner = await self._load_supplier(organization.id, business_partner_id)
        self._validate_supplier(partner, for_submission=False)

        po_number = await self.sequence_repo.allocate(organization.id, order_date.year)

        po = await self.po_repo.create(
            organization_id=organization.id,
            farm_id=farm.id if farm else None,
            business_partner_id=partner.id,
            po_number=po_number,
            supplier_reference=(supplier_reference or None),
            status=PurchaseOrderStatus.DRAFT,
            currency_code=currency,
            order_date=order_date,
            expected_delivery_date=expected_delivery_date,
            delivery_address=delivery_address,
            notes=(notes or None),
            supplier_code=partner.code,
            supplier_legal_name=partner.legal_name,
            supplier_trading_name=partner.trading_name,
            version=1,
            created_by_id=actor.id,
        )

        line_ids = await self._replace_lines(po, list(lines or []))

        await self._append_transition(
            po,
            actor=actor,
            from_status=None,
            to_status=PurchaseOrderStatus.DRAFT,
            operation="create",
            reason=None,
            request_ctx=request_ctx,
        )
        await self._audit(
            actor=actor,
            action="purchase_order.create",
            po=po,
            request_ctx=request_ctx,
            metadata={
                "po_number": po.po_number,
                "new_status": PurchaseOrderStatus.DRAFT.value,
                "line_count": len(line_ids),
            },
        )
        return po

    # ================================================================= #
    # Draft update — optimistic version precondition (§7.1 / §12.1)
    # ================================================================= #
    async def update_draft(
        self,
        *,
        actor: User,
        po: PurchaseOrder,
        expected_version: int,
        data: dict,
        request_ctx: dict | None = None,
    ) -> PurchaseOrder:
        request_ctx = request_ctx or {}
        if po.status != PurchaseOrderStatus.DRAFT:
            raise _conflict(
                "invalid_purchase_order_transition",
                "Only a draft Purchase Order can be edited.",
                context={"status": po.status.value},
            )
        if po.version != expected_version:
            raise _conflict(
                "purchase_order_version_conflict",
                "The Purchase Order was changed by another request.",
                context={"current_version": po.version},
            )

        changed_fields: list[str] = []

        if "currency_code" in data:
            currency = (data["currency_code"] or "").upper()
            if not is_valid_currency(currency):
                raise _unprocessable(
                    "invalid_currency", "currency_code is not an official ISO 4217 code."
                )
            if currency != po.currency_code:
                po.currency_code = currency
                changed_fields.append("currency_code")

        # Resolve effective dates first so cross-field validation is correct.
        new_order_date = data.get("order_date", po.order_date)
        new_expected = data.get("expected_delivery_date", po.expected_delivery_date)
        if new_expected is not None and new_expected < new_order_date:
            raise _conflict(
                "purchase_order_invalid_delivery_date",
                "Expected delivery date cannot precede the order date.",
            )
        if "order_date" in data and data["order_date"] != po.order_date:
            po.order_date = data["order_date"]
            changed_fields.append("order_date")
        if (
            "expected_delivery_date" in data
            and data["expected_delivery_date"] != po.expected_delivery_date
        ):
            po.expected_delivery_date = data["expected_delivery_date"]
            changed_fields.append("expected_delivery_date")

        if "farm_id" in data:
            new_farm_id = data["farm_id"]
            if new_farm_id is None:
                if po.farm_id is not None:
                    po.farm_id = None
                    changed_fields.append("farm_id")
            else:
                new_farm_id = uuid.UUID(str(new_farm_id))
                if new_farm_id != po.farm_id:
                    await self._load_farm(po.organization_id, new_farm_id)
                    po.farm_id = new_farm_id
                    changed_fields.append("farm_id")

        if "business_partner_id" in data:
            new_partner_id = uuid.UUID(str(data["business_partner_id"]))
            if new_partner_id != po.business_partner_id:
                partner = await self._load_supplier(po.organization_id, new_partner_id)
                self._validate_supplier(partner, for_submission=False)
                po.business_partner_id = partner.id
                po.supplier_code = partner.code
                po.supplier_legal_name = partner.legal_name
                po.supplier_trading_name = partner.trading_name
                changed_fields.append("business_partner_id")

        for simple in ("supplier_reference", "notes"):
            if simple in data:
                new_value = data[simple]
                if isinstance(new_value, str):
                    new_value = new_value.strip() or None
                if new_value != getattr(po, simple):
                    setattr(po, simple, new_value)
                    changed_fields.append(simple)

        if "delivery_address" in data and data["delivery_address"] != po.delivery_address:
            po.delivery_address = data["delivery_address"]
            changed_fields.append("delivery_address")

        line_change_meta: dict = {}
        if "lines" in data:
            before = {ln.id for ln in await self.line_repo.list_for_po(po.id)}
            new_ids = await self._replace_lines(po, list(data["lines"] or []))
            after = set(new_ids)
            added = sorted(after - before)
            removed = sorted(before - after)
            if added or removed:
                changed_fields.append("lines")
                line_change_meta = self._bounded_line_meta(added=added, removed=removed)

        if not changed_fields:
            return po  # semantic no-op — no version bump, no audit (§7.1)

        po.version += 1
        self.session.add(po)
        await self.session.flush()
        await self._audit(
            actor=actor,
            action="purchase_order.update",
            po=po,
            request_ctx=request_ctx,
            metadata={
                "po_number": po.po_number,
                "changed_fields": sorted(changed_fields),
                "new_version": po.version,
                **line_change_meta,
            },
        )
        return po

    @staticmethod
    def _bounded_line_meta(*, added: list[uuid.UUID], removed: list[uuid.UUID]) -> dict:
        truncated = len(added) > 50 or len(removed) > 50
        return {
            "added_line_ids": [str(i) for i in added[:50]],
            "removed_line_ids": [str(i) for i in removed[:50]],
            "added_line_count": len(added),
            "removed_line_count": len(removed),
            "line_ids_truncated": truncated,
        }

    # ================================================================= #
    # Lifecycle transitions (§5)
    # ================================================================= #
    async def submit(
        self, *, actor: User, po: PurchaseOrder, request_ctx: dict | None = None
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        if po.status == PurchaseOrderStatus.SUBMITTED:
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.DRAFT:
            raise self._invalid_transition(po)

        lines = await self.line_repo.list_for_po(po.id)
        if not lines:
            raise _conflict(
                "purchase_order_requires_line",
                "A Purchase Order must have at least one line to submit.",
            )
        # Re-freeze supplier + line snapshots under the current lock (§7.2).
        partner = await self._load_supplier(po.organization_id, po.business_partner_id)
        self._validate_supplier(partner, for_submission=True)
        po.supplier_code = partner.code
        po.supplier_legal_name = partner.legal_name
        po.supplier_trading_name = partner.trading_name
        for line in lines:
            item = await self._load_item(po.organization_id, line.inventory_item_id)
            line.item_code = item.code
            line.item_name = item.name
            line.item_sku = item.sku
            self.session.add(line)

        po.submitted_by_id = actor.id
        po.submitted_at = _now()
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.SUBMITTED,
            operation="submit",
            action="purchase_order.submit",
            request_ctx=request_ctx,
        )

    async def withdraw(
        self, *, actor: User, po: PurchaseOrder, reason: str, request_ctx: dict | None = None
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("withdraw", reason)
        if po.status == PurchaseOrderStatus.DRAFT and await self._last_operation(po) == "withdraw":
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.SUBMITTED:
            raise self._invalid_transition(po)
        po.submitted_by_id = None
        po.submitted_at = None
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.DRAFT,
            operation="withdraw",
            action="purchase_order.withdraw",
            reason=reason,
            request_ctx=request_ctx,
        )

    async def approve(
        self,
        *,
        actor: User,
        po: PurchaseOrder,
        reason: str | None = None,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        # Independent-approval invariant applies to EVERY actor (§5.1),
        # including owners, platform admins, and wildcard permissions.
        if actor.id == po.created_by_id:
            raise _conflict(
                "purchase_order_self_approval_forbidden",
                "A Purchase Order cannot be approved by its creator.",
            )
        if po.status == PurchaseOrderStatus.APPROVED:
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.SUBMITTED:
            raise self._invalid_transition(po)
        # Re-validate supplier eligibility under the lock (§5.1).
        partner = await self._load_supplier(po.organization_id, po.business_partner_id)
        self._validate_supplier(partner, for_submission=True)
        po.approved_by_id = actor.id
        po.approved_at = _now()
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.APPROVED,
            operation="approve",
            action="purchase_order.approve",
            reason=reason,
            request_ctx=request_ctx,
        )

    async def reject(
        self, *, actor: User, po: PurchaseOrder, reason: str, request_ctx: dict | None = None
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("reject", reason)
        if po.status == PurchaseOrderStatus.REJECTED:
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.SUBMITTED:
            raise self._invalid_transition(po)
        po.rejected_by_id = actor.id
        po.rejected_at = _now()
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.REJECTED,
            operation="reject",
            action="purchase_order.reject",
            reason=reason,
            request_ctx=request_ctx,
        )

    async def revise(
        self, *, actor: User, po: PurchaseOrder, reason: str, request_ctx: dict | None = None
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("revise", reason)
        if po.status == PurchaseOrderStatus.DRAFT and await self._last_operation(po) == "revise":
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.REJECTED:
            raise self._invalid_transition(po)
        po.rejected_by_id = None
        po.rejected_at = None
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.DRAFT,
            operation="revise",
            action="purchase_order.revise",
            reason=reason,
            request_ctx=request_ctx,
        )

    async def cancel(
        self, *, actor: User, po: PurchaseOrder, reason: str, request_ctx: dict | None = None
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("cancel", reason)
        if po.status == PurchaseOrderStatus.CANCELLED:
            return LifecycleResult(po, replay=True)
        cancellable = {
            PurchaseOrderStatus.DRAFT,
            PurchaseOrderStatus.SUBMITTED,
            PurchaseOrderStatus.REJECTED,
            PurchaseOrderStatus.APPROVED,
        }
        if po.status not in cancellable:
            raise self._invalid_transition(po)
        if po.status == PurchaseOrderStatus.APPROVED:
            # An approved PO cannot be cancelled once any receipt exists.
            # 6.0.3 cannot create that condition, but the guard preserves
            # the aggregate invariant for 6.0.4.
            for line in await self.line_repo.list_for_po(po.id):
                if Decimal(str(line.received_quantity)) != 0:
                    raise self._invalid_transition(po)
        po.cancelled_by_id = actor.id
        po.cancelled_at = _now()
        return await self._transition(
            po,
            actor=actor,
            to_status=PurchaseOrderStatus.CANCELLED,
            operation="cancel",
            action="purchase_order.cancel",
            reason=reason,
            request_ctx=request_ctx,
        )

    # ================================================================= #
    # Derived totals (§4.3) — never a stored column.
    # ================================================================= #
    @staticmethod
    def subtotal(po: PurchaseOrder) -> Decimal:
        total = Decimal(0)
        for line in po.lines:
            total += Decimal(str(line.ordered_quantity)) * Decimal(str(line.unit_price))
        return total

    # ================================================================= #
    # Internal transition + audit machinery
    # ================================================================= #
    def _invalid_transition(self, po: PurchaseOrder) -> HTTPException:
        return _conflict(
            "invalid_purchase_order_transition",
            "The requested operation is not allowed from the current status.",
            context={"status": po.status.value},
        )

    @staticmethod
    def _require_reason(operation: str, reason: str | None) -> None:
        if operation in _REASON_REQUIRED and not (reason or "").strip():
            raise _unprocessable(
                "reason_required", f"A reason is required to {operation} a Purchase Order."
            )

    async def _last_operation(self, po: PurchaseOrder) -> str | None:
        last = await self.transition_repo.last_for_po(po.id)
        if last is None or not last.metadata_json:
            return None
        return last.metadata_json.get("operation")

    async def _append_transition(
        self,
        po: PurchaseOrder,
        *,
        actor: User,
        from_status: PurchaseOrderStatus | None,
        to_status: PurchaseOrderStatus,
        operation: str,
        reason: str | None,
        request_ctx: dict,
    ) -> PurchaseOrderTransition:
        return await self.transition_repo.add(
            purchase_order_id=po.id,
            actor_id=actor.id,
            from_status=from_status,
            to_status=to_status,
            occurred_at=_now(),
            reason=(reason.strip()[:500] if isinstance(reason, str) and reason.strip() else None),
            metadata_json={"operation": operation},
            request_id=request_ctx.get("request_id"),
        )

    async def _transition(
        self,
        po: PurchaseOrder,
        *,
        actor: User,
        to_status: PurchaseOrderStatus,
        operation: str,
        action: str,
        reason: str | None = None,
        request_ctx: dict,
    ) -> LifecycleResult:
        from_status = po.status
        old_version = po.version
        po.status = to_status
        po.version += 1
        self.session.add(po)
        await self.session.flush()

        transition = await self._append_transition(
            po,
            actor=actor,
            from_status=from_status,
            to_status=to_status,
            operation=operation,
            reason=reason,
            request_ctx=request_ctx,
        )
        # Named domain event + generic transition event (§8).
        bounded_reason = (
            reason.strip()[:500] if isinstance(reason, str) and reason.strip() else None
        )
        await self._audit(
            actor=actor,
            action=action,
            po=po,
            request_ctx=request_ctx,
            metadata={
                "po_number": po.po_number,
                "old_status": from_status.value,
                "new_status": to_status.value,
                "old_version": old_version,
                "new_version": po.version,
                **({"reason": bounded_reason} if bounded_reason else {}),
            },
        )
        await self._audit(
            actor=actor,
            action="purchase_order.transition",
            po=po,
            request_ctx=request_ctx,
            metadata={
                "po_number": po.po_number,
                "old_status": from_status.value,
                "new_status": to_status.value,
                "transition_id": str(transition.id),
            },
        )
        return LifecycleResult(po, replay=False)

    async def _audit(
        self,
        *,
        actor: User,
        action: str,
        po: PurchaseOrder,
        request_ctx: dict,
        metadata: dict,
    ) -> None:
        await self.audit_repo.record(
            actor_id=actor.id,
            organization_id=po.organization_id,
            farm_id=po.farm_id,
            action=action,
            entity_type="purchase_order",
            entity_id=str(po.id),
            ip_address=request_ctx.get("ip_address"),
            user_agent=request_ctx.get("user_agent"),
            request_id=request_ctx.get("request_id"),
            metadata=metadata,
        )


__all__ = ["LifecycleResult", "PurchaseOrderService"]
