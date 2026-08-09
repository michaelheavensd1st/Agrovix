import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import '@testing-library/jest-dom/vitest';

const { routerPush, routerReplace, stableRouter, paramsMock, searchListeners, renderedEditIds } =
  vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const push = vi.fn();
    const replace = vi.fn((url: string) => {
      window.history.replaceState({}, '', url);
      listeners.forEach((listener) => listener());
    });
    return {
      routerPush: push,
      routerReplace: replace,
      stableRouter: { push, replace, back: vi.fn() },
      paramsMock: vi.fn(() => ({ purchaseOrderId: 'po-1' })),
      searchListeners: listeners,
      renderedEditIds: [] as string[],
    };
  });

vi.mock('next/navigation', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    useRouter: () => stableRouter,
    usePathname: () => window.location.pathname,
    useParams: () => paramsMock(),
    useSearchParams: () => {
      const [search, setSearch] = React.useState(window.location.search);
      React.useEffect(() => {
        const listener = () => setSearch(window.location.search);
        searchListeners.add(listener);
        return () => {
          searchListeners.delete(listener);
        };
      }, []);
      return new URLSearchParams(search);
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('@/components/purchase-orders/PurchaseOrderForm', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/purchase-orders/PurchaseOrderForm')
  >('@/components/purchase-orders/PurchaseOrderForm');
  return {
    ...actual,
    PurchaseOrderForm: (props: Parameters<typeof actual.PurchaseOrderForm>[0]) => {
      if (props.initial) renderedEditIds.push(props.initial.id);
      const values = actual.purchaseOrderFormValues(props.initial);
      values.businessPartnerId ||= 'bp-1';
      values.orderDate = '2026-08-01';
      values.notes = props.initial ? 'Local unsaved edit' : 'Create note';
      return (
        <div data-testid={`mock-form-${props.mode}`}>
          <span>{values.notes}</span>
          <span data-testid="mock-form-org">{props.organizationId}</span>
          <span data-testid="mock-field-errors">{JSON.stringify(props.externalErrors ?? {})}</span>
          <span data-testid="mock-options-revision">{props.optionsRevision ?? 0}</span>
          {props.generalError && <span role="alert">{props.generalError}</span>}
          <button type="button" disabled={props.submitting} onClick={() => props.onSubmit(values)}>
            Save mock
          </button>
        </div>
      );
    },
  };
});

import { ApiError, apiFetch } from '@/lib/api';
import NewPurchaseOrderPage from '@/app/purchase-orders/new/page';
import EditPurchaseOrderPage from '@/app/purchase-orders/[purchaseOrderId]/edit/page';
import type { PurchaseOrder } from '@/lib/purchase-orders';

const mockedApiFetch = vi.mocked(apiFetch);
const user = {
  id: 'u1',
  email: 'u@test',
  full_name: 'User',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: ['purchase_order.create', 'purchase_order.update'],
  permission_scopes: [],
};
function po(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    organization_id: 'org-1',
    farm_id: null,
    business_partner_id: 'bp-1',
    po_number: 'PO-1',
    supplier_reference: null,
    status: 'DRAFT',
    currency_code: 'USD',
    order_date: '2026-08-01',
    expected_delivery_date: null,
    delivery_address: null,
    notes: null,
    supplier_code: 'SUP',
    supplier_legal_name: 'Supplier',
    supplier_trading_name: null,
    version: 3,
    created_by_id: 'u1',
    submitted_by_id: null,
    submitted_at: null,
    approved_by_id: null,
    approved_at: null,
    rejected_by_id: null,
    rejected_at: null,
    cancelled_by_id: null,
    cancelled_at: null,
    created_at: '',
    updated_at: '',
    subtotal: '0.000000',
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

beforeEach(() => {
  mockedApiFetch.mockReset();
  routerPush.mockClear();
  routerReplace.mockClear();
  paramsMock.mockReturnValue({ purchaseOrderId: 'po-1' });
  renderedEditIds.length = 0;
  window.history.replaceState({}, '', '/purchase-orders/new?organization_id=org-1');
});

describe('Draft create route', () => {
  it('requires create permission without hardcoded roles', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve({ ...user, permissions: [] } as never);
      if (path === '/v1/organizations')
        return Promise.resolve([{ id: 'org-1', name: 'Org', slug: 'org' }] as never);
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    expect(await screen.findByTestId('ape-forbidden')).toBeInTheDocument();
  });

  it('creates pessimistically, preserves string payloads, prevents duplicate clicks, and redirects canonically', async () => {
    const request = deferred<PurchaseOrder>();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/organizations')
        return Promise.resolve([{ id: 'org-1', name: 'Org', slug: 'org' }] as never);
      if (path === '/v1/organizations/org-1/purchase-orders' && init?.method === 'POST')
        return request.promise as never;
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    const save = await screen.findByRole('button', { name: 'Save mock' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(
      mockedApiFetch.mock.calls.filter(
        ([path]) => path === '/v1/organizations/org-1/purchase-orders',
      ),
    ).toHaveLength(1);
    const body = JSON.parse(
      String(
        mockedApiFetch.mock.calls.find(
          ([path]) => path === '/v1/organizations/org-1/purchase-orders',
        )?.[1]?.body,
      ),
    );
    expect(body.notes).toBe('Create note');
    await act(() => request.resolve(po({ id: 'created-po' })));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/purchase-orders/created-po'));
  });

  it('ignores an organization A create completion after history switches to B, then creates under B', async () => {
    const requestA = deferred<PurchaseOrder>();
    const requestB = deferred<PurchaseOrder>();
    let authLoads = 0;
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') {
        authLoads += 1;
        if (authLoads > 1) return new Promise(() => undefined) as never;
        return Promise.resolve(user as never);
      }
      if (path === '/v1/organizations')
        return Promise.resolve([
          { id: 'org-1', name: 'Organization A', slug: 'org-a' },
          { id: 'org-2', name: 'Organization B', slug: 'org-b' },
        ] as never);
      if (path === '/v1/organizations/org-1/purchase-orders' && init?.method === 'POST')
        return requestA.promise as never;
      if (path === '/v1/organizations/org-2/purchase-orders' && init?.method === 'POST')
        return requestB.promise as never;
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-1');

    await act(async () => {
      flushSync(() => {
        window.history.pushState({}, '', '/purchase-orders/new?organization_id=org-2');
        searchListeners.forEach((listener) => listener());
      });
      expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-2');
      requestA.resolve(po({ id: 'created-under-a', organization_id: 'org-1' }));
      // Drain the POST continuation before `act` drains passive effects. This
      // preserves the precise render-to-effect window from the finding.
      await Promise.resolve();
    });
    expect(routerPush).not.toHaveBeenCalledWith('/purchase-orders/created-under-a');
    expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-2');

    fireEvent.click(screen.getByRole('button', { name: 'Save mock' }));
    await act(() => requestB.resolve(po({ id: 'created-under-b', organization_id: 'org-2' })));
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith('/purchase-orders/created-under-b'),
    );
  });

  it('does not resurrect completed A pending state after A to B to A history navigation', async () => {
    const requestA1 = deferred<PurchaseOrder>();
    const requestA2 = deferred<PurchaseOrder>();
    let createACount = 0;
    let authLoads = 0;
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') {
        authLoads += 1;
        if (authLoads > 1) return new Promise(() => undefined) as never;
        return Promise.resolve(user as never);
      }
      if (path === '/v1/organizations')
        return Promise.resolve([
          { id: 'org-1', name: 'Organization A', slug: 'org-a' },
          { id: 'org-2', name: 'Organization B', slug: 'org-b' },
        ] as never);
      if (path === '/v1/organizations/org-1/purchase-orders' && init?.method === 'POST') {
        createACount += 1;
        return (createACount === 1 ? requestA1.promise : requestA2.promise) as never;
      }
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    const firstSave = await screen.findByRole('button', { name: 'Save mock' });
    fireEvent.click(firstSave);
    expect(firstSave).toBeDisabled();

    act(() => {
      window.history.pushState({}, '', '/purchase-orders/new?organization_id=org-2');
      searchListeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-2'));
    await act(() => requestA1.resolve(po({ id: 'completed-a1', organization_id: 'org-1' })));
    expect(routerPush).not.toHaveBeenCalledWith('/purchase-orders/completed-a1');
    expect(screen.getByRole('button', { name: 'Save mock' })).toBeEnabled();

    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener(
          'popstate',
          () => {
            searchListeners.forEach((listener) => listener());
            resolve();
          },
          { once: true },
        );
      });
      window.history.back();
      await popped;
    });
    expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-1');
    const secondSave = screen.getByRole('button', { name: 'Save mock' });
    expect(secondSave).toBeEnabled();
    fireEvent.click(secondSave);
    expect(secondSave).toBeDisabled();
    expect(createACount).toBe(2);
    await act(() => requestA2.resolve(po({ id: 'created-a2', organization_id: 'org-1' })));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/purchase-orders/created-a2'));
  });

  it('keeps B pending when an older request owned by A completes', async () => {
    const requestA = deferred<PurchaseOrder>();
    const requestB = deferred<PurchaseOrder>();
    let authLoads = 0;
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') {
        authLoads += 1;
        if (authLoads > 1) return new Promise(() => undefined) as never;
        return Promise.resolve(user as never);
      }
      if (path === '/v1/organizations')
        return Promise.resolve([
          { id: 'org-1', name: 'Organization A', slug: 'org-a' },
          { id: 'org-2', name: 'Organization B', slug: 'org-b' },
        ] as never);
      if (path === '/v1/organizations/org-1/purchase-orders' && init?.method === 'POST')
        return requestA.promise as never;
      if (path === '/v1/organizations/org-2/purchase-orders' && init?.method === 'POST')
        return requestB.promise as never;
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    act(() => {
      window.history.pushState({}, '', '/purchase-orders/new?organization_id=org-2');
      searchListeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(screen.getByTestId('mock-form-org')).toHaveTextContent('org-2'));
    const saveB = screen.getByRole('button', { name: 'Save mock' });
    fireEvent.click(saveB);
    expect(saveB).toBeDisabled();
    await act(() => requestA.resolve(po({ id: 'completed-a', organization_id: 'org-1' })));
    expect(saveB).toBeDisabled();
    expect(routerPush).not.toHaveBeenCalledWith('/purchase-orders/completed-a');
    await act(() => requestB.resolve(po({ id: 'completed-b', organization_id: 'org-2' })));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/purchase-orders/completed-b'));
  });

  it('sanitizes 5xx and keeps the form mounted', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/organizations')
        return Promise.resolve([{ id: 'org-1', name: 'Org', slug: 'org' }] as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(new ApiError(500, { detail: 'SQLAlchemy SELECT secret' }));
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByTestId('mock-form-create')).toHaveTextContent('Create note');
    expect(screen.queryByText(/SQLAlchemy/)).not.toBeInTheDocument();
  });

  it('maps indexed 422 details without exposing raw validation JSON', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/organizations')
        return Promise.resolve([{ id: 'org-1', name: 'Org', slug: 'org' }] as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(
          new ApiError(422, {
            detail: [
              { loc: ['body', 'lines', 0, 'unit_price'], msg: 'Price is outside the contract.' },
            ] as unknown as string,
          }),
        );
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByTestId('mock-field-errors')).toHaveTextContent('lines.0.unit_price');
    expect(screen.getByTestId('mock-form-create')).toHaveTextContent('Create note');
  });

  it('uses the shared domain mapper for create currency errors', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/organizations')
        return Promise.resolve([{ id: 'org-1', name: 'Org', slug: 'org' }] as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(
          new ApiError(422, {
            detail: {
              code: 'invalid_currency',
              message: 'currency_code is not an official ISO 4217 code.',
              context: {},
            } as unknown as string,
          }),
        );
      return Promise.resolve({} as never);
    });
    render(<NewPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByTestId('mock-field-errors')).toHaveTextContent('currency_code');
  });
});

