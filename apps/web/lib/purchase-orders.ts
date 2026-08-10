import { apiFetch, apiFetchResult } from '@/lib/api';

export type UUID = string;
export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED'
  | 'CANCELLED_WITH_RECEIPTS';

export const PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
  'CANCELLED_WITH_RECEIPTS',
];

export interface DeliveryAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
}

export interface DeliveryAddressInput {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
}

export interface PurchaseOrderLine {
  id: UUID;
  line_number: number;
  inventory_item_id: UUID;
  item_code: string;
  item_name: string;
  item_sku: string | null;
  description: string;
  line_note: string | null;
  ordered_quantity: string;
  ordered_unit: string;
  canonical_unit: string;
  ordered_quantity_canonical: string;
  received_quantity: string;
  received_quantity_canonical: string;
  unit_price: string;
  extended_amount: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: UUID;
  organization_id: UUID;
  farm_id: UUID | null;
  business_partner_id: UUID;
  po_number: string;
  supplier_reference: string | null;
  status: PurchaseOrderStatus;
  currency_code: string;
  order_date: string;
  expected_delivery_date: string | null;
  delivery_address: DeliveryAddress | null;
  notes: string | null;
  supplier_code: string;
  supplier_legal_name: string;
  supplier_trading_name: string | null;
  version: number;
  created_by_id: UUID;
  submitted_by_id: UUID | null;
  submitted_at: string | null;
  approved_by_id: UUID | null;
  approved_at: string | null;
  rejected_by_id: UUID | null;
  rejected_at: string | null;
  cancelled_by_id: UUID | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  subtotal: string;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrderPage {
  items: PurchaseOrder[];
  next_cursor: string | null;
}

export interface PurchaseOrderTransition {
  id: UUID;
  purchase_order_id: UUID;
  actor_id: UUID;
  from_status: PurchaseOrderStatus | null;
  to_status: PurchaseOrderStatus;
  operation: string;
  reason: string | null;
  occurred_at: string;
}

export interface PurchaseOrderTransitionPage {
  items: PurchaseOrderTransition[];
  next_cursor: string | null;
}

export interface PurchaseOrderLineInput {
  inventory_item_id: UUID;
  ordered_quantity: string;
  ordered_unit: string;
  unit_price: string;
  description?: string | null;
  line_note?: string | null;
}

export interface PurchaseOrderUpdateLineInput extends PurchaseOrderLineInput {
  id?: UUID;
}

export interface CreatePurchaseOrderBody {
  business_partner_id: UUID;
  currency_code: string;
  order_date: string;
  expected_delivery_date?: string | null;
  delivery_address?: DeliveryAddressInput | null;
  supplier_reference?: string | null;
  notes?: string | null;
  farm_id?: UUID | null;
  lines?: PurchaseOrderLineInput[];
}

export interface UpdatePurchaseOrderBody {
  expected_version: number;
  business_partner_id?: UUID;
  currency_code?: string;
  order_date?: string;
  expected_delivery_date?: string | null;
  delivery_address?: DeliveryAddressInput | null;
  supplier_reference?: string | null;
  notes?: string | null;
  farm_id?: UUID | null;
  lines?: PurchaseOrderUpdateLineInput[];
}

export interface ListPurchaseOrdersParams {
  organizationId: UUID;
  farmId?: UUID;
  businessPartnerId?: UUID;
  statuses?: readonly PurchaseOrderStatus[];
  orderDateFrom?: string;
  orderDateTo?: string;
  expectedDeliveryFrom?: string;
  expectedDeliveryTo?: string;
  search?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function purchaseOrderListPath(params: ListPurchaseOrdersParams): string {
  const query = new URLSearchParams();
  if (params.farmId) query.set('farm_id', params.farmId);
  if (params.businessPartnerId) query.set('business_partner_id', params.businessPartnerId);
  for (const status of params.statuses ?? []) query.append('status', status);
  if (params.orderDateFrom) query.set('order_date_from', params.orderDateFrom);
  if (params.orderDateTo) query.set('order_date_to', params.orderDateTo);
  if (params.expectedDeliveryFrom) query.set('expected_delivery_from', params.expectedDeliveryFrom);
  if (params.expectedDeliveryTo) query.set('expected_delivery_to', params.expectedDeliveryTo);
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  query.set('limit', String(limit));
  return `/v1/organizations/${params.organizationId}/purchase-orders?${query.toString()}`;
}

export async function listPurchaseOrders(
  params: ListPurchaseOrdersParams,
): Promise<PurchaseOrderPage> {
  return apiFetch<PurchaseOrderPage>(purchaseOrderListPath(params), { signal: params.signal });
}

export async function createPurchaseOrder(
  organizationId: UUID,
  body: CreatePurchaseOrderBody,
): Promise<PurchaseOrder> {
  return apiFetch<PurchaseOrder>(`/v1/organizations/${organizationId}/purchase-orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getPurchaseOrder(id: UUID, signal?: AbortSignal): Promise<PurchaseOrder> {
  return apiFetch<PurchaseOrder>(`/v1/purchase-orders/${id}`, { signal });
}

export async function updatePurchaseOrder(
  id: UUID,
  body: UpdatePurchaseOrderBody,
): Promise<PurchaseOrder> {
  return apiFetch<PurchaseOrder>(`/v1/purchase-orders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export interface LifecycleResponse {
  purchaseOrder: PurchaseOrder;
  replayed: boolean;
}

async function lifecycleRequest(
  id: UUID,
  operation: 'submit' | 'withdraw' | 'approve' | 'reject' | 'revise' | 'cancel',
  body?: { reason?: string },
): Promise<LifecycleResponse> {
  const result = await apiFetchResult<PurchaseOrder>(`/v1/purchase-orders/${id}/${operation}`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    purchaseOrder: result.data,
    replayed: result.response.headers.get('X-Idempotent-Replay') === 'true',
  };
}

export async function submitPurchaseOrder(id: UUID): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'submit');
}

export async function withdrawPurchaseOrder(id: UUID, reason: string): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'withdraw', { reason });
}

export async function approvePurchaseOrder(id: UUID, reason?: string): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'approve', reason === undefined ? undefined : { reason });
}

export async function rejectPurchaseOrder(id: UUID, reason: string): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'reject', { reason });
}

export async function revisePurchaseOrder(id: UUID, reason: string): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'revise', { reason });
}

export async function cancelPurchaseOrder(id: UUID, reason: string): Promise<LifecycleResponse> {
  return lifecycleRequest(id, 'cancel', { reason });
}

export async function listPurchaseOrderTransitions(
  id: UUID,
  params: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<PurchaseOrderTransitionPage> {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  query.set('limit', String(Math.min(200, Math.max(1, params.limit ?? 50))));
  return apiFetch<PurchaseOrderTransitionPage>(
    `/v1/purchase-orders/${id}/transitions?${query.toString()}`,
    { signal: params.signal },
  );
}
