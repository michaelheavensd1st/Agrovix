import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), apiFetchResult: vi.fn() }));
import { apiFetch, apiFetchResult } from '@/lib/api';
import { createPurchaseReceipt, getPurchaseReceipt, listPurchaseReceipts } from '@/lib/purchase-receipts';

describe('Purchase Receipt API client', () => {
  beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetchResult).mockReset(); });

  it('passes opaque cursor and bounded limit to history', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [], next_cursor: null } as never);
    await listPurchaseReceipts('po-1', { cursor: 'opaque+/=', limit: 999 });
    const url = new URL(String(vi.mocked(apiFetch).mock.calls[0][0]), 'https://example.test');
    expect(url.pathname).toBe('/v1/purchase-orders/po-1/receipts');
    expect(url.searchParams.get('cursor')).toBe('opaque+/=');
    expect(url.searchParams.get('limit')).toBe('200');
    await getPurchaseReceipt('receipt-1');
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe('/v1/purchase-receipts/receipt-1');
  });

  it('preserves exact payload strings, line order and idempotency key', async () => {
    vi.mocked(apiFetchResult).mockResolvedValue({ data: { id: 'r-1' }, response: new Response('{}', { status: 201 }) } as never);
    const payload = { warehouse_id: 'wh-1', lines: [
      { purchase_order_line_id: 'line-2', lot_code: 'B', quantity: '999999999999.999999' },
      { purchase_order_line_id: 'line-1', lot_code: 'A', quantity: '0.000001' },
    ] };
    const result = await createPurchaseReceipt('po-1', payload, 'stable-key');
    const [, init] = vi.mocked(apiFetchResult).mock.calls[0];
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('stable-key');
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(result.replayed).toBe(false);
  });

  it('distinguishes an exact 200 replay', async () => {
    vi.mocked(apiFetchResult).mockResolvedValue({ data: { id: 'r-1' }, response: new Response('{}', { status: 200, headers: { 'X-Idempotent-Replay': 'true' } }) } as never);
    expect((await createPurchaseReceipt('po-1', { warehouse_id: 'wh', lines: [] }, 'key')).replayed).toBe(true);
  });
});
