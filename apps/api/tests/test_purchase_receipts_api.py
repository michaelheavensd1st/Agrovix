"""Release 6.0.4 Sprint 4.2 Purchase Receipt HTTP contract tests."""

from __future__ import annotations

import base64
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select

from app.db import session as _db
from app.models.audit import AuditEvent
from app.models.business_partner import BusinessPartner
from app.models.farm import Farm
from app.models.inventory import (
    InventoryItem,
    InventoryItemCategory,
    InventoryLot,
    InventoryTransaction,
    StockUnit,
    Warehouse,
    WarehouseStatus,
)
from app.models.membership import FarmMembership, OrganizationMembership
from app.models.organization import Organization
from app.models.purchase_order import (
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseOrderTransition,
)
from app.models.purchase_receipt import (
    PurchaseReceipt,
    PurchaseReceiptLine,
    PurchaseReceiptSequence,
)
from app.models.role import Role
from app.models.role_assignment import RoleAssignment
from app.models.user import User
from tests._helpers import create_verified_user, switch_user

pytestmark = pytest.mark.asyncio


async def _seed(
    client: AsyncClient,
    *,
    role_name: str = "organization_owner",
    farm_scoped: bool = False,
    po_status: PurchaseOrderStatus = PurchaseOrderStatus.APPROVED,
    ordered_quantity: str = "10.000000",
    ordered_unit: str = "kg",
    ordered_canonical: str = "10.000000",
) -> dict[str, UUID | str]:
    email = f"receipt-api-{uuid4().hex[:10]}@agrovix.dev"
    await create_verified_user(email)
    async with _db.AsyncSessionLocal() as session:
        actor = (await session.execute(select(User).where(User.email == email))).scalar_one()
        role = (await session.execute(select(Role).where(Role.name == role_name))).scalar_one()
        organization = Organization(
            name="Receipt API Org", slug=f"receipt-api-{uuid4().hex}", is_active=True
        )
        session.add(organization)
        await session.flush()
        farm = Farm(
            organization_id=organization.id,
            name="Receipt Farm",
            code=f"RF-{uuid4().hex[:8]}",
            is_active=True,
        )
        partner = BusinessPartner(
            organization_id=organization.id,
            code=f"SUP-{uuid4().hex[:8]}",
            legal_name="Receipt Supplier",
            is_active=True,
        )
        item = InventoryItem(
            organization_id=organization.id,
            code=f"ITEM-{uuid4().hex[:8]}",
            name="Receipt Item",
            category=InventoryItemCategory.FEED,
            canonical_unit=StockUnit.KG,
            is_active=True,
        )
        session.add_all([farm, partner, item])
        await session.flush()
        warehouse = Warehouse(
            organization_id=organization.id,
            farm_id=farm.id,
            name="Receipt Warehouse",
            code=f"RW-{uuid4().hex[:8]}",
            status=WarehouseStatus.ACTIVE,
        )
        po = PurchaseOrder(
            organization_id=organization.id,
            farm_id=farm.id,
            business_partner_id=partner.id,
            po_number=f"PO-2026-{uuid4().int % 999999:06d}",
            status=po_status,
            currency_code="USD",
            order_date=date(2026, 8, 11),
            supplier_code=partner.code,
            supplier_legal_name=partner.legal_name,
            created_by_id=actor.id,
            approved_by_id=actor.id if po_status == PurchaseOrderStatus.APPROVED else None,
            approved_at=datetime.now(UTC) if po_status == PurchaseOrderStatus.APPROVED else None,
            version=3,
        )
        session.add_all([warehouse, po])
        await session.flush()
        po_line = PurchaseOrderLine(
            purchase_order_id=po.id,
            line_number=1,
            inventory_item_id=item.id,
            item_code=item.code,
            item_name=item.name,
            description=item.name,
            ordered_quantity=Decimal(ordered_quantity),
            ordered_unit=ordered_unit,
            canonical_unit="kg",
            ordered_quantity_canonical=Decimal(ordered_canonical),
            received_quantity=Decimal("0.000000"),
            received_quantity_canonical=Decimal("0.000000"),
            unit_price=Decimal("2.500000"),
        )
        session.add_all(
            [
                po_line,
                OrganizationMembership(
                    user_id=actor.id, organization_id=organization.id, is_active=True
                ),
                RoleAssignment(
                    user_id=actor.id,
                    role_id=role.id,
                    organization_id=organization.id,
                    farm_id=farm.id if farm_scoped else None,
                ),
            ]
        )
        if farm_scoped:
            session.add(FarmMembership(user_id=actor.id, farm_id=farm.id, is_active=True))
        await session.commit()
        values = {
            "email": email,
            "actor_id": actor.id,
            "organization_id": organization.id,
            "farm_id": farm.id,
            "warehouse_id": warehouse.id,
            "po_id": po.id,
            "po_line_id": po_line.id,
            "item_id": item.id,
        }
    await switch_user(client, email)
    return values


