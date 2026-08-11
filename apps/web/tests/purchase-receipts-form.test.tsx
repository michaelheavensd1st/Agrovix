import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { PurchaseReceiptForm } from '@/components/purchase-orders/PurchaseReceiptForm';
import type { PurchaseOrder } from '@/lib/purchase-orders';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  warehouses: vi.fn(),
  locations: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/purchase-orders/po-1',
}));
vi.mock('@/lib/purchase-receipts', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/purchase-receipts')>('@/lib/purchase-receipts');
  return {
    ...actual,
    createPurchaseReceipt: mocks.create,
    listReceiptWarehouses: mocks.warehouses,
    listReceiptStorageLocations: mocks.locations,
  };
});

const PO = {
  id: 'po-1',
  organization_id: 'org-1',
  farm_id: 'farm-1',
  po_number: 'PO-1',
  lines: [
    {
      id: 'line-1',
      line_number: 1,
      item_name: 'Feed',
      ordered_quantity: '10.000000',
      received_quantity: '2.000000',
      ordered_unit: 'kg',
    },
  ],
} as PurchaseOrder;
const PO_TWO = { ...PO, id: 'po-2', organization_id: 'org-2', farm_id: null, po_number: 'PO-2' };
const WH_A = {
  id: 'wh-a',
  organization_id: 'org-1',
  farm_id: 'farm-1',
  code: 'A',
  name: 'Warehouse A',
  status: 'active',
};
const WH_B = {
  id: 'wh-b',
  organization_id: 'org-1',
  farm_id: 'farm-1',
  code: 'B',
  name: 'Warehouse B',
  status: 'active',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderForm(overrides: Partial<React.ComponentProps<typeof PurchaseReceiptForm>> = {}) {
  const props = {
    purchaseOrder: PO,
    open: true,
    onClose: vi.fn(),
    onCompleted: vi.fn(),
    onAuthoritativeFailure: vi.fn(),
    ...overrides,
  };
  return { ...render(<PurchaseReceiptForm {...props} />), props };
}

async function fill(warehouse = 'wh-a', quantity = '0.000001', lot = ' LOT-1 ') {
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Warehouse A/ })).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: warehouse } });
  fireEvent.click(screen.getByLabelText(/1. Feed/));
  fireEvent.change(screen.getByLabelText('Quantity (kg)'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('Lot code'), { target: { value: lot } });
}

