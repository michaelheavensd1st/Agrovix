import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), apiFetchResult: vi.fn() }));

import { apiFetch, apiFetchResult } from '@/lib/api';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  listPurchaseOrderTransitions,
  purchaseOrderListPath,
  rejectPurchaseOrder,
  revisePurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
  withdrawPurchaseOrder,
} from '@/lib/purchase-orders';

const mockedApiFetch = vi.mocked(apiFetch);
const mockedApiFetchResult = vi.mocked(apiFetchResult);

describe('Purchase Order API client', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetchResult.mockReset();
    mockedApiFetch.mockResolvedValue({} as never);
    mockedApiFetchResult.mockResolvedValue({
      data: {} as never,
      response: new Response('{}', { headers: { 'content-type': 'application/json' } }),
    });
  });

  it('builds all list filters with repeated status values and an opaque cursor', () => {
    const path = purchaseOrderListPath({
      organizationId: 'org-1',
      farmId: 'farm-1',
      businessPartnerId: 'supplier-1',
      statuses: ['DRAFT', 'APPROVED'],
      orderDateFrom: '2026-01-01',
      orderDateTo: '2026-01-31',
      expectedDeliveryFrom: '2026-02-01',
      expectedDeliveryTo: '2026-02-28',
      search: 'ACME / ref',
      cursor: 'opaque+/=cursor',
      limit: 999,
    });
    const url = new URL(path, 'https://example.test');
    expect(url.pathname).toBe('/v1/organizations/org-1/purchase-orders');
    expect(url.searchParams.getAll('status')).toEqual(['DRAFT', 'APPROVED']);
    expect(url.searchParams.get('cursor')).toBe('opaque+/=cursor');
    expect(url.searchParams.get('business_partner_id')).toBe('supplier-1');
    expect(url.searchParams.get('search')).toBe('ACME / ref');
    expect(url.searchParams.get('limit')).toBe('200');
  });

  it('maps read operations to the published routes', async () => {
    await listPurchaseOrders({ organizationId: 'org-1' });
    await getPurchaseOrder('po-1');
    await listPurchaseOrderTransitions('po-1', { cursor: 'next-token', limit: 25 });
    expect(mockedApiFetch.mock.calls[0][0]).toBe(
      '/v1/organizations/org-1/purchase-orders?limit=50',
    );
    expect(mockedApiFetch.mock.calls[1][0]).toBe('/v1/purchase-orders/po-1');
    expect(mockedApiFetch.mock.calls[2][0]).toBe(
      '/v1/purchase-orders/po-1/transitions?cursor=next-token&limit=25',
    );
  });

  it('maps create and update without changing Decimal strings', async () => {
    await createPurchaseOrder('org-1', {
      business_partner_id: 'bp-1',
      currency_code: 'USD',
      order_date: '2026-01-01',
      lines: [
        {
          inventory_item_id: 'item-1',
          ordered_quantity: '999999999999.999999',
          ordered_unit: 'kg',
          unit_price: '99999999999999.999999',
        },
      ],
    });
    await updatePurchaseOrder('po-1', {
      expected_version: 3,
      supplier_reference: null,
    });
    expect(mockedApiFetch.mock.calls[0][0]).toBe('/v1/organizations/org-1/purchase-orders');
    expect(JSON.parse(String(mockedApiFetch.mock.calls[0][1]?.body))).toMatchObject({
      lines: [
        {
          ordered_quantity: '999999999999.999999',
          unit_price: '99999999999999.999999',
        },
      ],
    });
    expect(mockedApiFetch.mock.calls[1]).toEqual([
      '/v1/purchase-orders/po-1',
      { method: 'PATCH', body: JSON.stringify({ expected_version: 3, supplier_reference: null }) },
    ]);
  });

  it('maps all six lifecycle operations and preserves replay headers', async () => {
    mockedApiFetchResult.mockResolvedValue({
      data: { id: 'po-1' } as never,
      response: new Response('{}', { headers: { 'X-Idempotent-Replay': 'true' } }),
    });
    const results = await Promise.all([
      submitPurchaseOrder('po-1'),
      withdrawPurchaseOrder('po-1', 'withdraw reason'),
      approvePurchaseOrder('po-1', 'approval note'),
      rejectPurchaseOrder('po-1', 'reject reason'),
      revisePurchaseOrder('po-1', 'revise reason'),
      cancelPurchaseOrder('po-1', 'cancel reason'),
    ]);
    expect(mockedApiFetchResult.mock.calls.map(([path]) => path)).toEqual([
      '/v1/purchase-orders/po-1/submit',
      '/v1/purchase-orders/po-1/withdraw',
      '/v1/purchase-orders/po-1/approve',
      '/v1/purchase-orders/po-1/reject',
      '/v1/purchase-orders/po-1/revise',
      '/v1/purchase-orders/po-1/cancel',
    ]);
    expect(results.every((result) => result.replayed)).toBe(true);
    expect(mockedApiFetchResult.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
    expect(new Headers(mockedApiFetchResult.mock.calls[0][1]?.headers).has('Idempotency-Key')).toBe(
      false,
    );
  });
});
