import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const {
  routerPush,
  stableRouter,
  useParamsMock,
  toastMock,
  submitMock,
  withdrawMock,
  approveMock,
  rejectMock,
  reviseMock,
  cancelMock,
} = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: vi.fn(), back: vi.fn() },
    useParamsMock: vi.fn(() => ({ purchaseOrderId: 'po-1' })),
    toastMock: vi.fn(),
    submitMock: vi.fn(),
    withdrawMock: vi.fn(),
    approveMock: vi.fn(),
    rejectMock: vi.fn(),
    reviseMock: vi.fn(),
    cancelMock: vi.fn(),
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

vi.mock('@/lib/purchase-orders', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/purchase-orders')>('@/lib/purchase-orders');
  return {
    ...actual,
    submitPurchaseOrder: submitMock,
    withdrawPurchaseOrder: withdrawMock,
    approvePurchaseOrder: approveMock,
    rejectPurchaseOrder: rejectMock,
    revisePurchaseOrder: reviseMock,
    cancelPurchaseOrder: cancelMock,
  };
});

vi.mock('@/components/ui-polish', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui-polish')>('@/components/ui-polish');
  return { ...actual, toast: toastMock };
});

import { ApiError, apiFetch } from '@/lib/api';
import PurchaseOrderDetailPage from '@/app/purchase-orders/[purchaseOrderId]/page';
import { PurchaseOrderLifecycleActions } from '@/components/purchase-orders/PurchaseOrderLifecycleActions';
import type { PurchaseOrder, PurchaseOrderStatus } from '@/lib/purchase-orders';
import type { CurrentUser } from '@/lib/types';

const mockedApiFetch = vi.mocked(apiFetch);
const ALL_PERMISSIONS = [
  'purchase_order.read',
  'purchase_order.update',
  'purchase_order.submit',
  'purchase_order.approve',
  'purchase_order.reject',
  'purchase_order.cancel',
];
const USER: CurrentUser = {
  id: 'user-1',
  email: 'buyer@example.test',
  full_name: 'Buyer',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: ALL_PERMISSIONS,
  permission_scopes: [],
};

function makePO(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    organization_id: 'org-1',
    farm_id: 'farm-1',
    business_partner_id: 'bp-1',
    po_number: 'PO-2026-000001',
    supplier_reference: null,
    status: 'DRAFT',
    currency_code: 'USD',
    order_date: '2026-08-01',
    expected_delivery_date: null,
    delivery_address: null,
    notes: null,
    supplier_code: 'SUP-1',
    supplier_legal_name: 'Supplier One',
    supplier_trading_name: null,
    version: 1,
    created_by_id: 'creator-1',
    submitted_by_id: null,
    submitted_at: null,
    approved_by_id: null,
    approved_at: null,
    rejected_by_id: null,
    rejected_at: null,
    cancelled_by_id: null,
    cancelled_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    subtotal: '10.000000',
    lines: [],
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

function renderActions(
  status: PurchaseOrderStatus,
  options: {
    user?: CurrentUser;
    createdBy?: string;
    onAction?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onAction = options.onAction ?? vi.fn().mockResolvedValue({ kind: 'completed' });
  render(
    <PurchaseOrderLifecycleActions
      purchaseOrder={makePO({ status, created_by_id: options.createdBy ?? 'creator-1' })}
      user={options.user ?? USER}
      pendingOperation={null}
      error={null}
      onAction={onAction}
    />,
  );
  return onAction;
}

async function confirmAction(testId: string, reason?: string) {
  fireEvent.click(screen.getByTestId(testId));
  if (reason !== undefined)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
    await Promise.resolve();
  });
}

