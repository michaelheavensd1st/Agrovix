"""Release 6.0.3 — Purchase Order service (Sprint 1.1 hardened).

All Purchase Order business rules from ``docs/release_6.0/purchase-orders.md``
live here. Repositories are pure data access; a future endpoint layer
is a thin request/response shell. Every mutation runs inside the
caller-provided session transaction — the service NEVER commits.

Sprint 1.1 remediation (Milestone-1 review):

1. **Transactional governance locking.** Lifecycle methods OWN their
   locking: they take an id, lock the aggregate root ``FOR UPDATE``,
   then lock every governed dependency (supplier, qualification, capabilities, farm,
   inventory items) in a single deterministic global order before any
   validation. No caller-supplied objects, no check-then-act windows.
2. **In-transaction authorization revalidation.** After all locks are
   held, authorization is re-resolved from canonical active scopes
   (active org/farm membership, active role assignment, active
   org/farm) via :func:`resolve_permission_scopes` — never trusting a
   pre-request decision.
3. **Submission rebuild.** ``submit`` rebuilds and re-validates the
   whole document from locked authoritative data, then freezes
   snapshots only on success.
4. **Stable line identity.** Draft edits preserve line UUIDs across
   add / update / reorder / remove; no delete-and-recreate churn.
6. **Exact 6-dp decimals** end-to-end — no float business arithmetic.
8. **Cancellation guards** check BOTH received accumulators.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Context, Decimal, InvalidOperation, localcontext

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError as SAIntegrityError
from sqlalchemy.orm import noload

from app.core.country_codes import ISO_3166_1_ALPHA_2
from app.core.currency_codes import is_valid_currency
from app.inventory.units import UnitIncompatibleError, convert
from app.models.business_partner import (
    BusinessPartner,
    BusinessPartnerCapabilityCode,
    BusinessPartnerQualificationStatus,
)
from app.models.farm import Farm
from app.models.inventory import InventoryItem, StockUnit
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.purchase_order import (
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseOrderTransition,
)
from app.models.role import Permission, Role, role_permissions_table
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import BusinessPartnerRepository
from app.repositories.purchase_order import (
    PurchaseOrderLineRepository,
    PurchaseOrderRepository,
    PurchaseOrderSequenceRepository,
    PurchaseOrderTransitionRepository,
)
from app.security.authorize import resolve_permission_scopes

_MAX_DECIMAL_PLACES = 6
_QUANTUM = Decimal(1).scaleb(-_MAX_DECIMAL_PLACES)  # Decimal('0.000001')
# NUMERIC(18,6) → 12 integer digits; NUMERIC(20,6) → 14 integer digits.
_MAX_QTY = Decimal(10) ** 12
_MAX_PRICE = Decimal(10) ** 14
_ARITHMETIC_CONTEXT = Context(prec=64, rounding=ROUND_HALF_UP)

_REASON_REQUIRED = frozenset({"withdraw", "reject", "revise", "cancel"})

# Operation → required permission code (§6). Withdraw is the inverse of
# submit; revise re-opens a draft for editing.
_OPERATION_PERMISSION: dict[str, str] = {
    "create": "purchase_order.create",
    "update": "purchase_order.update",
    "submit": "purchase_order.submit",
    "withdraw": "purchase_order.submit",
    "approve": "purchase_order.approve",
    "reject": "purchase_order.reject",
    "revise": "purchase_order.update",
    "cancel": "purchase_order.cancel",
}

# Bounded header/line string limits (match the DB column widths so we
# fail with a stable domain error rather than a raw DB truncation/500).
_MAX_SUPPLIER_REFERENCE = 120
_MAX_NOTES = 4000
_MAX_DESCRIPTION = 500
_MAX_LINE_NOTE = 1000
_ADDRESS_ALLOWED_KEYS = frozenset(
    {"line1", "line2", "city", "region", "postal_code", "country_code"}
)
_MAX_ADDRESS_VALUE = 200


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


def _forbidden(required: str) -> HTTPException:
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        {"code": "not_authorized", "message": "Not authorized.", "context": {"required": required}},
    )


def _tenant_hidden(entity: str = "Purchase Order") -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {"code": "not_found", "message": f"{entity} not found.", "context": {}},
    )


def _parse_decimal(raw: object, *, field: str, maximum: Decimal) -> Decimal:
    if isinstance(raw, float):
        raise _unprocessable(
            "invalid_decimal",
            f"{field} must be supplied without binary floating-point conversion.",
            context={"field": field},
        )
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
    # Exact quantization to 6 dp (value already has ≤6 dp, so lossless).
    value = value.quantize(_QUANTUM)
    if abs(value) >= maximum:
        raise _unprocessable(
            "value_out_of_range",
            f"{field} is out of the representable range.",
            context={"field": field},
        )
    return value


def _quantize_canonical(value: Decimal, *, field: str) -> Decimal:
    """Quantize a converted canonical quantity to exactly 6 dp, refusing
    any value that is not representable without loss."""
    quantized = value.quantize(_QUANTUM)
    if quantized != value:
        raise _conflict(
            "canonical_quantity_not_representable",
            "The canonical quantity cannot be represented at six-decimal precision.",
            context={"field": field},
        )
    if abs(quantized) >= _MAX_QTY:
        raise _unprocessable(
            "value_out_of_range",
            f"{field} is out of the representable range.",
            context={"field": field},
        )
    return quantized


def _quantize_result(value: Decimal, *, field: str) -> Decimal:
    """Return a deterministic six-decimal business result.

    Field values are bounded before persistence. Derived results use a
    deliberately wider context so multiplying two legal NUMERIC values cannot
    inherit the process-wide Decimal precision or leak InvalidOperation.
    """
    try:
        with localcontext(_ARITHMETIC_CONTEXT):
            return value.quantize(_QUANTUM, rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:
        raise _unprocessable(
            "value_out_of_range",
            f"{field} is out of the representable range.",
            context={"field": field},
        ) from exc


def _bounded(raw: object, *, field: str, maximum: int) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if len(text) > maximum:
        raise _unprocessable(
            "value_too_long",
            f"{field} exceeds the maximum length of {maximum}.",
            context={"field": field, "max_length": maximum},
        )
    return text


def _validate_delivery_address(raw: object) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _unprocessable("invalid_delivery_address", "delivery_address must be an object.")
    unexpected = set(raw) - _ADDRESS_ALLOWED_KEYS
    if unexpected:
        raise _unprocessable(
            "invalid_delivery_address",
            "delivery_address contains unsupported keys.",
            context={"unexpected_keys": sorted(unexpected)},
        )
    cleaned: dict[str, str] = {}
    for key in sorted(raw):
        value = raw[key]
        if value is None:
            continue
        if not isinstance(value, str):
            raise _unprocessable(
                "invalid_delivery_address",
                f"delivery_address.{key} must be a string.",
                context={"field": key},
            )
        value = value.strip()
        if not value:
            continue
        if len(value) > _MAX_ADDRESS_VALUE:
            raise _unprocessable(
                "invalid_delivery_address",
                f"delivery_address.{key} is too long.",
                context={"field": key, "max_length": _MAX_ADDRESS_VALUE},
            )
        if key == "country_code":
            code = value.upper()
            if code not in ISO_3166_1_ALPHA_2:
                raise _unprocessable(
                    "invalid_country_code",
                    "delivery_address.country_code is not a valid ISO 3166-1 alpha-2 code.",
                    context={"country_code": value},
                )
            value = code
        cleaned[key] = value
    return cleaned or None


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
    # Locking + authorization (Sprint 1.1 objectives 1 & 2)
    # ================================================================= #
    async def _lock_po(self, po_id: uuid.UUID, organization_id: uuid.UUID) -> PurchaseOrder:
        po = await self.po_repo.get_by_id_for_update(po_id)
        if po is None or po.organization_id != organization_id:
            raise _tenant_hidden()
        await self.session.refresh(po, attribute_names=["lines"])
        return po

    async def _lock_authorization_anchor(self, actor: User, organization_id: uuid.UUID) -> None:
        """Acquire the global mutation anchor before any aggregate row lock."""
        await self.po_repo._lock_pks(User, [actor.id])
        await self.po_repo._lock_pks(Organization, [organization_id])

    async def _lock_po_for_mutation(
        self, po_id: uuid.UUID, organization_id: uuid.UUID, actor: User
    ) -> PurchaseOrder:
        await self._lock_authorization_anchor(actor, organization_id)
        return await self._lock_po(po_id, organization_id)

    async def _lock_authorization_dependencies(
        self,
        actor: User,
        *,
        organization_id: uuid.UUID,
        farm_ids: set[uuid.UUID],
    ) -> None:
        """Lock the exact mutable rows from which PO authorization is derived.

        The order is global: actor → organization → organization membership →
        role assignments → roles → role/permission grants → farm memberships.
        Farm aggregate rows are locked later in the governance dependency phase.
        """
        await self._lock_authorization_anchor(actor, organization_id)
        await self.session.execute(
            select(OrganizationMembership.id)
            .where(
                OrganizationMembership.user_id == actor.id,
                OrganizationMembership.organization_id == organization_id,
            )
            .order_by(OrganizationMembership.id.asc())
            .with_for_update()
        )
        assignments = list(
            (
                await self.session.execute(
                    select(RoleAssignment)
                    .where(
                        RoleAssignment.user_id == actor.id,
                        (RoleAssignment.organization_id == organization_id)
                        | (RoleAssignment.organization_id.is_(None)),
                    )
                    .order_by(RoleAssignment.id.asc())
                    .options(noload(RoleAssignment.role))
                    .with_for_update()
                )
            )
            .scalars()
            .all()
        )
        role_ids = {assignment.role_id for assignment in assignments}
        await self.po_repo._lock_pks(Role, role_ids)
        permission_ids: set[uuid.UUID] = set()
        if role_ids:
            permission_ids = set(
                (
                    await self.session.execute(
                        select(role_permissions_table.c.permission_id)
                        .where(role_permissions_table.c.role_id.in_(sorted(role_ids, key=str)))
                        .order_by(
                            role_permissions_table.c.role_id.asc(),
                            role_permissions_table.c.permission_id.asc(),
                        )
                        .with_for_update()
                    )
                ).scalars()
            )
        await self.po_repo._lock_pks(Permission, permission_ids)
        if farm_ids:
            await self.session.execute(
                select(FarmMembership.id)
                .where(
                    FarmMembership.user_id == actor.id,
                    FarmMembership.farm_id.in_(sorted(farm_ids, key=str)),
                )
                .order_by(FarmMembership.id.asc())
                .with_for_update()
            )
        await self.session.refresh(actor)

    async def _lock_dependencies(
        self,
        po: PurchaseOrder,
        *,
        business_partner_ids: set[uuid.UUID] | None = None,
        farm_ids: set[uuid.UUID] | None = None,
        inventory_item_ids: set[uuid.UUID] | None = None,
    ) -> None:
        """Acquire one complete, sorted union of current and requested dependencies."""
        partner_ids = {po.business_partner_id, *(business_partner_ids or set())}
        all_farm_ids = ({po.farm_id} if po.farm_id is not None else set()) | (farm_ids or set())
        item_ids = {ln.inventory_item_id for ln in po.lines} | (inventory_item_ids or set())
        # Acquire each category once. Multiple suppliers use ascending PK order,
        # and each supplier's profile/capabilities follow immediately.
        for partner_id in sorted(partner_ids, key=str):
            await self.po_repo.acquire_dependency_locks(
                business_partner_id=partner_id,
                farm_id=None,
                inventory_item_ids=set(),
            )
        await self.po_repo._lock_pks(Farm, all_farm_ids)
        await self.po_repo._lock_pks(InventoryItem, item_ids)

    async def _lock_and_authorize(
        self,
        po: PurchaseOrder,
        actor: User,
        operation: str,
        *,
        organization_id: uuid.UUID,
        business_partner_ids: set[uuid.UUID] | None = None,
        farm_ids: set[uuid.UUID] | None = None,
        inventory_item_ids: set[uuid.UUID] | None = None,
        authorization_farm_id: uuid.UUID | None = None,
    ) -> None:
        auth_farms = ({po.farm_id} if po.farm_id is not None else set()) | (farm_ids or set())
        await self._lock_authorization_dependencies(
            actor, organization_id=organization_id, farm_ids=auth_farms
        )
        await self._lock_dependencies(
            po,
            business_partner_ids=business_partner_ids,
            farm_ids=farm_ids,
            inventory_item_ids=inventory_item_ids,
        )
        await self._authorize(
            actor,
            operation,
            organization_id=organization_id,
            farm_id=po.farm_id if authorization_farm_id is None else authorization_farm_id,
        )

    async def _authorize(
        self,
        actor: User,
        operation: str,
        *,
        organization_id: uuid.UUID,
        farm_id: uuid.UUID | None,
    ) -> None:
        """Re-resolve authorization from canonical ACTIVE scopes inside the
        locked transaction. Covers permission + active org/farm membership +
        active role assignment + active org/farm."""
        required = _OPERATION_PERMISSION[operation]
        if not actor.is_active:
            raise _forbidden(required)
        scopes = await resolve_permission_scopes(self.session, actor)
        for scope in scopes:
            if required not in scope.permissions and "*" not in scope.permissions:
                continue
            if scope.organization_id is None and scope.farm_id is None:
                return  # platform grant
            if scope.farm_id is None and scope.organization_id == organization_id:
                return  # org-scoped grant applies to every PO in the org
            if farm_id is not None and scope.farm_id == farm_id:
                return  # farm-scoped grant applies to farm-assigned POs
        raise _forbidden(required)

    # ================================================================= #
    # Dependency loaders (post-lock authoritative reads)
    # ================================================================= #
    async def _load_supplier(
        self, organization_id: uuid.UUID, partner_id: uuid.UUID
    ) -> BusinessPartner:
        partner = await self.partner_repo.get_by_id(partner_id, with_relations=True)
        if partner is None or partner.organization_id != organization_id:
            raise _tenant_hidden("Business Partner")
        if partner.deleted_at is not None:
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
                "business_partner_not_approved", "The supplier has no approved qualification."
            )
        if profile.qualification_status == BusinessPartnerQualificationStatus.BLOCKED:
            raise _conflict("business_partner_blocked", "The supplier is blocked.")
        if profile.qualification_status != BusinessPartnerQualificationStatus.APPROVED:
            raise _conflict(
                "business_partner_not_approved", "The supplier is not approved for purchasing."
            )

    # ================================================================= #
    # Line value building (exact decimals, canonical conversion)
    # ================================================================= #
    def _build_line_values(self, *, item: InventoryItem, line_number: int, raw: dict) -> dict:
        ordered_quantity = _parse_decimal(
            raw["ordered_quantity"], field="ordered_quantity", maximum=_MAX_QTY
        )
        if ordered_quantity <= 0:
            raise _unprocessable("invalid_quantity", "ordered_quantity must be greater than zero.")
        unit_price = _parse_decimal(raw["unit_price"], field="unit_price", maximum=_MAX_PRICE)
        if unit_price < 0:
            raise _unprocessable("invalid_price", "unit_price must be zero or positive.")

        line_note = _bounded(raw.get("line_note"), field="line_note", maximum=_MAX_LINE_NOTE)
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
        qty_canonical = _quantize_canonical(qty_canonical, field="ordered_quantity_canonical")

        description = _bounded(
            raw.get("description"), field="description", maximum=_MAX_DESCRIPTION
        )
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

    _LINE_COMPARE_FIELDS = (
        "inventory_item_id",
        "item_code",
        "item_name",
        "item_sku",
        "description",
        "line_note",
        "ordered_quantity",
        "ordered_unit",
        "canonical_unit",
        "ordered_quantity_canonical",
        "unit_price",
        "line_number",
    )

    async def _create_fresh_lines(self, po: PurchaseOrder, lines: list[dict]) -> list[uuid.UUID]:
        # Load the collection (awaited) so appends never trigger a sync
        # lazy-load during flush.
        await self.session.refresh(po, attribute_names=["lines"])
        created: list[uuid.UUID] = []
        for index, raw in enumerate(lines, start=1):
            item = await self._load_item(
                po.organization_id, uuid.UUID(str(raw["inventory_item_id"]))
            )
            values = self._build_line_values(item=item, line_number=index, raw=raw)
            line = PurchaseOrderLine(purchase_order_id=po.id, **values)
            po.lines.append(line)
            await self.session.flush()
            created.append(line.id)
        return created

    async def _apply_line_diff(self, po: PurchaseOrder, payload: list[dict]) -> dict:
        """Stable-identity line reconciliation (objective 4).

        Preserves existing UUIDs across add / update / reorder / remove.
        Rejects duplicate or unknown line ids. Never emits artificial
        remove+add pairs for an in-place edit.
        """
        existing = {ln.id: ln for ln in po.lines}
        # ---- validate referenced ids ----
        seen: set[uuid.UUID] = set()
        parsed: list[tuple[uuid.UUID | None, dict]] = []
        for raw in payload:
            rid_raw = raw.get("id")
            rid: uuid.UUID | None = None
            if rid_raw is not None:
                try:
                    rid = uuid.UUID(str(rid_raw))
                except (ValueError, TypeError) as exc:
                    raise _unprocessable("invalid_line_id", "A line id is malformed.") from exc
                if rid in seen:
                    raise _conflict(
                        "duplicate_line_id",
                        "A line id appears more than once in the request.",
                        context={"line_id": str(rid)},
                    )
                if rid not in existing:
                    raise _conflict(
                        "unknown_line_id",
                        "A referenced line id does not belong to this Purchase Order.",
                        context={"line_id": str(rid)},
                    )
                seen.add(rid)
            parsed.append((rid, raw))

        keep_ids = seen
        removed = sorted((lid for lid in existing if lid not in keep_ids), key=str)
        # ---- capture originals for change detection ----
        originals = {
            lid: {f: getattr(ln, f) for f in self._LINE_COMPARE_FIELDS}
            for lid, ln in existing.items()
        }

        # phase 1: remove dropped lines
        for lid in removed:
            po.lines.remove(existing[lid])
        await self.session.flush()

        # phase 2: park surviving line_numbers out of the way so the
        # (po_id, line_number) unique constraint never trips mid-reorder.
        for offset, ln in enumerate(list(po.lines)):
            ln.line_number = 1_000_000 + offset
        await self.session.flush()

        # phase 3: materialise the desired order/content
        added: list[uuid.UUID] = []
        updated: list[uuid.UUID] = []
        for index, (rid, raw) in enumerate(parsed, start=1):
            item = await self._load_item(
                po.organization_id, uuid.UUID(str(raw["inventory_item_id"]))
            )
            values = self._build_line_values(item=item, line_number=index, raw=raw)
            if rid is not None:
                line = existing[rid]
                for field, value in values.items():
                    setattr(line, field, value)
                self.session.add(line)
                orig = originals[rid]
                if any(orig[f] != getattr(line, f) for f in self._LINE_COMPARE_FIELDS):
                    updated.append(rid)
            else:
                line = PurchaseOrderLine(purchase_order_id=po.id, **values)
                po.lines.append(line)
                await self.session.flush()
                added.append(line.id)
            await self.session.flush()

        return self._bounded_line_meta(added=added, updated=updated, removed=removed)

    @staticmethod
    def _bounded_line_meta(
        *, added: list[uuid.UUID], updated: list[uuid.UUID], removed: list[uuid.UUID]
    ) -> dict:
        def _cap(ids: list[uuid.UUID]) -> list[str]:
            return [str(i) for i in sorted(ids, key=str)[:50]]

        return {
            "added_line_ids": _cap(added),
            "updated_line_ids": _cap(sorted(updated, key=str)),
            "removed_line_ids": _cap(removed),
            "added_line_count": len(added),
            "updated_line_count": len(updated),
            "removed_line_count": len(removed),
            "line_ids_truncated": max(len(added), len(updated), len(removed)) > 50,
        }

    # ================================================================= #
    # Create
    # ================================================================= #
    async def create(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
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
        address = _validate_delivery_address(delivery_address)
        supplier_reference = _bounded(
            supplier_reference, field="supplier_reference", maximum=_MAX_SUPPLIER_REFERENCE
        )
        notes = _bounded(notes, field="notes", maximum=_MAX_NOTES)

        raw_lines = list(lines or [])
        item_ids = {uuid.UUID(str(ln["inventory_item_id"])) for ln in raw_lines}

        # --- authorization rows, then deterministic governed dependencies ---
        auth_farms = {farm_id} if farm_id is not None else set()
        await self._lock_authorization_dependencies(
            actor, organization_id=organization_id, farm_ids=auth_farms
        )
        await self.po_repo.acquire_dependency_locks(
            business_partner_id=business_partner_id,
            farm_id=farm_id,
            inventory_item_ids=item_ids,
        )
        await self._authorize(actor, "create", organization_id=organization_id, farm_id=farm_id)

        farm = await self._load_farm(organization_id, farm_id) if farm_id is not None else None
        partner = await self._load_supplier(organization_id, business_partner_id)
        self._validate_supplier(partner, for_submission=False)

        po_number = await self.sequence_repo.allocate(organization_id, order_date.year)
        try:
            po = await self.po_repo.create(
                organization_id=organization_id,
                farm_id=farm.id if farm else None,
                business_partner_id=partner.id,
                po_number=po_number,
                supplier_reference=supplier_reference,
                status=PurchaseOrderStatus.DRAFT,
                currency_code=currency,
                order_date=order_date,
                expected_delivery_date=expected_delivery_date,
                delivery_address=address,
                notes=notes,
                supplier_code=partner.code,
                supplier_legal_name=partner.legal_name,
                supplier_trading_name=partner.trading_name,
                version=1,
                created_by_id=actor.id,
            )
        except SAIntegrityError as exc:
            payload = str(exc.orig) if exc.orig is not None else str(exc)
            known_markers = (
                "uq_purchase_order_org_number",
                "purchase_orders.organization_id, purchase_orders.po_number",
            )
            if any(marker in payload for marker in known_markers):
                raise _conflict(
                    "duplicate_purchase_order_number",
                    "A Purchase Order with this number already exists in the organization.",
                ) from exc
            raise
        line_ids = await self._create_fresh_lines(po, raw_lines)

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
    # Draft update — locks, authorizes, then applies (objective 1/2/4)
    # ================================================================= #
    async def update_draft(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        expected_version: int,
        data: dict,
        request_ctx: dict | None = None,
    ) -> PurchaseOrder:
        request_ctx = request_ctx or {}
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)

        requested_partner_ids = (
            {uuid.UUID(str(data["business_partner_id"]))}
            if data.get("business_partner_id") is not None
            else set()
        )
        requested_farm_ids = (
            {uuid.UUID(str(data["farm_id"]))} if data.get("farm_id") is not None else set()
        )
        requested_item_ids = {
            uuid.UUID(str(line["inventory_item_id"])) for line in (data.get("lines") or [])
        }
        await self._lock_and_authorize(
            po,
            actor,
            "update",
            organization_id=organization_id,
            business_partner_ids=requested_partner_ids,
            farm_ids=requested_farm_ids,
            inventory_item_ids=requested_item_ids,
        )

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
                    # Authorize on the destination farm scope too.
                    await self._authorize(
                        actor, "update", organization_id=organization_id, farm_id=new_farm_id
                    )
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

        if "supplier_reference" in data:
            new_ref = _bounded(
                data["supplier_reference"],
                field="supplier_reference",
                maximum=_MAX_SUPPLIER_REFERENCE,
            )
            if new_ref != po.supplier_reference:
                po.supplier_reference = new_ref
                changed_fields.append("supplier_reference")
        if "notes" in data:
            new_notes = _bounded(data["notes"], field="notes", maximum=_MAX_NOTES)
            if new_notes != po.notes:
                po.notes = new_notes
                changed_fields.append("notes")

        if "delivery_address" in data:
            new_address = _validate_delivery_address(data["delivery_address"])
            if new_address != po.delivery_address:
                po.delivery_address = new_address
                changed_fields.append("delivery_address")

        line_change_meta: dict = {}
        if "lines" in data:
            meta = await self._apply_line_diff(po, list(data["lines"] or []))
            if meta["added_line_count"] or meta["updated_line_count"] or meta["removed_line_count"]:
                changed_fields.append("lines")
                line_change_meta = meta

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

    # ================================================================= #
    # Lifecycle transitions (§5) — each owns lock + authorize
    # ================================================================= #
    async def submit(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "submit", organization_id=organization_id)

        if po.status == PurchaseOrderStatus.SUBMITTED:
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.DRAFT:
            raise self._invalid_transition(po)

        # --- rebuild + revalidate the WHOLE document from locked data ---
        await self._rebuild_and_validate_for_submission(po)

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

    async def _rebuild_and_validate_for_submission(self, po: PurchaseOrder) -> None:
        """Objective 3 — full authoritative rebuild before snapshot freeze."""
        lines = list(po.lines)
        if not lines:
            raise _conflict(
                "purchase_order_requires_line",
                "A Purchase Order must have at least one line to submit.",
            )
        # Header revalidation.
        if not is_valid_currency(po.currency_code):
            raise _unprocessable(
                "invalid_currency", "currency_code is not an official ISO 4217 code."
            )
        if po.expected_delivery_date is not None and po.expected_delivery_date < po.order_date:
            raise _conflict(
                "purchase_order_invalid_delivery_date",
                "Expected delivery date cannot precede the order date.",
            )
        po.delivery_address = _validate_delivery_address(po.delivery_address)
        po.supplier_reference = _bounded(
            po.supplier_reference, field="supplier_reference", maximum=_MAX_SUPPLIER_REFERENCE
        )
        po.notes = _bounded(po.notes, field="notes", maximum=_MAX_NOTES)
        if po.farm_id is not None:
            await self._load_farm(po.organization_id, po.farm_id)

        partner = await self._load_supplier(po.organization_id, po.business_partner_id)
        self._validate_supplier(partner, for_submission=True)
        po.supplier_code = partner.code
        po.supplier_legal_name = partner.legal_name
        po.supplier_trading_name = partner.trading_name

        # Re-derive every line from authoritative item data (units,
        # canonical quantities, compatibility, zero-price rule, bounds).
        for line in lines:
            item = await self._load_item(po.organization_id, line.inventory_item_id)
            values = self._build_line_values(
                item=item,
                line_number=line.line_number,
                raw={
                    "inventory_item_id": item.id,
                    "ordered_quantity": Decimal(str(line.ordered_quantity)),
                    "ordered_unit": line.ordered_unit,
                    "unit_price": Decimal(str(line.unit_price)),
                    "description": line.description,
                    "line_note": line.line_note,
                },
            )
            for field, value in values.items():
                setattr(line, field, value)
            self.session.add(line)
        await self.session.flush()

    async def withdraw(
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        reason: str,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("withdraw", reason)
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "withdraw", organization_id=organization_id)
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
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        reason: str | None = None,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "approve", organization_id=organization_id)
        # Independent-approval invariant applies to EVERY actor (§5.1).
        if actor.id == po.created_by_id:
            raise _conflict(
                "purchase_order_self_approval_forbidden",
                "A Purchase Order cannot be approved by its creator.",
            )
        if po.status == PurchaseOrderStatus.APPROVED:
            return LifecycleResult(po, replay=True)
        if po.status != PurchaseOrderStatus.SUBMITTED:
            raise self._invalid_transition(po)
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
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        reason: str,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("reject", reason)
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "reject", organization_id=organization_id)
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
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        reason: str,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("revise", reason)
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "revise", organization_id=organization_id)
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
        self,
        *,
        actor: User,
        organization_id: uuid.UUID,
        po_id: uuid.UUID,
        reason: str,
        request_ctx: dict | None = None,
    ) -> LifecycleResult:
        request_ctx = request_ctx or {}
        self._require_reason("cancel", reason)
        po = await self._lock_po_for_mutation(po_id, organization_id, actor)
        await self._lock_and_authorize(po, actor, "cancel", organization_id=organization_id)
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
        # Objective 8 — refuse cancellation when EITHER received
        # accumulator carries quantity (6.0.4 receipt safety; 6.0.3
        # cannot create the condition but the guard must be complete).
        for line in po.lines:
            if (
                Decimal(str(line.received_quantity)) != 0
                or Decimal(str(line.received_quantity_canonical)) != 0
            ):
                raise _conflict(
                    "purchase_order_has_receipts",
                    "A Purchase Order with recorded receipts cannot be cancelled.",
                    context={"line_number": line.line_number},
                )
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
    # Derived totals (§4.3) — exact 6-dp, never a stored column.
    # ================================================================= #
    @staticmethod
    def subtotal(po: PurchaseOrder) -> Decimal:
        with localcontext(_ARITHMETIC_CONTEXT):
            total = Decimal(0)
            for line in po.lines:
                extended = Decimal(line.ordered_quantity) * Decimal(line.unit_price)
                total += _quantize_result(extended, field="extended_amount")
            return _quantize_result(total, field="subtotal")

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