async def _add_role_user(
    client: AsyncClient,
    organization_id: UUID,
    role_name: str,
    *,
    farm_id: UUID | None = None,
) -> str:
    email = f"receipt-role-{uuid4().hex[:10]}@agrovix.dev"
    await create_verified_user(email)
    async with _db.AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        role = (await session.execute(select(Role).where(Role.name == role_name))).scalar_one()
        session.add_all(
            [
                OrganizationMembership(
                    user_id=user.id, organization_id=organization_id, is_active=True
                ),
                RoleAssignment(
                    user_id=user.id,
                    role_id=role.id,
                    organization_id=organization_id,
                    farm_id=farm_id,
                ),
            ]
        )
        if farm_id is not None:
            session.add(FarmMembership(user_id=user.id, farm_id=farm_id, is_active=True))
        await session.commit()
    await switch_user(client, email)
    return email


def _body(seed: dict[str, UUID | str], *, quantity: str = "2.000000", lot: str = "LOT-A"):
    return {
        "warehouse_id": str(seed["warehouse_id"]),
        "supplier_delivery_reference": "DELIVERY-42",
        "received_at": "2026-08-11T12:00:00Z",
        "notes": "Dock receipt",
        "lines": [
            {
                "purchase_order_line_id": str(seed["po_line_id"]),
                "lot_code": lot,
                "quantity": quantity,
            }
        ],
    }


async def _post(client: AsyncClient, seed, *, key="receipt-api-key", body=None):
    return await client.post(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        json=body if body is not None else _body(seed),
        headers={"Idempotency-Key": key},
    )


async def _receipt_state(seed: dict[str, UUID | str], idempotency_key: str) -> dict:
    async with _db.AsyncSessionLocal() as session:
        receipts = list(
            (
                await session.execute(
                    select(PurchaseReceipt)
                    .where(
                        PurchaseReceipt.organization_id == seed["organization_id"],
                        PurchaseReceipt.purchase_order_id == seed["po_id"],
                        PurchaseReceipt.idempotency_key == idempotency_key,
                    )
                    .order_by(PurchaseReceipt.id)
                )
            ).scalars()
        )
        receipt_ids = [receipt.id for receipt in receipts]
        lines = list(
            (
                await session.execute(
                    select(PurchaseReceiptLine)
                    .where(PurchaseReceiptLine.purchase_receipt_id.in_(receipt_ids))
                    .order_by(PurchaseReceiptLine.id)
                )
            ).scalars()
        )
        line_ids = [line.id for line in lines]
        transactions = list(
            (
                await session.execute(
                    select(InventoryTransaction.id)
                    .where(
                        InventoryTransaction.organization_id == seed["organization_id"],
                        InventoryTransaction.reference_type == "purchase_receipt_line",
                        InventoryTransaction.reference_id.in_(line_ids),
                    )
                    .order_by(InventoryTransaction.id)
                )
            ).scalars()
        )
        lots = list(
            (
                await session.execute(
                    select(InventoryLot.id)
                    .where(
                        InventoryLot.warehouse_id == seed["warehouse_id"],
                        InventoryLot.item_id == seed["item_id"],
                        InventoryLot.lot_code == "LOT-A",
                    )
                    .order_by(InventoryLot.id)
                )
            ).scalars()
        )
        po_line = await session.get(PurchaseOrderLine, seed["po_line_id"])
        po = await session.get(PurchaseOrder, seed["po_id"])
        transitions = list(
            (
                await session.execute(
                    select(PurchaseOrderTransition.id)
                    .where(PurchaseOrderTransition.purchase_order_id == seed["po_id"])
                    .order_by(PurchaseOrderTransition.id)
                )
            ).scalars()
        )
        audits = list(
            (
                await session.execute(
                    select(AuditEvent.id)
                    .where(
                        AuditEvent.organization_id == seed["organization_id"],
                        AuditEvent.action == "purchase_receipt.post",
                        AuditEvent.entity_id.in_([str(receipt_id) for receipt_id in receipt_ids]),
                    )
                    .order_by(AuditEvent.id)
                )
            ).scalars()
        )
        sequence = await session.scalar(
            select(PurchaseReceiptSequence.last_value).where(
                PurchaseReceiptSequence.organization_id == seed["organization_id"],
                PurchaseReceiptSequence.year == 2026,
            )
        )
        return {
            "receipt_ids": receipt_ids,
            "grns": [receipt.grn for receipt in receipts],
            "line_ids": line_ids,
            "transaction_ids": transactions,
            "lot_ids": lots,
            "received_quantity": po_line.received_quantity,
            "received_quantity_canonical": po_line.received_quantity_canonical,
            "po_status": po.status,
            "po_version": po.version,
            "transition_ids": transitions,
            "audit_ids": audits,
            "sequence": sequence,
        }