describe('PurchaseOrder lifecycle controls', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockClear();
    toastMock.mockReset();
    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
    for (const mock of [submitMock, withdrawMock, approveMock, rejectMock, reviseMock, cancelMock])
      mock.mockReset();
  });

  it.each([
    ['DRAFT', ['submit', 'cancel']],
    ['SUBMITTED', ['withdraw', 'approve', 'reject', 'cancel']],
    ['APPROVED', ['cancel']],
    ['REJECTED', ['revise', 'cancel']],
    ['PARTIALLY_RECEIVED', []],
    ['RECEIVED', []],
    ['CANCELLED', []],
    ['CANCELLED_WITH_RECEIPTS', []],
  ] as const)('renders the canonical %s action matrix', (status, expected) => {
    renderActions(status);
    for (const operation of ['submit', 'withdraw', 'approve', 'reject', 'revise', 'cancel']) {
      const control = screen.queryByTestId(`po-action-${operation}`);
      expect(Boolean(control)).toBe(expected.includes(operation as never));
    }
  });

  it('uses scoped permissions and represents independent approval without a bypass', () => {
    const scoped: CurrentUser = {
      ...USER,
      permissions: [],
      permission_scopes: [
        {
          organization_id: 'org-1',
          farm_id: 'farm-1',
          permissions: ['purchase_order.approve', 'purchase_order.reject'],
        },
      ],
    };
    renderActions('SUBMITTED', { user: scoped, createdBy: scoped.id });
    expect(screen.queryByTestId('po-action-approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('po-action-reject')).toBeInTheDocument();
    expect(screen.getByTestId('po-self-approval-note')).toHaveTextContent(
      'creator of this Purchase Order cannot approve it',
    );
    expect(screen.queryByTestId('po-action-withdraw')).not.toBeInTheDocument();
  });

  it.each([
    ['submit', 'DRAFT', undefined],
    ['withdraw', 'SUBMITTED', 'Needed changes'],
    ['approve', 'SUBMITTED', 'Looks good'],
    ['reject', 'SUBMITTED', 'Budget issue'],
    ['revise', 'REJECTED', 'Correct the lines'],
    ['cancel', 'DRAFT', 'No longer needed'],
  ] as const)('confirms %s once with the contract reason', async (operation, status, reason) => {
    const onAction = renderActions(status);
    await confirmAction(`po-action-${operation}`, reason);
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith(operation, reason === undefined ? undefined : reason),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('keeps a required-reason dialog open with focus and ARIA error linkage', async () => {
    const onAction = renderActions('SUBMITTED');
    await confirmAction('po-action-reject');
    const reason = screen.getByLabelText(/Reason/);
    expect(reason).toHaveFocus();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveAttribute('aria-describedby', 'po-lifecycle-reason-error');
    expect(screen.getByRole('alert')).toHaveTextContent('reason is required');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('omits an empty optional approval reason', async () => {
    const onAction = renderActions('SUBMITTED');
    await confirmAction('po-action-approve');
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('approve', undefined));
  });

  it('enforces the 500-character reason boundary without truncating valid text', async () => {
    const onAction = renderActions('SUBMITTED');
    fireEvent.click(screen.getByTestId('po-action-reject'));
    const reason = screen.getByLabelText(/Reason/);
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.change(reason, { target: { value: 'x'.repeat(500) } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith('reject', 'x'.repeat(500));
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Keep current state' }))],
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
  ])('restores invoking-action focus after %s dismissal', async (_method, dismiss) => {
    renderActions('SUBMITTED');
    const trigger = screen.getByTestId('po-action-reject');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByLabelText(/Reason/)).toHaveFocus();
    dismiss();
    expect(screen.queryByTestId('po-lifecycle-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('PurchaseOrder lifecycle detail integration', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockClear();
    toastMock.mockReset();
    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
    for (const mock of [submitMock, withdrawMock, approveMock, rejectMock, reviseMock, cancelMock])
      mock.mockReset();
  });

  it('guards duplicate submission and authoritatively refreshes detail and history', async () => {
    let canonical = makePO();
    let detailReads = 0;
    let historyReads = 0;
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') {
        detailReads += 1;
        return Promise.resolve(canonical as never);
      }
      if (path.includes('/po-1/transitions')) {
        historyReads += 1;
        const created = {
          id: 'transition-create',
          purchase_order_id: 'po-1',
          actor_id: 'creator-1',
          from_status: null,
          to_status: 'DRAFT',
          operation: 'create',
          reason: null,
          occurred_at: '2026-08-01T10:00:00Z',
        };
        return Promise.resolve({
          items:
            canonical.status === 'SUBMITTED'
              ? [
                  created,
                  {
                    id: 'transition-submit',
                    purchase_order_id: 'po-1',
                    actor_id: USER.id,
                    from_status: 'DRAFT',
                    to_status: 'SUBMITTED',
                    operation: 'submit',
                    reason: null,
                    occurred_at: '2026-08-02T10:00:00Z',
                  },
                ]
              : [created],
          next_cursor: null,
        } as never);
      }
      return Promise.resolve(null as never);
    });
    const request = deferred<{ purchaseOrder: PurchaseOrder; replayed: boolean }>();
    submitMock.mockReturnValue(request.promise);

    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-submit')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('po-action-submit'));
    fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
    fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('po-lifecycle-confirm')).toBeDisabled();

    canonical = makePO({
      status: 'SUBMITTED',
      version: 2,
      submitted_by_id: USER.id,
      submitted_at: '2026-08-02T10:00:00Z',
    });
    await act(async () => {
      request.resolve({ purchaseOrder: canonical, replayed: false });
      await request.promise;
      await Promise.resolve();
    });
    expect(await screen.findByTestId('po-action-withdraw')).toBeInTheDocument();
    expect(await screen.findByTestId('po-transition-transition-submit')).toBeInTheDocument();
    expect(screen.getAllByTestId('po-transition-transition-create')).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('po-lifecycle-status-focus')).toHaveFocus());
    expect(detailReads).toBeGreaterThanOrEqual(2);
    expect(historyReads).toBeGreaterThanOrEqual(2);
    expect(toastMock).toHaveBeenCalledWith('Purchase Order submit completed.', 'success');
  });

  it('treats replay as informational and refreshes without a second success', async () => {
    const canonical = makePO({ status: 'SUBMITTED', version: 2 });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(canonical as never);
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    withdrawMock.mockResolvedValue({ purchaseOrder: makePO({ version: 3 }), replayed: true });
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-withdraw')).toBeInTheDocument();
    await confirmAction('po-action-withdraw', 'Changed elsewhere');
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'This lifecycle action was already applied. Current state has been refreshed.',
        'info',
      ),
    );
    expect(toastMock.mock.calls.some(([, kind]) => kind === 'success')).toBe(false);
  });

  it('maps an attributable backend 422 to the preserved reason and permits deliberate retry', async () => {
    let canonical = makePO({ status: 'SUBMITTED', version: 2 });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(canonical as never);
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    rejectMock
      .mockRejectedValueOnce(
        new ApiError(422, {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'reason'],
              msg: 'raw backend validation internals',
            },
          ] as never,
        }),
      )
      .mockImplementationOnce(async () => {
        canonical = makePO({ status: 'REJECTED', version: 3 });
        return { purchaseOrder: canonical, replayed: false };
      });

    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-reject')).toBeInTheDocument();
    await confirmAction('po-action-reject', 'Original reason');

    const reason = screen.getByLabelText(/Reason/);
    expect(screen.getByTestId('po-lifecycle-dialog')).toBeInTheDocument();
    expect(reason).toHaveValue('Original reason');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveAttribute('aria-describedby', 'po-lifecycle-reason-error');
    expect(reason).toHaveFocus();
    expect(screen.getByText('The reason was not accepted. Review it and try again.')).toBeVisible();
    expect(screen.queryByText('raw backend validation internals')).not.toBeInTheDocument();
    expect(rejectMock).toHaveBeenCalledTimes(1);

    fireEvent.change(reason, { target: { value: 'Corrected reason' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('po-lifecycle-confirm'));
      await Promise.resolve();
    });
    expect(rejectMock).toHaveBeenCalledTimes(2);
    expect(rejectMock).toHaveBeenLastCalledWith('po-1', 'Corrected reason');
    expect(await screen.findByTestId('po-action-revise')).toBeInTheDocument();
  });

  it.each([
    [401, 'login'],
    [403, 'permission'],
    [404, 'unavailable'],
    [409, 'no longer valid'],
    [422, 'reason was not accepted'],
    [500, 'Something went wrong'],
  ] as const)('handles lifecycle %s without exposing backend details', async (status, expected) => {
    let reads = 0;
    const canonical = makePO({ status: 'SUBMITTED' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') {
        reads += 1;
        return Promise.resolve(canonical as never);
      }
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    rejectMock.mockRejectedValue(
      new ApiError(status, {
        detail: {
          code: 'internal_sql_driver_detail',
          message: 'SELECT secret FROM tenant',
        } as never,
      }),
    );
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-reject')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('po-action-reject'));
    const reason = screen.getByLabelText(/Reason/);
    fireEvent.change(reason, { target: { value: 'Not acceptable' } });
    const confirm = screen.getByTestId('po-lifecycle-confirm');
    confirm.focus();
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    if (status === 401) {
      await waitFor(() =>
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('/login')),
      );
    } else if (status === 404) {
      expect(await screen.findByText('Purchase order unavailable')).toBeInTheDocument();
    } else {
      expect(await screen.findByTestId('po-lifecycle-error')).toHaveTextContent(expected);
    }
    if (status === 422) {
      expect(screen.getByTestId('po-lifecycle-dialog')).toBeInTheDocument();
      expect(reason).toHaveValue('Not acceptable');
      expect(reason).not.toHaveAttribute('aria-invalid', 'true');
      expect(reason).not.toHaveAttribute('aria-describedby', 'po-lifecycle-reason-error');
      expect(document.getElementById('po-lifecycle-reason-error')).not.toBeInTheDocument();
      expect(
        screen.queryByText('The reason was not accepted. Review it and try again.'),
      ).not.toBeInTheDocument();
      expect(confirm).toHaveFocus();
      expect(rejectMock).toHaveBeenCalledWith('po-1', 'Not acceptable');
      expect(rejectMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await Promise.resolve();
      });
      expect(rejectMock).toHaveBeenCalledTimes(1);
    }
    expect(screen.queryByText(/SELECT secret/)).not.toBeInTheDocument();
    if (status === 409) expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('surfaces an authoritative self-approval conflict without exposing internals', async () => {
    const canonical = makePO({ status: 'SUBMITTED', created_by_id: 'creator-elsewhere' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(canonical as never);
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    approveMock.mockRejectedValue(
      new ApiError(409, {
        detail: {
          code: 'purchase_order_self_approval_forbidden',
          message: 'internal authorization details',
        } as never,
      }),
    );
    render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-approve')).toBeInTheDocument();
    await confirmAction('po-action-approve');
    expect(await screen.findByTestId('po-lifecycle-error')).toHaveTextContent(
      'A creator cannot approve their own Purchase Order',
    );
    expect(screen.queryByText('internal authorization details')).not.toBeInTheDocument();
  });

  it('prevents an obsolete PO mutation from affecting a newer route or its request', async () => {
    const poARequest = deferred<{ purchaseOrder: PurchaseOrder; replayed: boolean }>();
    const poBRequest = deferred<{ purchaseOrder: PurchaseOrder; replayed: boolean }>();
    submitMock.mockImplementation((id: string) =>
      id === 'po-1' ? poARequest.promise : poBRequest.promise,
    );
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(USER as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(makePO() as never);
      if (path === '/v1/purchase-orders/po-2')
        return Promise.resolve(makePO({ id: 'po-2', po_number: 'PO-B' }) as never);
      if (path.includes('/transitions'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve(null as never);
    });
    const view = render(<PurchaseOrderDetailPage />);
    expect(await screen.findByTestId('po-action-submit')).toBeInTheDocument();
    await confirmAction('po-action-submit');

    useParamsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<PurchaseOrderDetailPage />);
    expect(await screen.findByText('PO-B')).toBeInTheDocument();
    await confirmAction('po-action-submit');
    expect(submitMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      poARequest.resolve({
        purchaseOrder: makePO({ status: 'SUBMITTED', po_number: 'PO-A-STALE' }),
        replayed: false,
      });
      await poARequest.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText('PO-A-STALE')).not.toBeInTheDocument();
    expect(screen.getByTestId('po-lifecycle-confirm')).toBeDisabled();
    expect(toastMock).not.toHaveBeenCalled();

    await act(async () => {
      poBRequest.resolve({
        purchaseOrder: makePO({ id: 'po-2', po_number: 'PO-B', status: 'SUBMITTED' }),
        replayed: false,
      });
      await poBRequest.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
  });
});
