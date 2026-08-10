"""Release 6.0.3 Purchase Order REST endpoints."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import ROUND_HALF_UP, Context, Decimal, localcontext
from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.deps import CurrentOrganization, CurrentUser, DBSession, RequestCtx
from app.models.farm import Farm
from app.models.membership import OrganizationMembership
from app.models.purchase_order import PurchaseOrder, PurchaseOrderStatus
from app.repositories.audit_repo import AuditRepository
from app.repositories.business_partner import BusinessPartnerRepository
from app.repositories.purchase_order import (
    PurchaseOrderLineRepository,
    PurchaseOrderRepository,
    PurchaseOrderSequenceRepository,
    PurchaseOrderTransitionRepository,
)
from app.schemas.purchase_order import (
    ApprovalPayload,
    LifecycleReasonPayload,
    PurchaseOrderCreate,
    PurchaseOrderLineResponse,
    PurchaseOrderPage,
    PurchaseOrderResponse,
    PurchaseOrderTransitionPage,
    PurchaseOrderTransitionResponse,
    PurchaseOrderUpdate,
)
from app.security.authorize import resolve_permission_scopes
from app.services.purchase_order import LifecycleResult, PurchaseOrderService

router = APIRouter(tags=["purchase-orders"])

_RESPONSE_ARITHMETIC_CONTEXT = Context(prec=64, rounding=ROUND_HALF_UP)
_RESPONSE_QUANTUM = Decimal("0.000001")


def _get_service(session: DBSession) -> PurchaseOrderService:
    return PurchaseOrderService(
        po_repo=PurchaseOrderRepository(session),
        line_repo=PurchaseOrderLineRepository(session),
        transition_repo=PurchaseOrderTransitionRepository(session),
        sequence_repo=PurchaseOrderSequenceRepository(session),
        partner_repo=BusinessPartnerRepository(session),
        audit_repo=AuditRepository(session),
    )


ServiceDep = Annotated[PurchaseOrderService, Depends(_get_service)]


def _not_found() -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {"code": "not_found", "message": "Purchase Order not found.", "context": {}},
    )


def _forbidden(permission: str) -> HTTPException:
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"Missing required permission: {permission}",
    )


async def _applicable_scopes(session: DBSession, user: CurrentUser, po: PurchaseOrder):
    scopes = await resolve_permission_scopes(session, user)
    return [
        scope
        for scope in scopes
        if (scope.organization_id is None and scope.farm_id is None)
        or (scope.organization_id == po.organization_id and scope.farm_id is None)
        or (po.farm_id is not None and scope.farm_id == po.farm_id)
    ]


async def _load_visible_po(
    purchase_order_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> PurchaseOrder:
    po = await service.po_repo.get_by_id(purchase_order_id)
    if po is None:
        raise _not_found()
    if user.is_superuser:
        return po

    scopes = await resolve_permission_scopes(session, user)
    applicable = await _applicable_scopes(session, user, po)
    if applicable:
        return po

    membership = (
        await session.execute(
            select(OrganizationMembership.id).where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.organization_id == po.organization_id,
                OrganizationMembership.is_active.is_(True),
                OrganizationMembership.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    # A same-tenant user with no grants reaches the explicit 403 permission
    # boundary. A scoped user attempting another farm remains tenant-hidden.
    if membership is not None and not scopes:
        return po
    raise _not_found()


async def _require_po_permission(
    permission: str,
    po: PurchaseOrder,
    user: CurrentUser,
    session: DBSession,
) -> None:
    scopes = await _applicable_scopes(session, user, po)
    if not any("*" in scope.permissions or permission in scope.permissions for scope in scopes):
        raise _forbidden(permission)


def _po_response(po: PurchaseOrder, service: PurchaseOrderService) -> PurchaseOrderResponse:
    lines = []
    for line in sorted(po.lines, key=lambda row: row.line_number):
        with localcontext(_RESPONSE_ARITHMETIC_CONTEXT):
            extended = (Decimal(line.ordered_quantity) * Decimal(line.unit_price)).quantize(
                _RESPONSE_QUANTUM, rounding=ROUND_HALF_UP
            )
        lines.append(
            PurchaseOrderLineResponse.model_validate(
                {
                    **{
                        field: getattr(line, field)
                        for field in PurchaseOrderLineResponse.model_fields
                        if field != "extended_amount"
                    },
                    "extended_amount": extended,
                }
            )
        )
    values = {
        field: getattr(po, field)
        for field in PurchaseOrderResponse.model_fields
        if field not in {"subtotal", "lines"}
    }
    return PurchaseOrderResponse.model_validate(
        {**values, "subtotal": service.subtotal(po), "lines": lines}
    )


async def _fresh_po_response(
    po_id: uuid.UUID, service: PurchaseOrderService
) -> PurchaseOrderResponse:
    po = (
        await service.session.execute(
            select(PurchaseOrder)
            .where(PurchaseOrder.id == po_id)
            .options(selectinload(PurchaseOrder.lines))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return _po_response(po, service)


async def _lifecycle_response(
    result: LifecycleResult,
    response: Response,
    service: PurchaseOrderService,
) -> PurchaseOrderResponse:
    if result.replay:
        response.headers["X-Idempotent-Replay"] = "true"
    return await _fresh_po_response(result.purchase_order.id, service)


@router.get(
    "/organizations/{organization_id}/purchase-orders",
    response_model=PurchaseOrderPage,
)
async def list_purchase_orders(
    organization_id: uuid.UUID,
    _organization: CurrentOrganization,
    user: CurrentUser,
    service: ServiceDep,
    farm_id: uuid.UUID | None = Query(default=None),
    business_partner_id: uuid.UUID | None = Query(default=None),
    statuses: Annotated[list[PurchaseOrderStatus] | None, Query(alias="status")] = None,
    order_date_from: date | None = Query(default=None),
    order_date_to: date | None = Query(default=None),
    expected_delivery_from: date | None = Query(default=None),
    expected_delivery_to: date | None = Query(default=None),
    search: str | None = Query(default=None, max_length=255),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> PurchaseOrderPage:
    del _organization
    scopes = await resolve_permission_scopes(service.session, user)
    org_read = any(
        (scope.organization_id is None or scope.organization_id == organization_id)
        and scope.farm_id is None
        and ("*" in scope.permissions or "purchase_order.read" in scope.permissions)
        for scope in scopes
    )
    farm_ids = sorted(
        {
            scope.farm_id
            for scope in scopes
            if scope.organization_id == organization_id
            and scope.farm_id is not None
            and ("*" in scope.permissions or "purchase_order.read" in scope.permissions)
        },
        key=str,
    )
    if not org_read and not farm_ids:
        raise _forbidden("purchase_order.read")
    if farm_id is not None:
        if not org_read and farm_id not in farm_ids:
            raise _not_found()
        farm_ids = [farm_id]
        org_read = False

    rows, next_cursor = await service.po_repo.list_page(
        organization_id,
        farm_ids=farm_ids,
        org_scope=org_read,
        business_partner_id=business_partner_id,
        statuses=statuses,
        supplier_search=search,
        order_date_from=order_date_from,
        order_date_to=order_date_to,
        expected_delivery_from=expected_delivery_from,
        expected_delivery_to=expected_delivery_to,
        cursor=cursor,
        limit=limit,
    )
    return PurchaseOrderPage(
        items=[_po_response(po, service) for po in rows], next_cursor=next_cursor
    )


@router.post(
    "/organizations/{organization_id}/purchase-orders",
    response_model=PurchaseOrderResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_purchase_order(
    organization_id: uuid.UUID,
    payload: PurchaseOrderCreate,
    _organization: CurrentOrganization,
    user: CurrentUser,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    del _organization
    data = payload.model_dump()
    lines = data.pop("lines")
    if payload.farm_id is not None:
        farm = await service.session.get(Farm, payload.farm_id)
        if (
            farm is None
            or farm.organization_id != organization_id
            or farm.deleted_at is not None
            or not farm.is_active
        ):
            raise _not_found()
        if not user.is_superuser:
            scopes = await resolve_permission_scopes(service.session, user)
            has_org_scope = any(
                scope.organization_id == organization_id and scope.farm_id is None
                for scope in scopes
            )
            has_farm_scope = any(scope.farm_id == payload.farm_id for scope in scopes)
            if not has_org_scope and not has_farm_scope:
                raise _not_found()
    po = await service.create(
        actor=user,
        organization_id=organization_id,
        lines=lines,
        request_ctx=request_ctx,
        **data,
    )
    return await _fresh_po_response(po.id, service)


@router.get("/purchase-orders/{purchase_order_id}", response_model=PurchaseOrderResponse)
async def get_purchase_order(
    purchase_order_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    po = await _load_visible_po(purchase_order_id, user, session, service)
    await _require_po_permission("purchase_order.read", po, user, session)
    return _po_response(po, service)


@router.patch("/purchase-orders/{purchase_order_id}", response_model=PurchaseOrderResponse)
async def update_purchase_order(
    purchase_order_id: uuid.UUID,
    payload: PurchaseOrderUpdate,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    po = await _load_visible_po(purchase_order_id, user, session, service)
    data = payload.model_dump(exclude_unset=True)
    expected_version = data.pop("expected_version")
    updated = await service.update_draft(
        actor=user,
        organization_id=po.organization_id,
        po_id=po.id,
        expected_version=expected_version,
        data=data,
        request_ctx=request_ctx,
    )
    return await _fresh_po_response(updated.id, service)


LifecycleCall = Callable[..., Awaitable[LifecycleResult]]


async def _run_lifecycle(
    purchase_order_id: uuid.UUID,
    permission: str,
    operation: LifecycleCall,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
    response: Response,
    request_ctx: RequestCtx,
    reason: str | None = None,
) -> PurchaseOrderResponse:
    po = await _load_visible_po(purchase_order_id, user, session, service)
    await _require_po_permission(permission, po, user, session)
    kwargs = {
        "actor": user,
        "organization_id": po.organization_id,
        "po_id": po.id,
        "request_ctx": request_ctx,
    }
    if reason is not None or operation.__name__ in {"withdraw", "reject", "revise", "cancel"}:
        kwargs["reason"] = reason
    result = await operation(**kwargs)
    return await _lifecycle_response(result, response, service)


@router.post("/purchase-orders/{purchase_order_id}/submit", response_model=PurchaseOrderResponse)
async def submit_purchase_order(
    purchase_order_id: uuid.UUID,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.submit",
        service.submit,
        user,
        session,
        service,
        response,
        request_ctx,
    )


@router.post("/purchase-orders/{purchase_order_id}/withdraw", response_model=PurchaseOrderResponse)
async def withdraw_purchase_order(
    purchase_order_id: uuid.UUID,
    payload: LifecycleReasonPayload,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.update",
        service.withdraw,
        user,
        session,
        service,
        response,
        request_ctx,
        payload.reason,
    )


@router.post("/purchase-orders/{purchase_order_id}/approve", response_model=PurchaseOrderResponse)
async def approve_purchase_order(
    purchase_order_id: uuid.UUID,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
    payload: Annotated[ApprovalPayload | None, Body()] = None,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.approve",
        service.approve,
        user,
        session,
        service,
        response,
        request_ctx,
        payload.reason if payload else None,
    )


@router.post("/purchase-orders/{purchase_order_id}/reject", response_model=PurchaseOrderResponse)
async def reject_purchase_order(
    purchase_order_id: uuid.UUID,
    payload: LifecycleReasonPayload,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.reject",
        service.reject,
        user,
        session,
        service,
        response,
        request_ctx,
        payload.reason,
    )


@router.post("/purchase-orders/{purchase_order_id}/revise", response_model=PurchaseOrderResponse)
async def revise_purchase_order(
    purchase_order_id: uuid.UUID,
    payload: LifecycleReasonPayload,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.update",
        service.revise,
        user,
        session,
        service,
        response,
        request_ctx,
        payload.reason,
    )


@router.post("/purchase-orders/{purchase_order_id}/cancel", response_model=PurchaseOrderResponse)
async def cancel_purchase_order(
    purchase_order_id: uuid.UUID,
    payload: LifecycleReasonPayload,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
) -> PurchaseOrderResponse:
    return await _run_lifecycle(
        purchase_order_id,
        "purchase_order.cancel",
        service.cancel,
        user,
        session,
        service,
        response,
        request_ctx,
        payload.reason,
    )


@router.get(
    "/purchase-orders/{purchase_order_id}/transitions",
    response_model=PurchaseOrderTransitionPage,
)
async def list_purchase_order_transitions(
    purchase_order_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> PurchaseOrderTransitionPage:
    po = await _load_visible_po(purchase_order_id, user, session, service)
    await _require_po_permission("purchase_order.read", po, user, session)
    rows, next_cursor = await service.transition_repo.page_for_po(po.id, cursor=cursor, limit=limit)
    return PurchaseOrderTransitionPage(
        items=[
            PurchaseOrderTransitionResponse(
                id=row.id,
                purchase_order_id=row.purchase_order_id,
                actor_id=row.actor_id,
                from_status=row.from_status,
                to_status=row.to_status,
                operation=(row.metadata_json or {}).get("operation", ""),
                reason=row.reason,
                occurred_at=row.occurred_at,
            )
            for row in rows
        ],
        next_cursor=next_cursor,
    )