async def _get_with_sql(client: AsyncClient, path: str):
    statements: list[str] = []

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lower())

    event.listen(_db.engine.sync_engine, "before_cursor_execute", capture_statement)
    try:
        response = await client.get(path)
    finally:
        event.remove(_db.engine.sync_engine, "before_cursor_execute", capture_statement)
    return response, statements


async def _post_with_sql(client: AsyncClient, seed, *, key: str):
    statements: list[str] = []

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.lower())

    event.listen(_db.engine.sync_engine, "before_cursor_execute", capture_statement)
    try:
        response = await _post(client, seed, key=key)
    finally:
        event.remove(_db.engine.sync_engine, "before_cursor_execute", capture_statement)
    return response, statements


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/v1/purchase-orders/00000000-0000-0000-0000-000000000001/receipts"),
        ("GET", "/api/v1/purchase-orders/00000000-0000-0000-0000-000000000001/receipts"),
        (
            "GET",
            "/api/v1/purchase-orders/00000000-0000-0000-0000-000000000001/receipt-warehouses",
        ),
        ("GET", "/api/v1/purchase-receipts/00000000-0000-0000-0000-000000000001"),
    ],
)
async def test_receipt_routes_require_authentication(client: AsyncClient, method: str, path: str):
    client.cookies.clear()
    response = await client.request(method, path, json={} if method == "POST" else None)
    assert response.status_code == 401


async def _seed_receipt_warehouse_matrix(seed: dict[str, UUID | str]) -> dict[str, UUID]:
    async with _db.AsyncSessionLocal() as session:
        other_farm = Farm(
            organization_id=seed["organization_id"],
            name="Other Farm",
            code=f"OF-{uuid4().hex[:8]}",
            is_active=True,
        )
        foreign_org = Organization(
            name="Foreign Receipt Org", slug=f"foreign-receipt-{uuid4().hex}", is_active=True
        )
        session.add_all([other_farm, foreign_org])
        await session.flush()
        warehouses = {
            "shared": Warehouse(
                organization_id=seed["organization_id"],
                farm_id=None,
                name="A Shared Warehouse",
                code="SHARED",
                status=WarehouseStatus.ACTIVE,
            ),
            "maintenance": Warehouse(
                organization_id=seed["organization_id"],
                farm_id=seed["farm_id"],
                name="B Maintenance Warehouse",
                code="MAINT",
                status=WarehouseStatus.MAINTENANCE,
            ),
            "other_farm": Warehouse(
                organization_id=seed["organization_id"],
                farm_id=other_farm.id,
                name="Other Farm Warehouse",
                code="OTHER",
                status=WarehouseStatus.ACTIVE,
            ),
            "closed": Warehouse(
                organization_id=seed["organization_id"],
                farm_id=seed["farm_id"],
                name="Closed Warehouse",
                code="CLOSED",
                status=WarehouseStatus.CLOSED,
            ),
            "foreign": Warehouse(
                organization_id=foreign_org.id,
                farm_id=None,
                name="Foreign Warehouse",
                code="FOREIGN",
                status=WarehouseStatus.ACTIVE,
            ),
        }
        session.add_all(warehouses.values())
        await session.commit()
        return {name: warehouse.id for name, warehouse in warehouses.items()}


async def test_receipt_warehouse_discovery_filters_and_orders_candidates(client: AsyncClient):
    seed = await _seed(client)
    matrix = await _seed_receipt_warehouse_matrix(seed)
    response = await client.get(f"/api/v1/purchase-orders/{seed['po_id']}/receipt-warehouses")
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [row["name"] for row in rows] == [
        "A Shared Warehouse",
        "B Maintenance Warehouse",
        "Receipt Warehouse",
    ]
    ids = [row["id"] for row in rows]
    assert len(ids) == len(set(ids))
    assert str(matrix["shared"]) in ids
    assert str(matrix["maintenance"]) in ids
    assert str(matrix["other_farm"]) not in ids
    assert str(matrix["closed"]) not in ids
    assert str(matrix["foreign"]) not in ids
    assert set(rows[0]) == {"id", "farm_id", "name", "code"}


