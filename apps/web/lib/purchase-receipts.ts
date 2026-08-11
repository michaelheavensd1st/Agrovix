import { apiFetch, apiFetchResult } from '@/lib/api';

export interface PurchaseReceiptLineInput {
  purchase_order_line_id: string;
  lot_code: string;
  quantity: string;
  storage_location_id?: string | null;
  expiry_date?: string | null;
}

export interface PurchaseReceiptInput {
  warehouse_id: string;
  supplier_delivery_reference?: string | null;
  received_at?: string | null;
  notes?: string | null;
  lines: PurchaseReceiptLineInput[];
}

export interface PurchaseReceiptLine {
  id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  line_number: number;
  quantity: string;
  quantity_canonical: string;
  ordered_unit: string;
  canonical_unit: string;
  unit_price: string;
  currency_code: string;
  lot_code: string;
  expiry_date: string | null;
  storage_location_id: string | null;
  inventory_lot_id: string;
  inventory_transaction_id: string;
  created_at: string;
}

export interface PurchaseReceipt {
  id: string;
  organization_id: string;
  purchase_order_id: string;
  farm_id: string | null;
  warehouse_id: string;
  grn: string;
  supplier_delivery_reference: string | null;
  received_at: string;
  received_by_id: string;
  notes: string | null;
  created_at: string;
  lines: PurchaseReceiptLine[];
}

export interface PurchaseReceiptPage {
  items: PurchaseReceipt[];
  next_cursor: string | null;
}

export interface WarehouseOption {
  id: string;
  farm_id: string | null;
  code: string;
  name: string;
}

export interface StorageLocationOption {
  id: string;
  warehouse_id: string;
  name: string;
  code: string;
  deleted_at: string | null;
}

export async function listPurchaseReceipts(
  purchaseOrderId: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<PurchaseReceiptPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  query.set('limit', String(Math.min(200, Math.max(1, options.limit ?? 50))));
  return apiFetch(`/v1/purchase-orders/${purchaseOrderId}/receipts?${query.toString()}`, {
    signal: options.signal,
  });
}

export async function getPurchaseReceipt(
  receiptId: string,
  signal?: AbortSignal,
): Promise<PurchaseReceipt> {
  return apiFetch(`/v1/purchase-receipts/${receiptId}`, { signal });
}

export async function createPurchaseReceipt(
  purchaseOrderId: string,
  payload: PurchaseReceiptInput,
  idempotencyKey: string,
): Promise<{ receipt: PurchaseReceipt; replayed: boolean }> {
  const result = await apiFetchResult<PurchaseReceipt>(
    `/v1/purchase-orders/${purchaseOrderId}/receipts`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    },
  );
  return {
    receipt: result.data,
    replayed:
      result.response.status === 200 &&
      result.response.headers.get('X-Idempotent-Replay') === 'true',
  };
}

export function listReceiptWarehouses(
  purchaseOrderId: string,
  signal?: AbortSignal,
): Promise<WarehouseOption[]> {
  return apiFetch(`/v1/purchase-orders/${purchaseOrderId}/receipt-warehouses`, { signal });
}

export function listReceiptStorageLocations(
  warehouseId: string,
  signal?: AbortSignal,
): Promise<StorageLocationOption[]> {
  return apiFetch(`/v1/warehouses/${warehouseId}/storage-locations`, { signal });
}
