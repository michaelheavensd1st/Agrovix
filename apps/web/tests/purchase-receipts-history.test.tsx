import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseReceiptHistory } from '@/components/purchase-orders/PurchaseReceiptHistory';
import type { PurchaseOrder } from '@/lib/purchase-orders';

const navigationMocks = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => navigationMocks.router, usePathname: () => '/purchase-orders/po-1' }));

const receiptMocks = vi.hoisted(() => ({ get: vi.fn(), locations: vi.fn() }));
vi.mock('@/lib/purchase-receipts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/purchase-receipts')>('@/lib/purchase-receipts');
  return { ...actual, getPurchaseReceipt: receiptMocks.get, listReceiptStorageLocations: receiptMocks.locations };
});

const PO = { id: 'po-1', organization_id: 'org-1', farm_id: null, lines: [{ id: 'line-1', line_number: 1, item_name: 'Feed' }] } as PurchaseOrder;
const RECEIPT = { id: 'r-1', organization_id: 'org-1', purchase_order_id: 'po-1', farm_id: null, warehouse_id: 'wh-1', grn: 'GRN-2026-000001', supplier_delivery_reference: 'DEL-1', received_at: '2026-08-11T10:00:00Z', received_by_id: 'user-1', notes: 'Checked', created_at: '2026-08-11T10:00:01Z', lines: [{ id: 'rl-1', purchase_order_line_id: 'line-1', inventory_item_id: 'item-1', line_number: 1, quantity: '0.000001', quantity_canonical: '0.000001', ordered_unit: 'kg', canonical_unit: 'kg', unit_price: '2.500000', currency_code: 'USD', lot_code: 'LOT-1', expiry_date: null, storage_location_id: null, inventory_lot_id: 'lot-1', inventory_transaction_id: 'tx-1', created_at: '2026-08-11T10:00:01Z' }] };

const props = { purchaseOrder: PO, warehouseLabels: new Map([['wh-1', 'Main (MAIN)']]), locationLabels: new Map<string, string>(), currentUserId: 'user-1', loading: false, error: null, nextCursor: null, canGoBack: false, navigationPending: false, onNext: vi.fn(), onPrevious: vi.fn() };

describe('PurchaseReceiptHistory', () => {
  beforeEach(() => { receiptMocks.get.mockResolvedValue(RECEIPT); receiptMocks.locations.mockResolvedValue([]); });
  it('renders its empty state', () => { render(<PurchaseReceiptHistory {...props} receipts={[]} />); expect(screen.getByText('No receipts yet')).toBeInTheDocument(); });
  it('loads immutable receipt detail with exact quantities', async () => {
    render(<PurchaseReceiptHistory {...props} receipts={[RECEIPT]} />);
    fireEvent.click(screen.getByRole('button', { name: /GRN-2026-000001/i }));
    await waitFor(() => expect(screen.getByTestId('receipt-detail')).toHaveTextContent('0.000001 kg'));
    expect(screen.getByTestId('receipt-detail')).toHaveTextContent('Feed');
    expect(screen.getByTestId('receipt-detail')).toHaveTextContent('You');
  });
  it('uses cursor navigation callbacks', () => { const next = vi.fn(); render(<PurchaseReceiptHistory {...props} receipts={[RECEIPT]} nextCursor="opaque" onNext={next} />); fireEvent.click(screen.getByRole('button', { name: 'Next' })); expect(next).toHaveBeenCalledOnce(); });
  it('discards receipt detail whose tenant identity does not match the current PO', async () => {
    receiptMocks.get.mockResolvedValue({ ...RECEIPT, organization_id: 'org-other' });
    render(<PurchaseReceiptHistory {...props} receipts={[RECEIPT]} />);
    fireEvent.click(screen.getByRole('button', { name: /GRN-2026-000001/i }));
    await waitFor(() => expect(receiptMocks.get).toHaveBeenCalled());
    expect(screen.getByTestId('receipt-detail')).not.toHaveTextContent('0.000001 kg');
  });
  it('keeps a hidden 404 generic', async () => {
    const { ApiError } = await import('@/lib/api');
    receiptMocks.get.mockRejectedValue(new ApiError(404, { detail: { code: 'not_found', message: 'foreign receipt exists' } } as never));
    render(<PurchaseReceiptHistory {...props} receipts={[RECEIPT]} />);
    fireEvent.click(screen.getByRole('button', { name: /GRN-2026-000001/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('receipt is unavailable');
    expect(screen.queryByText(/foreign receipt exists/)).not.toBeInTheDocument();
  });
});