async def test_farm_scoped_creator_discovers_receipt_warehouses_without_org_wide_inventory_read(
    client: AsyncClient,
):
    seed = await _seed(client, role_name="farm_manager", farm_scoped=True)
    matrix = await _seed_receipt_warehouse_matrix(seed)
    organization_list = await client.get(
        f"/api/v1/organizations/{seed['organization_id']}/warehouses"
    )
    assert organization_list.status_code == 403

    response = await client.get(f"/api/v1/purchase-orders/{seed['po_id']}/receipt-warehouses")
    assert response.status_code == 200, response.text
    ids = {row["id"] for row in response.json()}
    assert str(seed["warehouse_id"]) in ids
    assert str(matrix["shared"]) in ids
    assert str(matrix["maintenance"]) in ids
    assert str(matrix["other_farm"]) not in ids


async def test_receipt_warehouse_discovery_requires_create_permission(client: AsyncClient):
    seed = await _seed(client)
    await _add_role_user(
        client,
        seed["organization_id"],
        "worker",
        farm_id=seed["farm_id"],
    )
    response = await client.get(f"/api/v1/purchase-orders/{seed['po_id']}/receipt-warehouses")
    assert response.status_code == 403
    assert response.json()["detail"] == {
        "code": "not_authorized",
        "message": "Not authorized.",
        "context": {"required": "purchase_receipt.create"},
    }


async def test_receipt_warehouse_discovery_hides_inaccessible_purchase_order(client: AsyncClient):
    inaccessible = await _seed(client)
    await _seed(client)
    response = await client.get(
        f"/api/v1/purchase-orders/{inaccessible['po_id']}/receipt-warehouses"
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_found"


async def test_create_exact_replay_response_and_single_side_effect(client: AsyncClient):
    seed = await _seed(client)
    created = await _post(client, seed)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["organization_id"] == str(seed["organization_id"])
    assert body["purchase_order_id"] == str(seed["po_id"])
    assert body["warehouse_id"] == str(seed["warehouse_id"])
    assert body["received_by_id"] == str(seed["actor_id"])
    assert body["lines"][0]["quantity"] == "2.000000"
    assert body["lines"][0]["quantity_canonical"] == "2.000000"
    assert body["lines"][0]["unit_price"] == "2.500000"
    assert "idempotency_key" not in body and "payload_hash" not in body

    before_replay = await _receipt_state(seed, "receipt-api-key")
    assert before_replay["receipt_ids"] == [UUID(body["id"])]
    assert before_replay["grns"] == [body["grn"]]
    assert before_replay["line_ids"] == [UUID(body["lines"][0]["id"])]
    assert before_replay["transaction_ids"] == [UUID(body["lines"][0]["inventory_transaction_id"])]
    assert before_replay["lot_ids"] == [UUID(body["lines"][0]["inventory_lot_id"])]
    assert before_replay["received_quantity"] == Decimal("2.000000")
    assert before_replay["received_quantity_canonical"] == Decimal("2.000000")
    assert len(before_replay["transition_ids"]) == 1
    assert len(before_replay["audit_ids"]) == 1

    replay = await _post(client, seed)
    assert replay.status_code == 200
    assert replay.headers["X-Idempotent-Replay"] == "true"
    assert replay.json() == body
    assert await _receipt_state(seed, "receipt-api-key") == before_replay


async def test_idempotency_and_request_validation_contract(client: AsyncClient):
    seed = await _seed(client)
    missing = await client.post(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts", json=_body(seed)
    )
    assert missing.status_code == 400
    assert missing.json()["detail"]["code"] == "idempotency_key_required"

    malformed = await _post(client, seed, key=" ")
    assert malformed.status_code == 400
    assert malformed.json()["detail"]["code"] == "idempotency_key_required"

    created = await _post(client, seed, key="payload-key")
    assert created.status_code == 201
    conflict = await _post(
        client, seed, key="payload-key", body=_body(seed, quantity="1.000000", lot="OTHER")
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "idempotency_key_payload_conflict"

    async with _db.AsyncSessionLocal() as session:
        original = await session.get(PurchaseOrder, seed["po_id"])
        second_po = PurchaseOrder(
            organization_id=original.organization_id,
            farm_id=original.farm_id,
            business_partner_id=original.business_partner_id,
            po_number=f"PO-2026-{uuid4().int % 999999:06d}",
            status=PurchaseOrderStatus.APPROVED,
            currency_code=original.currency_code,
            order_date=original.order_date,
            supplier_code=original.supplier_code,
            supplier_legal_name=original.supplier_legal_name,
            created_by_id=original.created_by_id,
            approved_by_id=original.approved_by_id,
            approved_at=original.approved_at,
            version=3,
        )
        session.add(second_po)
        await session.flush()
        second_line = PurchaseOrderLine(
            purchase_order_id=second_po.id,
            line_number=1,
            inventory_item_id=seed["item_id"],
            item_code="SECOND",
            item_name="Second",
            description="Second",
            ordered_quantity=Decimal("10.000000"),
            ordered_unit="kg",
            canonical_unit="kg",
            ordered_quantity_canonical=Decimal("10.000000"),
            received_quantity=Decimal("0.000000"),
            received_quantity_canonical=Decimal("0.000000"),
            unit_price=Decimal("2.500000"),
        )
        session.add(second_line)
        await session.commit()
    other_po_seed = {**seed, "po_id": second_po.id, "po_line_id": second_line.id}
    cross_po = await _post(client, other_po_seed, key="payload-key")
    assert cross_po.status_code == 409
    assert cross_po.json()["detail"]["code"] == "idempotency_key_payload_conflict"

    forbidden_field = {**_body(seed), "grn": "CLIENT-GRN"}
    assert (await _post(client, seed, key="extra", body=forbidden_field)).status_code == 422


@pytest.mark.parametrize("quantity", ["0", "-1", "1.0000001", 1.5, "not-a-number"])
async def test_invalid_quantity_uses_bounded_error_contract(client: AsyncClient, quantity: object):
    seed = await _seed(client)
    invalid = await _post(
        client,
        seed,
        key=f"invalid-quantity-{uuid4()}",
        body=_body(seed, quantity=quantity),
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"] == {
        "code": "invalid_quantity",
        "message": "Receipt quantity is invalid.",
        "context": {},
    }


@pytest.mark.parametrize(
    ("quantity", "mutate"),
    [
        ("0", lambda body: body.pop("warehouse_id")),
        ("1", lambda body: body.update({"quantity": "1.000000"})),
        ("1", lambda body: body.update({"unrelated": True})),
        ("0", lambda body: body["lines"][0].update({"unrelated": True})),
    ],
)
async def test_unrelated_or_mixed_validation_uses_normal_fastapi_response(
    client: AsyncClient, quantity: str, mutate
):
    seed = await _seed(client)
    body = _body(seed, quantity=quantity)
    mutate(body)
    response = await _post(client, seed, key=f"unrelated-validation-{uuid4()}", body=body)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], list)
    assert not any(
        isinstance(error, dict) and error.get("code") == "invalid_quantity"
        for error in response.json()["detail"]
    )