describe('PurchaseReceiptForm adversarial behavior', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.warehouses.mockReset();
    mocks.locations.mockReset();
    mocks.push.mockReset();
    mocks.warehouses.mockResolvedValue([WH_A, WH_B]);
    mocks.locations.mockResolvedValue([]);
  });

  it('generates one UUID and one POST for two synchronous submit events', async () => {
    const posted = deferred<{ receipt: object; replayed: boolean }>();
    mocks.create.mockReturnValue(posted.promise);
    const randomUUID = vi.fn(() => 'only-key');
    vi.stubGlobal('crypto', { randomUUID });
    const { props } = renderForm();
    await fill();
    const submit = screen.getByRole('button', { name: 'Post receipt' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    posted.resolve({ receipt: {}, replayed: false });
    await waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith(false));
  });

  it('retries uncertainty with the identical frozen payload and key', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'stable-key') });
    mocks.create
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({ receipt: {}, replayed: true });
    const { props } = renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await screen.findByRole('button', { name: 'Retry same receipt' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    const frozenPayload = mocks.create.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: 'Retry same receipt' }));
    await waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith(true));
    expect(mocks.create.mock.calls[1][1]).toBe(frozenPayload);
    expect(mocks.create.mock.calls[1][2]).toBe('stable-key');
  });

  it.each([
    [502, true],
    [503, false],
    [504, true],
  ])('treats HTTP %s as uncertain and retries the identical attempt', async (status, replayed) => {
    const randomUUID = vi.fn(() => `gateway-key-${status}`);
    vi.stubGlobal('crypto', { randomUUID });
    mocks.create
      .mockRejectedValueOnce(new ApiError(status, { detail: 'gateway failure' }))
      .mockResolvedValueOnce({ receipt: {}, replayed });
    const { props } = renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await screen.findByRole('button', { name: 'Retry same receipt' });

    const firstPayload = mocks.create.mock.calls[0][1];
    const firstSerializedBody = JSON.stringify(firstPayload);
    expect(screen.getByLabelText('Warehouse')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same receipt' }));
    await waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith(replayed));

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[1][1]).toBe(firstPayload);
    expect(JSON.stringify(mocks.create.mock.calls[1][1])).toBe(firstSerializedBody);
    expect(mocks.create.mock.calls[1][2]).toBe(`gateway-key-${status}`);
  });

  it.each([
    [400, 'idempotency_key_required'],
    [409, 'purchase_order_over_receipt'],
    [422, 'invalid_quantity'],
  ])('keeps HTTP %s %s definitive', async (status, code) => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'definitive-key') });
    mocks.create.mockRejectedValue(new ApiError(status, { detail: { code } } as never));
    renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post receipt' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Retry same receipt' })).not.toBeInTheDocument();
  });

  it('discards a stale warehouse response after PO context changes', async () => {
    const oldRequest = deferred<(typeof WH_A)[]>();
    mocks.warehouses.mockImplementation((po: string) =>
      po === 'po-1'
        ? oldRequest.promise
        : Promise.resolve([{ ...WH_B, organization_id: 'org-2', farm_id: null }]),
    );
    const view = renderForm();
    view.rerender(<PurchaseReceiptForm {...view.props} purchaseOrder={PO_TWO} />);
    await screen.findByRole('option', { name: /Warehouse B/ });
    oldRequest.resolve([WH_A]);
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: /Warehouse A/ })).not.toBeInTheDocument();
  });

  it('never displays a warehouse assigned to another farm', async () => {
    mocks.warehouses.mockResolvedValue([
      WH_A,
      { ...WH_B, id: 'wh-other', farm_id: 'farm-other', name: 'Other Farm Warehouse' },
    ]);
    renderForm();
    await screen.findByRole('option', { name: /Warehouse A/ });
    expect(screen.queryByRole('option', { name: /Other Farm Warehouse/ })).not.toBeInTheDocument();
  });

  it('surfaces receipt warehouse authorization failure without raw UUID fallback', async () => {
    mocks.warehouses.mockRejectedValue(
      new ApiError(403, { detail: { code: 'not_authorized' } } as never),
    );
    renderForm();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Warehouse choices are unavailable with your current permissions.',
    );
    expect(screen.getByLabelText('Warehouse')).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: /warehouse/i })).not.toBeInTheDocument();
  });

  it('discards A locations that resolve after B and preserves only B in the payload', async () => {
    const locationsA =
      deferred<
        Array<{ id: string; warehouse_id: string; name: string; code: string; deleted_at: null }>
      >();
    const locationsB =
      deferred<
        Array<{ id: string; warehouse_id: string; name: string; code: string; deleted_at: null }>
      >();
    mocks.locations.mockImplementation((id: string) =>
      id === 'wh-a' ? locationsA.promise : locationsB.promise,
    );
    vi.stubGlobal('crypto', { randomUUID: () => 'key-b' });
    mocks.create.mockResolvedValue({ receipt: {}, replayed: false });
    renderForm();
    await fill();
    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: 'wh-b' } });
    locationsB.resolve([
      { id: 'loc-b', warehouse_id: 'wh-b', name: 'Bin B', code: 'B1', deleted_at: null },
    ]);
    await screen.findByRole('option', { name: /Bin B/ });
    fireEvent.change(screen.getByLabelText('Storage location'), { target: { value: 'loc-b' } });
    locationsA.resolve([
      { id: 'loc-a', warehouse_id: 'wh-a', name: 'Bin A', code: 'A1', deleted_at: null },
    ]);
    await Promise.resolve();
    expect(screen.getByRole('option', { name: /Bin B/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bin A/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Storage location')).toHaveValue('loc-b');
    expect(screen.queryByText(/Unable to load storage locations/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][1].lines[0].storage_location_id).toBe('loc-b');
  });

  it('discards a pending location response when the warehouse is cleared', async () => {
    const locationsA =
      deferred<
        Array<{ id: string; warehouse_id: string; name: string; code: string; deleted_at: null }>
      >();
    mocks.locations.mockReturnValue(locationsA.promise);
    renderForm();
    await fill();
    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: '' } });
    locationsA.resolve([
      { id: 'loc-a', warehouse_id: 'wh-a', name: 'Bin A', code: 'A1', deleted_at: null },
    ]);
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: /Bin A/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Warehouse')).toHaveValue('');
  });

  it('discards a pending location response across close and reopen', async () => {
    const locationsA =
      deferred<
        Array<{ id: string; warehouse_id: string; name: string; code: string; deleted_at: null }>
      >();
    mocks.locations.mockReturnValue(locationsA.promise);
    const view = renderForm();
    await fill();
    view.rerender(<PurchaseReceiptForm {...view.props} open={false} />);
    view.rerender(<PurchaseReceiptForm {...view.props} open />);
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toHaveValue(''));
    locationsA.resolve([
      { id: 'loc-a', warehouse_id: 'wh-a', name: 'Bin A', code: 'A1', deleted_at: null },
    ]);
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: /Bin A/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/1. Feed/)).not.toBeChecked();
    expect(screen.queryByLabelText('Storage location')).not.toBeInTheDocument();
  });

  it.each([
    ['purchase_order_over_receipt', 'purchase-order-changed'],
    ['purchase_order_not_receivable', 'purchase-order-changed'],
    ['warehouse_unavailable', 'warehouse-changed'],
    ['warehouse_farm_scope_mismatch', 'warehouse-changed'],
    ['not_authorized', 'authorization-changed'],
  ] as const)('reports authoritative %s invalidation', async (code, outcome) => {
    vi.stubGlobal('crypto', { randomUUID: () => 'conflict-key' });
    mocks.create.mockRejectedValue(
      new ApiError(code === 'not_authorized' ? 403 : 409, { detail: { code } } as never),
    );
    const { props } = renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await waitFor(() => expect(props.onAuthoritativeFailure).toHaveBeenCalledWith(outcome));
  });

  it('maps FastAPI line validation with stable accessible error association', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'validation-key' });
    mocks.create.mockRejectedValue(
      new ApiError(422, {
        detail: [{ loc: ['body', 'lines', 0, 'quantity'], msg: 'internal text' }],
      } as never),
    );
    renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    const quantity = screen.getByLabelText('Quantity (kg)');
    await waitFor(() => expect(quantity).toHaveAttribute('aria-invalid', 'true'));
    expect(quantity).toHaveAttribute('aria-describedby', 'receipt-error-line-1-quantity');
    expect(screen.queryByText('internal text')).not.toBeInTheDocument();
  });

  it('treats payload conflict as definitively resolved with ordinary dismissal', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'conflict-key' });
    mocks.create.mockRejectedValue(
      new ApiError(409, { detail: { code: 'idempotency_key_payload_conflict' } } as never),
    );
    const { props } = renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await screen.findByText(/could not be replayed/);
    expect(screen.queryByRole('button', { name: 'Abandon attempt' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('maps a missing idempotency key without exposing the raw backend code', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'missing-key' });
    mocks.create.mockRejectedValue(
      new ApiError(400, {
        detail: { code: 'idempotency_key_required', message: 'internal' },
      } as never),
    );
    renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be safely identified');
    expect(screen.queryByText('idempotency_key_required')).not.toBeInTheDocument();
  });

  it('explicitly abandons uncertainty, resets on reopen, and creates a new edited attempt', async () => {
    const randomUUID = vi.fn().mockReturnValueOnce('first-key').mockReturnValueOnce('second-key');
    vi.stubGlobal('crypto', { randomUUID });
    mocks.create
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({ receipt: {}, replayed: false });
    const view = renderForm();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await screen.findByRole('button', { name: 'Abandon attempt' });
    fireEvent.click(screen.getByRole('button', { name: 'Abandon attempt' }));
    view.rerender(<PurchaseReceiptForm {...view.props} open={false} />);
    view.rerender(<PurchaseReceiptForm {...view.props} open />);
    await waitFor(() => expect(screen.getByLabelText('Warehouse')).toHaveValue(''));
    await fill('wh-a', '1.250000', 'LOT-EDITED');
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.create.mock.calls[1][2]).toBe('second-key');
    expect(mocks.create.mock.calls[1][1].lines[0].quantity).toBe('1.250000');
  });

  it('resets busy on PO change and ignores a late submission from the old PO', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'late-key' });
    const posted = deferred<{ receipt: object; replayed: boolean }>();
    mocks.create.mockReturnValue(posted.promise);
    const view = renderForm();
    await fill();
    const title = screen.getByRole('heading', { name: /Receive PO-1/ });
    expect(title).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Post receipt' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Post receipt' }));
    expect(screen.getByRole('button', { name: 'Posting…' })).toBeDisabled();
    view.rerender(<PurchaseReceiptForm {...view.props} purchaseOrder={PO_TWO} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Post receipt' })).toBeDisabled(),
    );
    expect(screen.queryByRole('button', { name: 'Posting…' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'previous Purchase Order may have completed',
    );
    posted.resolve({ receipt: {}, replayed: false });
    await waitFor(() => expect(view.props.onCompleted).not.toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: /Receive PO-2/ })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'previous Purchase Order may have completed',
    );
    expect(view.props.onCompleted).not.toHaveBeenCalled();
  });
});
