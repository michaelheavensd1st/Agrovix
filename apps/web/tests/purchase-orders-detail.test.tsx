import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, stableRouter, useParamsMock, renderedDetailIds, renderedTransitionPoIds } =
  vi.hoisted(() => {
    const push = vi.fn();
    return {
      routerPush: push,
      stableRouter: { push, replace: vi.fn(), back: vi.fn() },
      useParamsMock: vi.fn(() => ({ purchaseOrderId: 'po-1' })),
      renderedDetailIds: [] as string[],
      renderedTransitionPoIds: [] as string[][],
    };
  });

vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  usePathname: () => `/purchase-orders/${useParamsMock().purchaseOrderId}`,
  useParams: () => useParamsMock(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('@/components/purchase-orders/PurchaseOrderDetail', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/purchase-orders/PurchaseOrderDetail')
  >('@/components/purchase-orders/PurchaseOrderDetail');
  return {
    PurchaseOrderDetail: (props: Parameters<typeof actual.PurchaseOrderDetail>[0]) => {
      renderedDetailIds.push(props.purchaseOrder.id);
      return actual.PurchaseOrderDetail(props);
    },
  };
});

vi.mock('@/components/purchase-orders/PurchaseOrderTransitionHistory', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/purchase-orders/PurchaseOrderTransitionHistory')
  >('@/components/purchase-orders/PurchaseOrderTransitionHistory');
  return {
    PurchaseOrderTransitionHistory: (
      props: Parameters<typeof actual.PurchaseOrderTransitionHistory>[0],
    ) => {
      renderedTransitionPoIds.push(props.transitions.map((item) => item.purchase_order_id));
      return actual.PurchaseOrderTransitionHistory(props);
    },
  };
});

import { ApiError, apiFetch } from '@/lib/api';
import PurchaseOrderDetailPage from '@/app/purchase-orders/[purchaseOrderId]/page';
import type { PurchaseOrder, PurchaseOrderTransition } from '@/lib/purchase-orders';

const mockedApiFetch = vi.mocked(apiFetch);
const USER = {
  id: 'user-1',
  email: 'reader@example.test',
  full_name: 'Reader',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: [],
  permission_scopes: [
    { organization_id: 'org-1', farm_id: null, permissions: ['purchase_order.read'] },
  ],
};

function makePO(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    organization_id: 'org-1',
    farm_id: 'farm-1',
    business_partner_id: 'bp-1',
    po_number: 'PO-2026-000001',
    supplier_reference: 'REF-77',
    status: 'APPROVED',
    currency_code: 'USD',
    order_date: '2026-08-01',
    expected_delivery_date: '2026-08-10',
    delivery_address: {
      line1: '1 Farm Road',
      line2: null,
      city: 'Accra',
      region: null,
      postal_code: null,
      country_code: 'GH',
    },
    notes: 'Frozen PO notes',
    supplier_code: 'ACME',
    supplier_legal_name: 'Acme Legal Snapshot',
    supplier_trading_name: 'Acme Snapshot',
    version: 4,
    created_by_id: USER.id,
    submitted_by_id: 'user-2',
    submitted_at: '2026-08-01T11:00:00Z',
    approved_by_id: USER.id,
    approved_at: '2026-08-02T10:00:00Z',
    rejected_by_id: null,
    rejected_at: null,
    cancelled_by_id: null,
    cancelled_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z',
    subtotal: '99999999999999999899000000.000000',
    lines: [
      {
        id: 'line-1',
        line_number: 1,
        inventory_item_id: 'item-1',
        item_code: 'ITEM-SNAPSHOT',
        item_name: 'Frozen Item Snapshot',
        item_sku: 'SKU-SNAPSHOT',
        description: 'Frozen description',
        line_note: null,
        ordered_quantity: '999999999999.999999',
        ordered_unit: 'kg',
        canonical_unit: 'kg',
        ordered_quantity_canonical: '999999999999.999999',
        received_quantity: '0.000000',
        received_quantity_canonical: '0.000000',
        unit_price: '99999999999999.999999',
        extended_amount: '99999999999999999899000000.000000',
        created_at: '2026-08-01T10:00:00Z',
        updated_at: '2026-08-01T10:00:00Z',
      },
    ],
    ...overrides,
  };
}