async def test_idempotency_header_boundaries(client: AsyncClient):
    seed = await _seed(client)
    oversized = await _post(client, seed, key="k" * 256)
    assert oversized.status_code == 400
    assert oversized.json()["detail"]["code"] == "idempotency_key_required"

    case_variant = await client.post(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        json=_body(seed, quantity="1.000000"),
        headers={"idempotency-key": "lower-case-header"},
    )
    assert case_variant.status_code == 201

    duplicate = await client.post(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        json=_body(seed, quantity="1.000000", lot="DUPLICATE-HEADER"),
        headers=[
            ("Idempotency-Key", "duplicate-a"),
            ("idempotency-key", "duplicate-b"),
        ],
    )
    assert duplicate.status_code == 400
    assert duplicate.json()["detail"]["code"] == "idempotency_key_required"


async def test_domain_errors_are_preserved_at_http_boundary(client: AsyncClient):
    draft = await _seed(client, po_status=PurchaseOrderStatus.DRAFT)
    invalid_state = await _post(client, draft)
    assert invalid_state.status_code == 409
    assert invalid_state.json()["detail"]["code"] == "purchase_order_not_receivable"

    exact = await _seed(
        client,
        ordered_quantity="0.002000",
        ordered_unit="g",
        ordered_canonical="0.000002",
    )
    lossy = await _post(client, exact, body=_body(exact, quantity="0.001500"))
    assert lossy.status_code == 409
    assert lossy.json()["detail"]["code"] == "canonical_quantity_not_representable"

    over = await _seed(client)
    over_response = await _post(client, over, body=_body(over, quantity="11.000000"))
    assert over_response.status_code == 409
    assert over_response.json()["detail"]["code"] == "purchase_order_over_receipt"

    closed = await _seed(client)
    async with _db.AsyncSessionLocal() as session:
        warehouse = await session.get(Warehouse, closed["warehouse_id"])
        warehouse.status = WarehouseStatus.CLOSED
        await session.commit()
    closed_response = await _post(client, closed)
    assert closed_response.status_code == 409
    assert closed_response.json()["detail"]["code"] == "warehouse_unavailable"

    mismatch = await _seed(client)
    async with _db.AsyncSessionLocal() as session:
        other_farm = Farm(
            organization_id=mismatch["organization_id"],
            name="Mismatch Farm",
            code=f"MF-{uuid4().hex[:8]}",
            is_active=True,
        )
        session.add(other_farm)
        await session.flush()
        other_warehouse = Warehouse(
            organization_id=mismatch["organization_id"],
            farm_id=other_farm.id,
            name="Mismatch Warehouse",
            code=f"MW-{uuid4().hex[:8]}",
            status=WarehouseStatus.ACTIVE,
        )
        session.add(other_warehouse)
        await session.commit()
    mismatch_body = _body(mismatch)
    mismatch_body["warehouse_id"] = str(other_warehouse.id)
    mismatch_response = await _post(client, mismatch, key="warehouse-mismatch", body=mismatch_body)
    assert mismatch_response.status_code == 409
    assert mismatch_response.json()["detail"]["code"] == "warehouse_farm_scope_mismatch"