describe('Draft edit route', () => {
  it('never renders PO A form under PO B and rejects late A data', async () => {
    const poB = deferred<PurchaseOrder>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/purchase-orders/po-1') return Promise.resolve(po() as never);
      if (path === '/v1/purchase-orders/po-2') return poB.promise as never;
      return Promise.resolve({} as never);
    });
    const view = render(<EditPurchaseOrderPage />);
    expect(await screen.findByTestId('mock-form-edit')).toBeInTheDocument();
    renderedEditIds.length = 0;
    paramsMock.mockReturnValue({ purchaseOrderId: 'po-2' });
    view.rerender(<EditPurchaseOrderPage />);
    expect(screen.queryByTestId('mock-form-edit')).not.toBeInTheDocument();
    expect(renderedEditIds).not.toContain('po-1');
    await act(() => poB.resolve(po({ id: 'po-2', po_number: 'PO-2' })));
    expect(await screen.findByText('Edit PO-2')).toBeInTheDocument();
  });

  it('blocks non-Draft editing', async () => {
    mockedApiFetch.mockImplementation((path: string) =>
      path === '/v1/auth/me'
        ? Promise.resolve(user as never)
        : Promise.resolve(po({ status: 'SUBMITTED' }) as never),
    );
    render(<EditPurchaseOrderPage />);
    expect(await screen.findByText('This Purchase Order is not editable')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-form-edit')).not.toBeInTheDocument();
  });

  it.each([
    [403, 'ape-forbidden'],
    [404, 'ape-empty'],
  ])('renders tenant-safe edit load state for %s', async (status, testId) => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      return Promise.reject(new ApiError(status, { detail: 'internal resource detail' }));
    });
    render(<EditPurchaseOrderPage />);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByText('internal resource detail')).not.toBeInTheDocument();
  });

  it('retains edits and refreshes selector choices after a governance conflict', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/purchase-orders/po-1' && init?.method === 'PATCH')
        return Promise.reject(
          new ApiError(409, {
            detail: {
              code: 'supplier_unavailable',
              message: 'Supplier is no longer available.',
              context: { field: 'business_partner_id' },
            } as unknown as string,
          }),
        );
      return Promise.resolve(po() as never);
    });
    render(<EditPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByTestId('mock-field-errors')).toHaveTextContent('business_partner_id');
    expect(screen.getByTestId('mock-options-revision')).toHaveTextContent('1');
    expect(screen.getByTestId('mock-form-edit')).toHaveTextContent('Local unsaved edit');
  });

  it('uses the shared domain mapper for edit delivery-country errors', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/purchase-orders/po-1' && init?.method === 'PATCH')
        return Promise.reject(
          new ApiError(422, {
            detail: {
              code: 'invalid_country_code',
              message: 'delivery_address.country_code is invalid.',
              context: { country_code: 'ZZ' },
            } as unknown as string,
          }),
        );
      return Promise.resolve(po() as never);
    });
    render(<EditPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByTestId('mock-field-errors')).toHaveTextContent(
      'delivery_address.country_code',
    );
    expect(screen.getByTestId('mock-form-edit')).toHaveTextContent('Local unsaved edit');
  });

  it('preserves local edits, fetches latest separately, never retries, and reloads explicitly', async () => {
    let gets = 0;
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(user as never);
      if (path === '/v1/purchase-orders/po-1' && init?.method === 'PATCH')
        return Promise.reject(
          new ApiError(409, {
            detail: {
              code: 'purchase_order_version_conflict',
              message: 'changed',
              context: { current_version: 4 },
            } as unknown as string,
          }),
        );
      if (path === '/v1/purchase-orders/po-1') {
        gets += 1;
        return Promise.resolve(
          po({ version: gets === 1 ? 3 : 4, notes: gets === 1 ? null : 'Server edit' }) as never,
        );
      }
      return Promise.resolve({} as never);
    });
    render(<EditPurchaseOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save mock' }));
    expect(await screen.findByTestId('po-conflict-panel')).toHaveTextContent('version 3');
    expect(screen.getByTestId('mock-form-edit')).toHaveTextContent('Local unsaved edit');
    expect(
      mockedApiFetch.mock.calls.filter(
        ([path, init]) => path === '/v1/purchase-orders/po-1' && init?.method === 'PATCH',
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Discard local edits/ }));
    expect(await screen.findByText('Version 4')).toBeInTheDocument();
    expect(screen.queryByTestId('po-conflict-panel')).not.toBeInTheDocument();
  });
});