function transition(overrides: Partial<PurchaseOrderTransition> = {}): PurchaseOrderTransition {
  return {
    id: 'transition-1',
    purchase_order_id: 'po-1',
    actor_id: USER.id,
    from_status: 'SUBMITTED',
    to_status: 'APPROVED',
    operation: 'approve',
    reason: 'Approved for delivery',
    occurred_at: '2026-08-02T10:00:00Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PurchaseOrderDetailPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockClear();
    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
    renderedDetailIds.length = 0;
    renderedTransitionPoIds.length = 0;
  });

  it('renders loading then the canonical snapshot and exact Decimal values', async () => {
    const poRequest = deferred<PurchaseOrder>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return poRequest.promise as never;
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    render(<PurchaseOrderDetailPage />);
    expect(screen.getByTestId('po-detail-loading')).toBeInTheDocument();
    await act(async () => {
      poRequest.resolve(makePO());
      await poRequest.promise;
    });
    expect(await screen.findByTestId('po-detail')).toBeInTheDocument();
    expect(screen.getByText('Acme Snapshot · ACME')).toBeInTheDocument();
    expect(screen.getByText('Frozen Item Snapshot')).toBeInTheDocument();
    expect(screen.getByText('ITEM-SNAPSHOT · SKU-SNAPSHOT')).toBeInTheDocument();
    expect(screen.getByText('999,999,999,999.999999')).toBeInTheDocument();
    expect(screen.getAllByText('USD 99,999,999,999,999,999,899,000,000.00').length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
    expect(await screen.findByTestId('po-transitions-empty')).toBeInTheDocument();
  });

  it('renders canonical forbidden and tenant-hidden unavailable states', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      return Promise.reject(new ApiError(403, { detail: 'denied' }));
    });
    const first = render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('ape-forbidden')).toBeInTheDocument();
    first.unmount();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      return Promise.reject(new ApiError(404, { detail: 'hidden' }));
    });
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByText('Purchase order unavailable')).toBeInTheDocument();
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });

  it('loads transitions independently and keeps detail visible on transition failure', async () => {
    const historyRequest = deferred<never>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path.includes('/transitions')) return historyRequest.promise;
      return Promise.resolve(null as never);
    });
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-detail')).toBeInTheDocument();
    expect(screen.getByTestId('po-transitions-loading')).toBeInTheDocument();
    await act(() => historyRequest.reject(new Error('history unavailable')));
    expect(await screen.findByTestId('po-transitions-error')).toBeInTheDocument();
    expect(screen.getByTestId('po-detail')).toBeInTheDocument();
  });

  it('renders transition actor/reason and paginates using opaque cursors', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path.includes('cursor=next-history'))
        return Promise.resolve({
          items: [transition({ id: 'transition-2', operation: 'cancel', to_status: 'CANCELLED' })],
          next_cursor: null,
        } as never);
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [transition()], next_cursor: 'next-history' } as never);
      return Promise.resolve(null as never);
    });
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-transition-transition-1')).toHaveTextContent(
      'Approved for delivery',
    );
    expect(screen.getByTestId('po-transition-transition-1')).toHaveTextContent('Actor: You');
    fireEvent.click(screen.getByTestId('po-transitions-next'));
    expect(await screen.findByTestId('po-transition-transition-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('po-transitions-previous'));
    expect(await screen.findByTestId('po-transition-transition-1')).toBeInTheDocument();
    expect(
      mockedApiFetch.mock.calls.some(([path]) => String(path).includes('cursor=next-history')),
    ).toBe(true);
  });

  it('locks rapid transition Next and Previous activation and preserves page boundaries', async () => {
    const pageTwo = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    const returnToFirst = deferred<{ items: PurchaseOrderTransition[]; next_cursor: string }>();
    let firstPageLoads = 0;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path.includes('cursor=opaque-history-two')) return pageTwo.promise as never;
      if (path.includes('/transitions')) {
        firstPageLoads += 1;
        if (firstPageLoads === 1)
          return Promise.resolve({
            items: [transition()],
            next_cursor: 'opaque-history-two',
          } as never);
        return returnToFirst.promise as never;
      }
      return Promise.resolve(null as never);
    });
    render(<PurchaseOrderDetailPage />);
    await screen.findByTestId('po-transition-transition-1');
    const next = screen.getByTestId('po-transitions-next');
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByTestId('po-transitions-loading')).toBeInTheDocument();
    expect(
      mockedApiFetch.mock.calls.filter(([path]) =>
        String(path).includes('cursor=opaque-history-two'),
      ),
    ).toHaveLength(1);

    await act(() =>
      pageTwo.resolve({
        items: [transition({ id: 'transition-2', operation: 'cancel', to_status: 'CANCELLED' })],
        next_cursor: null,
      }),
    );
    await screen.findByTestId('po-transition-transition-2');
    const previous = screen.getByTestId('po-transitions-previous');
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(screen.getByTestId('po-transitions-loading')).toBeInTheDocument();
    expect(firstPageLoads).toBe(2);

    await act(() =>
      returnToFirst.resolve({ items: [transition()], next_cursor: 'opaque-history-two' }),
    );
    expect(await screen.findByTestId('po-transition-transition-1')).toBeInTheDocument();
    expect(screen.getByTestId('po-transitions-previous')).toBeDisabled();
  });

  it('rejects a stale detail response after a route change', async () => {
    const oldPO = deferred<PurchaseOrder>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return oldPO.promise as never;
      if (path === '/v1/purchase-orders/po-2')
        return Promise.resolve(makePO({ id: 'po-2', po_number: 'PO-NEW' }) as never);
      if (path.includes('/po-2/transitions'))
        return Promise.resolve({
          items: [
            transition({ id: 'transition-new', purchase_order_id: 'po-2', reason: 'New route' }),
          ],
          next_cursor: null,
        } as never);
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<PurchaseOrderDetailPage />);
    expect(await screen.findByText('PO-NEW')).toBeInTheDocument();
    expect(await screen.findByTestId('po-transition-transition-new')).toBeInTheDocument();
    await act(() => oldPO.resolve(makePO({ po_number: 'PO-STALE' })));
    expect(screen.queryByText('PO-STALE')).not.toBeInTheDocument();
  });

  it('never renders an already-loaded PO under a new route identity', async () => {
    const newPO = deferred<PurchaseOrder>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path === '/v1/purchase-orders/po-2') return newPO.promise as never;
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    expect(await screen.findByText('PO-2026-000001')).toBeInTheDocument();
    renderedDetailIds.length = 0;

    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<PurchaseOrderDetailPage />);
    expect(screen.queryByText('PO-2026-000001')).not.toBeInTheDocument();
    expect(renderedDetailIds).not.toContain('po-1');

    await act(() => newPO.resolve(makePO({ id: 'po-2', po_number: 'PO-NEW' })));
    expect(await screen.findByText('PO-NEW')).toBeInTheDocument();
    expect(renderedDetailIds[renderedDetailIds.length - 1]).toBe('po-2');
  });

  it('never renders already-loaded transitions under a new PO route', async () => {
    const newPO = deferred<PurchaseOrder>();
    const newHistory = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path.includes('/po-1/transitions'))
        return Promise.resolve({ items: [transition()], next_cursor: null } as never);
      if (path === '/v1/purchase-orders/po-2') return newPO.promise as never;
      if (path.includes('/po-2/transitions')) return newHistory.promise as never;
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-transition-transition-1')).toBeInTheDocument();
    renderedTransitionPoIds.length = 0;

    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<PurchaseOrderDetailPage />);
    expect(screen.queryByTestId('po-transition-transition-1')).not.toBeInTheDocument();
    expect(renderedTransitionPoIds.flat()).not.toContain('po-1');

    await act(() => newPO.resolve(makePO({ id: 'po-2', po_number: 'PO-NEW' })));
    await act(() =>
      newHistory.resolve({
        items: [transition({ id: 'transition-new', purchase_order_id: 'po-2' })],
        next_cursor: null,
      }),
    );
    expect(await screen.findByTestId('po-transition-transition-new')).toBeInTheDocument();
    expect(renderedTransitionPoIds[renderedTransitionPoIds.length - 1]).toEqual(['po-2']);
  });

  it('rejects a stale transition response after a route change', async () => {
    const oldHistory = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path === '/v1/purchase-orders/po-2')
        return Promise.resolve(makePO({ id: 'po-2', po_number: 'PO-NEW' }) as never);
      if (path.includes('/po-1/transitions')) return oldHistory.promise as never;
      if (path.includes('/po-2/transitions'))
        return Promise.resolve({
          items: [
            transition({
              id: 'transition-new',
              purchase_order_id: 'po-2',
              reason: 'New route',
            }),
          ],
          next_cursor: null,
        } as never);
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-transitions-loading')).toBeInTheDocument();
    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-transition-transition-new')).toBeInTheDocument();
    await act(() =>
      oldHistory.resolve({ items: [transition({ id: 'transition-stale' })], next_cursor: null }),
    );
    expect(screen.queryByTestId('po-transition-transition-stale')).not.toBeInTheDocument();
  });

  it('keeps the newest PO A detail and history across an overlapping A to B to A route sequence', async () => {
    const firstA = deferred<PurchaseOrder>();
    const poB = deferred<PurchaseOrder>();
    const secondA = deferred<PurchaseOrder>();
    const historyA = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    let aLoads = 0;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') {
        aLoads += 1;
        return (aLoads === 1 ? firstA.promise : secondA.promise) as never;
      }
      if (path === '/v1/purchase-orders/po-2') return poB.promise as never;
      if (path.includes('/po-1/transitions')) return historyA.promise as never;
      if (path.includes('/po-2/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    await waitFor(() => expect(aLoads).toBe(1));
    act(() => {
      useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
      view.rerender(<PurchaseOrderDetailPage />);
    });
    await waitFor(() =>
      expect(mockedApiFetch.mock.calls.some(([path]) => path === '/v1/purchase-orders/po-2')).toBe(
        true,
      ),
    );
    act(() => {
      useParamsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
      view.rerender(<PurchaseOrderDetailPage />);
    });
    await waitFor(() => expect(aLoads).toBe(2));

    await act(() => secondA.resolve(makePO({ po_number: 'PO-A-CURRENT' })));
    await act(() =>
      historyA.resolve({
        items: [transition({ id: 'transition-a-current', reason: 'Current A' })],
        next_cursor: null,
      }),
    );
    expect(await screen.findByText('PO-A-CURRENT')).toBeInTheDocument();
    expect(await screen.findByTestId('po-transition-transition-a-current')).toBeInTheDocument();

    await act(() => firstA.resolve(makePO({ po_number: 'PO-A-STALE' })));
    await act(() => poB.resolve(makePO({ id: 'po-2', po_number: 'PO-B-STALE' })));
    expect(screen.queryByText('PO-A-STALE')).not.toBeInTheDocument();
    expect(screen.queryByText('PO-B-STALE')).not.toBeInTheDocument();
    expect(screen.getByText('PO-A-CURRENT')).toBeInTheDocument();
  });

  it('renders only A2 transition history after overlapping A to B to A history requests', async () => {
    const historyA1 = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    const historyB = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    const historyA2 = deferred<{ items: PurchaseOrderTransition[]; next_cursor: null }>();
    let aHistoryLoads = 0;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path === '/v1/purchase-orders/po-2')
        return Promise.resolve(makePO({ id: 'po-2', po_number: 'PO-B' }) as never);
      if (path.includes('/po-1/transitions')) {
        aHistoryLoads += 1;
        return (aHistoryLoads === 1 ? historyA1.promise : historyA2.promise) as never;
      }
      if (path.includes('/po-2/transitions')) return historyB.promise as never;
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    await waitFor(() => expect(aHistoryLoads).toBe(1));
    act(() => {
      useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
      view.rerender(<PurchaseOrderDetailPage />);
    });
    await waitFor(() =>
      expect(
        mockedApiFetch.mock.calls.some(([path]) => String(path).includes('/po-2/transitions')),
      ).toBe(true),
    );
    act(() => {
      useParamsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
      view.rerender(<PurchaseOrderDetailPage />);
    });
    await waitFor(() => expect(aHistoryLoads).toBe(2));

    await act(() =>
      historyA2.resolve({
        items: [transition({ id: 'transition-a2', reason: 'A2 current history' })],
        next_cursor: null,
      }),
    );
    expect(await screen.findByTestId('po-transition-transition-a2')).toBeInTheDocument();

    await act(() =>
      historyA1.resolve({
        items: [transition({ id: 'transition-a1', reason: 'A1 stale history' })],
        next_cursor: null,
      }),
    );
    await act(() =>
      historyB.resolve({
        items: [
          transition({ id: 'transition-b', purchase_order_id: 'po-2', reason: 'B stale history' }),
        ],
        next_cursor: null,
      }),
    );
    expect(screen.getByTestId('po-transition-transition-a2')).toBeInTheDocument();
    expect(screen.queryByTestId('po-transition-transition-a1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('po-transition-transition-b')).not.toBeInTheDocument();
  });
});
