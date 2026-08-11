"""Release 6.0.4 Sprint 4.2 Purchase Receipt REST endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.deps import CurrentUser, DBSession, RequestCtx
from app.models.purchase_order import PurchaseOrder
from app.models.purchase_receipt import PurchaseReceipt
from app.repositories.purchase_receipt import PurchaseReceiptRepository
from app.schemas.purchase_receipt import (
    PurchaseReceiptCommand,
    PurchaseReceiptPage,
    PurchaseReceiptResponse,
    ReceiptWarehouseOption,
)
from app.security.authorize import PermissionScope, resolve_permission_scopes
from app.services.purchase_receipt import PurchaseReceiptService


class PurchaseReceiptRoute(APIRoute):
    """Keep receipt quantity validation inside the bounded API contract."""

    def get_route_handler(self):
        route_handler = super().get_route_handler()

        async def bounded_handler(request: Request):
            try:
                return await route_handler(request)
            except RequestValidationError as exc:
                errors = exc.errors()
                quantity_error = (
                    request.method == "POST"
                    and bool(errors)
                    and all(
                        len(location := error.get("loc", ())) == 4
                        and location[0] == "body"
                        and location[1] == "lines"
                        and isinstance(location[2], int)
                        and location[3] == "quantity"
                        for error in errors
                    )
                )
                if not quantity_error:
                    raise
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {
                        "code": "invalid_quantity",
                        "message": "Receipt quantity is invalid.",
                        "context": {},
                    },
                ) from None

        return bounded_handler


router = APIRouter(tags=["purchase-receipts"], route_class=PurchaseReceiptRoute)


def _service(session: DBSession) -> PurchaseReceiptService:
    return PurchaseReceiptService(session)


ServiceDep = Annotated[PurchaseReceiptService, Depends(_service)]


def _not_found(entity: str) -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {"code": "not_found", "message": f"{entity} not found.", "context": {}},
    )


def _forbidden(permission: str) -> HTTPException:
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        {
            "code": "not_authorized",
            "message": "Not authorized.",
            "context": {"required": permission},
        },
    )


def _scope_applies(scope: PermissionScope, organization_id: uuid.UUID, farm_id: uuid.UUID | None):
    return (
        (scope.organization_id is None and scope.farm_id is None)
        or (scope.organization_id == organization_id and scope.farm_id is None)
        or (farm_id is not None and scope.farm_id == farm_id)
    )


async def _load_visible_po(
    session: DBSession, user: CurrentUser, purchase_order_id: uuid.UUID
) -> tuple[PurchaseOrder, list[PermissionScope]]:
    scopes = await resolve_permission_scopes(session, user)
    po = await PurchaseReceiptRepository(session).get_visible_purchase_order(
        purchase_order_id, user.id, scopes
    )
    if po is None:
        raise _not_found("Purchase Order")
    return po, scopes


def _require(permission: str, scopes: list[PermissionScope], resource) -> None:
    if not any(
        _scope_applies(scope, resource.organization_id, resource.farm_id)
        and ("*" in scope.permissions or permission in scope.permissions)
        for scope in scopes
    ):
        raise _forbidden(permission)


def _response(receipt: PurchaseReceipt) -> PurchaseReceiptResponse:
    values = {
        field: getattr(receipt, field)
        for field in PurchaseReceiptResponse.model_fields
        if field != "lines"
    }
    return PurchaseReceiptResponse.model_validate(
        {**values, "lines": sorted(receipt.lines, key=lambda line: line.line_number)}
    )


@router.post(
    "/purchase-orders/{po_id}/receipts",
    response_model=PurchaseReceiptResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_purchase_receipt(
    po_id: uuid.UUID,
    payload: PurchaseReceiptCommand,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: DBSession,
    request_ctx: RequestCtx,
    service: ServiceDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> PurchaseReceiptResponse:
    if idempotency_key is None or len(request.headers.getlist("idempotency-key")) != 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            {
                "code": "idempotency_key_required",
                "message": "A valid Idempotency-Key is required.",
                "context": {},
            },
        )
    po, _scopes = await _load_visible_po(session, user, po_id)
    receipt, replay = await service.post(
        actor=user,
        organization_id=po.organization_id,
        purchase_order_id=po.id,
        command=payload,
        idempotency_key=idempotency_key,
        request_ctx=request_ctx,
    )
    if replay:
        response.status_code = status.HTTP_200_OK
        response.headers["X-Idempotent-Replay"] = "true"
    return _response(receipt)


@router.get(
    "/purchase-orders/{po_id}/receipt-warehouses",
    response_model=list[ReceiptWarehouseOption],
)
async def list_receipt_warehouses(
    po_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
) -> list[ReceiptWarehouseOption]:
    po, scopes = await _load_visible_po(session, user, po_id)
    _require("purchase_receipt.create", scopes, po)
    rows = await PurchaseReceiptRepository(session).list_receipt_warehouses(
        po.organization_id, po.farm_id
    )
    return [ReceiptWarehouseOption.model_validate(row) for row in rows]


@router.get("/purchase-orders/{po_id}/receipts", response_model=PurchaseReceiptPage)
async def list_purchase_receipts(
    po_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
    service: ServiceDep,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> PurchaseReceiptPage:
    po, scopes = await _load_visible_po(session, user, po_id)
    _require("purchase_receipt.read", scopes, po)
    rows, next_cursor = await service.receipt_repo.list_by_purchase_order(
        po.id, po.organization_id, cursor=cursor, limit=limit
    )
    return PurchaseReceiptPage(items=[_response(row) for row in rows], next_cursor=next_cursor)


@router.get("/purchase-receipts/{receipt_id}", response_model=PurchaseReceiptResponse)
async def get_purchase_receipt(
    receipt_id: uuid.UUID,
    user: CurrentUser,
    session: DBSession,
) -> PurchaseReceiptResponse:
    repository = PurchaseReceiptRepository(session)
    scopes = await resolve_permission_scopes(session, user)
    receipt = await repository.get_visible_by_id(receipt_id, user.id, scopes)
    if receipt is None:
        raise _not_found("Purchase Receipt")
    _require("purchase_receipt.read", scopes, receipt)
    return _response(receipt)


__all__ = ["router"]