async def test_list_detail_cursor_order_and_decimal_serialization(client: AsyncClient):
    seed = await _seed(client)
    receipt_ids = []
    for index, quantity in enumerate(("1.000000", "2.000000", "3.000000"), 1):
        response = await _post(
            client,
            seed,
            key=f"page-{index}",
            body=_body(seed, quantity=quantity, lot=f"PAGE-{index}"),
        )
        assert response.status_code == 201, response.text
        receipt_ids.append(response.json()["id"])

    first = await client.get(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts", params={"limit": 2}
    )
    assert first.status_code == 200
    assert len(first.json()["items"]) == 2
    assert first.json()["next_cursor"]
    second = await client.get(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        params={"cursor": first.json()["next_cursor"], "limit": 2},
    )
    assert len(second.json()["items"]) == 1
    listed = [item["id"] for item in first.json()["items"] + second.json()["items"]]
    assert listed == list(reversed(receipt_ids))

    detail = await client.get(f"/api/v1/purchase-receipts/{receipt_ids[0]}")
    assert detail.status_code == 200
    assert detail.json()["lines"][0]["line_number"] == 1
    assert detail.json()["lines"][0]["quantity"] == "1.000000"
    assert detail.json()["lines"][0]["unit_price"] == "2.500000"

    empty = await _seed(client)
    empty_page = await client.get(f"/api/v1/purchase-orders/{empty['po_id']}/receipts")
    assert empty_page.json() == {"items": [], "next_cursor": None}
    invalid = await client.get(
        f"/api/v1/purchase-orders/{empty['po_id']}/receipts", params={"cursor": "bad"}
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "invalid_cursor"
    for value, expected in [(200, 200), (0, 422), (-1, 422), (201, 422), ("many", 422)]:
        response = await client.get(
            f"/api/v1/purchase-orders/{empty['po_id']}/receipts", params={"limit": value}
        )
        assert response.status_code == expected

    valid_cursor = first.json()["next_cursor"]
    malformed_cursors = [
        base64.urlsafe_b64encode(
            b"2026-08-11T00:00:00|00000000-0000-0000-0000-000000000001"
        ).decode(),
        base64.urlsafe_b64encode(b"2026-08-11|00000000-0000-0000-0000-000000000001").decode(),
        base64.urlsafe_b64encode(b"2026-08-11T00:00:00+00:00|not-a-uuid").decode(),
        f"{valid_cursor}@",
        "***not-base64***",
    ]
    for malformed_cursor in malformed_cursors:
        malformed = await client.get(
            f"/api/v1/purchase-orders/{empty['po_id']}/receipts",
            params={"cursor": malformed_cursor},
        )
        assert malformed.status_code == 422
        assert malformed.json()["detail"] == {
            "code": "invalid_cursor",
            "message": "Malformed pagination cursor.",
            "context": {},
        }


async def test_default_page_limit_is_fifty(client: AsyncClient):
    seed = await _seed(client)
    created_at = datetime(2026, 8, 11, 18, 0, tzinfo=UTC)
    async with _db.AsyncSessionLocal() as session:
        session.add_all(
            [
                PurchaseReceipt(
                    organization_id=seed["organization_id"],
                    farm_id=seed["farm_id"],
                    purchase_order_id=seed["po_id"],
                    warehouse_id=seed["warehouse_id"],
                    grn=f"GRN-2026-{900000 + index:06d}",
                    received_at=created_at,
                    received_by_id=seed["actor_id"],
                    idempotency_key=f"default-page-{index}",
                    payload_hash=f"{index:064x}",
                    created_at=created_at,
                )
                for index in range(1, 52)
            ]
        )
        await session.commit()
    first = await client.get(f"/api/v1/purchase-orders/{seed['po_id']}/receipts")
    assert first.status_code == 200
    assert len(first.json()["items"]) == 50
    assert first.json()["next_cursor"] is not None
    second = await client.get(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        params={"cursor": first.json()["next_cursor"]},
    )
    assert second.status_code == 200
    assert len(second.json()["items"]) == 1


async def test_cursor_uses_uuid_tie_breaker(client: AsyncClient):
    seed = await _seed(client)
    shared_time = datetime(2026, 8, 11, 15, 0, tzinfo=UTC)
    ids = [UUID(int=100), UUID(int=200), UUID(int=300)]
    async with _db.AsyncSessionLocal() as session:
        session.add_all(
            [
                PurchaseReceipt(
                    id=receipt_id,
                    organization_id=seed["organization_id"],
                    farm_id=seed["farm_id"],
                    purchase_order_id=seed["po_id"],
                    warehouse_id=seed["warehouse_id"],
                    grn=f"GRN-2026-{index:06d}",
                    received_at=shared_time,
                    received_by_id=seed["actor_id"],
                    idempotency_key=f"tie-{index}",
                    payload_hash=f"{index:x}" * 64,
                    created_at=shared_time,
                )
                for index, receipt_id in enumerate(ids, 1)
            ]
        )
        await session.commit()
    first = await client.get(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts", params={"limit": 2}
    )
    second = await client.get(
        f"/api/v1/purchase-orders/{seed['po_id']}/receipts",
        params={"limit": 2, "cursor": first.json()["next_cursor"]},
    )
    assert [row["id"] for row in first.json()["items"]] == [str(ids[2]), str(ids[1])]
    assert [row["id"] for row in second.json()["items"]] == [str(ids[0])]


async def test_detail_lines_follow_immutable_line_number_order(client: AsyncClient):
    seed = await _seed(client)
    async with _db.AsyncSessionLocal() as session:
        item = InventoryItem(
            organization_id=seed["organization_id"],
            code=f"ITEM-{uuid4().hex[:8]}",
            name="Second Receipt Item",
            category=InventoryItemCategory.FEED,
            canonical_unit=StockUnit.KG,
            is_active=True,
        )
        session.add(item)
        await session.flush()
        second_line = PurchaseOrderLine(
            purchase_order_id=seed["po_id"],
            line_number=2,
            inventory_item_id=item.id,
            item_code=item.code,
            item_name=item.name,
            description=item.name,
            ordered_quantity=Decimal("10.000000"),
            ordered_unit="kg",
            canonical_unit="kg",
            ordered_quantity_canonical=Decimal("10.000000"),
            received_quantity=Decimal("0.000000"),
            received_quantity_canonical=Decimal("0.000000"),
            unit_price=Decimal("4.000000"),
        )
        session.add(second_line)
        await session.commit()
    body = _body(seed, quantity="1.000000", lot="FIRST-COMMAND")
    body["lines"].insert(
        0,
        {
            "purchase_order_line_id": str(second_line.id),
            "lot_code": "SECOND-COMMAND",
            "quantity": "2.000000",
        },
    )
    created = await _post(client, seed, key="line-order", body=body)
    assert created.status_code == 201, created.text
    receipt_id = created.json()["id"]
    detail = await client.get(f"/api/v1/purchase-receipts/{receipt_id}")
    assert detail.status_code == 200
    assert [line["line_number"] for line in detail.json()["lines"]] == [1, 2]
    assert [line["purchase_order_line_id"] for line in detail.json()["lines"]] == [
        str(second_line.id),
        str(seed["po_line_id"]),
    ]


async def test_read_roles_create_denial_and_farm_scope(client: AsyncClient):
    owner = await _seed(client)
    receipt = await _post(client, owner)
    assert receipt.status_code == 201

    await _add_role_user(client, owner["organization_id"], "viewer")
    assert (
        await client.get(f"/api/v1/purchase-receipts/{receipt.json()['id']}")
    ).status_code == 200
    assert (
        await client.get(f"/api/v1/purchase-orders/{owner['po_id']}/receipts")
    ).status_code == 200
    viewer_denied = await _post(client, owner, key="viewer-denied")
    assert viewer_denied.status_code == 403
    assert viewer_denied.json()["detail"]["code"] == "not_authorized"

    viewer = await _seed(client, role_name="viewer")
    denied = await _post(client, viewer)
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "not_authorized"

    farm_manager = await _seed(client, role_name="farm_manager", farm_scoped=True)
    allowed = await _post(client, farm_manager)
    assert allowed.status_code == 201, allowed.text
    assert (
        await client.get(f"/api/v1/purchase-receipts/{allowed.json()['id']}")
    ).status_code == 200
    assert (
        await client.get(f"/api/v1/purchase-orders/{farm_manager['po_id']}/receipts")
    ).status_code == 200

    hidden_owner_receipt = await client.get(f"/api/v1/purchase-receipts/{receipt.json()['id']}")
    missing = await client.get(f"/api/v1/purchase-receipts/{uuid4()}")
    assert hidden_owner_receipt.status_code == missing.status_code == 404
    assert hidden_owner_receipt.json() == missing.json()


async def test_same_organization_other_farm_is_hidden(client: AsyncClient):
    owner = await _seed(client)
    receipt = await _post(client, owner)
    assert receipt.status_code == 201
    async with _db.AsyncSessionLocal() as session:
        other_farm = Farm(
            organization_id=owner["organization_id"],
            name="Other Farm",
            code=f"OF-{uuid4().hex[:8]}",
            is_active=True,
        )
        session.add(other_farm)
        await session.flush()
        other_warehouse = Warehouse(
            organization_id=owner["organization_id"],
            farm_id=other_farm.id,
            name="Other Warehouse",
            code=f"OW-{uuid4().hex[:8]}",
            status=WarehouseStatus.ACTIVE,
        )
        session.add(other_warehouse)
        await session.commit()
    await _add_role_user(client, owner["organization_id"], "farm_manager", farm_id=other_farm.id)
    hidden_detail, hidden_sql = await _get_with_sql(
        client, f"/api/v1/purchase-receipts/{receipt.json()['id']}"
    )
    nonexistent, missing_sql = await _get_with_sql(client, f"/api/v1/purchase-receipts/{uuid4()}")
    assert hidden_detail.status_code == nonexistent.status_code == 404
    assert hidden_detail.json() == nonexistent.json()
    assert not any("purchase_receipt_lines" in statement for statement in hidden_sql)
    assert not any("purchase_receipt_lines" in statement for statement in missing_sql)
    assert any(
        "purchase_receipts.organization_id" in statement
        and "purchase_receipts.farm_id" in statement
        for statement in hidden_sql
    )
    hidden_list = await client.get(f"/api/v1/purchase-orders/{owner['po_id']}/receipts")
    assert hidden_list.status_code == 404

    await _add_role_user(client, owner["organization_id"], "farm_manager", farm_id=owner["farm_id"])
    probe = _body(owner)
    probe["warehouse_id"] = str(other_warehouse.id)
    hidden_warehouse = await _post(client, owner, key="farm-hidden", body=probe)
    missing_probe = _body(owner)
    missing_probe["warehouse_id"] = str(uuid4())
    missing_warehouse = await _post(client, owner, key="farm-missing", body=missing_probe)
    assert hidden_warehouse.status_code == missing_warehouse.status_code == 404
    assert hidden_warehouse.json() == missing_warehouse.json()


async def test_hidden_po_warehouse_and_cross_tenant_receipt_are_indistinguishable(
    client: AsyncClient,
):
    foreign = await _seed(client)
    foreign_receipt = await _post(client, foreign)
    assert foreign_receipt.status_code == 201
    local = await _seed(client, role_name="farm_manager", farm_scoped=True)

    hidden_po, hidden_po_sql = await _post_with_sql(
        client, {**local, "po_id": foreign["po_id"]}, key="hidden-po"
    )
    missing_po, missing_po_sql = await _post_with_sql(
        client, {**local, "po_id": uuid4()}, key="missing-po"
    )
    assert hidden_po.status_code == missing_po.status_code == 404
    assert hidden_po.json() == missing_po.json()
    assert not any("purchase_order_lines" in statement for statement in hidden_po_sql)
    assert not any("purchase_order_lines" in statement for statement in missing_po_sql)
    assert any(
        "purchase_orders.organization_id" in statement and "purchase_orders.farm_id" in statement
        for statement in hidden_po_sql
    )

    hidden_warehouse_body = _body(local)
    hidden_warehouse_body["warehouse_id"] = str(foreign["warehouse_id"])
    hidden_warehouse = await _post(
        client, local, key="hidden-warehouse", body=hidden_warehouse_body
    )
    missing_warehouse_body = _body(local)
    missing_warehouse_body["warehouse_id"] = str(uuid4())
    missing_warehouse = await _post(
        client, local, key="missing-warehouse", body=missing_warehouse_body
    )
    assert hidden_warehouse.status_code == missing_warehouse.status_code == 404
    assert hidden_warehouse.json() == missing_warehouse.json()

    foreign_detail, foreign_sql = await _get_with_sql(
        client, f"/api/v1/purchase-receipts/{foreign_receipt.json()['id']}"
    )
    nonexistent_detail, nonexistent_sql = await _get_with_sql(
        client, f"/api/v1/purchase-receipts/{uuid4()}"
    )
    assert foreign_detail.status_code == nonexistent_detail.status_code == 404
    assert foreign_detail.json() == nonexistent_detail.json()
    assert not any("purchase_receipt_lines" in statement for statement in foreign_sql)
    assert not any("purchase_receipt_lines" in statement for statement in nonexistent_sql)
    assert any(
        "purchase_receipts.organization_id" in statement
        and "purchase_receipts.farm_id" in statement
        for statement in foreign_sql
    )
