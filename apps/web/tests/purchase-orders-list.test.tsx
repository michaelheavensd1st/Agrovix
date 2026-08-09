import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, routerReplace, stableRouter, urlListeners, renderedListOrganizations } =
  vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const navigate = (url: string) => {
      window.history.pushState({}, '', url);
      listeners.forEach((listener) => listener());
    };
    const replace = vi.fn((url: string) => {
      window.history.replaceState({}, '', url);
      listeners.forEach((listener) => listener());
    });
    const push = vi.fn(navigate);
    return {
      routerPush: push,
      routerReplace: replace,
      stableRouter: { push, replace, back: vi.fn() },
      urlListeners: listeners,
      renderedListOrganizations: [] as string[][],
    };
  });

vi.mock('next/navigation', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    useRouter: () => stableRouter,
    usePathname: () => window.location.pathname,
    useParams: () => ({}),
    useSearchParams: () => {
      const [search, setSearch] = React.useState(window.location.search);
      React.useEffect(() => {
        const listener = () => setSearch(window.location.search);
        urlListeners.add(listener);
        return () => {
          urlListeners.delete(listener);
        };
      }, []);
      return new URLSearchParams(search);
    },
  };
});

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

vi.mock('@/components/purchase-orders/PurchaseOrderList', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/purchase-orders/PurchaseOrderList')
  >('@/components/purchase-orders/PurchaseOrderList');
  return {
    PurchaseOrderList: (props: Parameters<typeof actual.PurchaseOrderList>[0]) => {
      renderedListOrganizations.push(props.rows.map((row) => row.organization_id));
      return actual.PurchaseOrderList(props);
    },
  };
});

import { ApiError, apiFetch } from '@/lib/api';
import PurchaseOrdersPage from '@/app/purchase-orders/page';
import type { PurchaseOrder } from '@/lib/purchase-orders';

const mockedApiFetch = vi.mocked(apiFetch);
const ORG_A = { id: 'org-A', name: 'Aegis', slug: 'aegis' };
const ORG_B = { id: 'org-B', name: 'Beacon', slug: 'beacon' };
const FARM_A = {
  id: 'farm-A',
  organization_id: ORG_A.id,
  name: 'North Farm',
  code: 'NORTH',
  deleted_at: null,
};
const USER = {
  id: 'user-1',
  email: 'reader@example.test',
  full_name: 'Reader',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: [],
  permission_scopes: [
    { organization_id: ORG_A.id, farm_id: null, permissions: ['purchase_order.read'] },
    { organization_id: ORG_B.id, farm_id: null, permissions: ['purchase_order.read'] },
  ],
};

function makePO(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    organization_id: ORG_A.id,
    farm_id: FARM_A.id,
    business_partner_id: 'bp-1',
    po_number: 'PO-2026-000001',
    supplier_reference: 'SUP-REF',
    status: 'DRAFT',
    currency_code: 'USD',
    order_date: '2026-08-01',
    expected_delivery_date: '2026-08-10',
    delivery_address: null,
    notes: null,
    supplier_code: 'ACME',
    supplier_legal_name: 'Acme Supplies Ltd',
    supplier_trading_name: 'Acme',
    version: 2,
    created_by_id: 'user-1',
    submitted_by_id: null,
    submitted_at: null,
    approved_by_id: null,
    approved_at: null,
    rejected_by_id: null,
    rejected_at: null,
    cancelled_by_id: null,
    cancelled_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z',
    subtotal: '1234.500000',
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

function bootstrap(path: string): unknown {
  if (path === '/v1/auth/me') return USER;
  if (path === '/v1/organizations') return [ORG_A, ORG_B];
  if (path.endsWith('/farms')) return path.includes(ORG_A.id) ? [FARM_A] : [];
  if (path.includes('/business-partners'))
    return {
      items: [
        {
          id: 'bp-1',
          code: 'ACME',
          legal_name: 'Acme Supplies Ltd',
          trading_name: 'Acme',
        },
      ],
      next_cursor: null,
    };
  return undefined;
}

describe('PurchaseOrdersPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockClear();
    routerReplace.mockClear();
    renderedListOrganizations.length = 0;
    window.history.replaceState({}, '', `/purchase-orders?organization_id=${ORG_A.id}`);
  });

  it('uses the established login flow when authentication has expired', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.reject(new ApiError(401, { detail: 'expired' }));
      if (path === '/v1/organizations') return Promise.resolve([ORG_A] as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('/login?returnTo=')),
    );
  });

  it('recognizes a farm-scoped read grant without hardcoding a role', async () => {
    const farmReader = {
      ...USER,
      permission_scopes: [
        {
          organization_id: ORG_A.id,
          farm_id: FARM_A.id,
          permissions: ['purchase_order.read'],
        },
      ],
    };
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(farmReader as never);
      if (path === '/v1/organizations') return Promise.resolve([ORG_A] as never);
      if (path.endsWith('/farms')) return Promise.resolve([FARM_A] as never);
      if (path.includes('/business-partners'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('ape-empty')).toBeInTheDocument();
    expect(
      mockedApiFetch.mock.calls.some(([path]) => String(path).includes('/purchase-orders')),
    ).toBe(true);
  });

  it('shows loading and then responsive rows/cards with snapshot values and exact money', async () => {
    const request = deferred<{ items: PurchaseOrder[]; next_cursor: null }>();
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders')) return request.promise as never;
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('po-list-loading')).toBeInTheDocument();
    await act(() => {
      request.resolve({ items: [makePO()], next_cursor: null });
    });
    expect(await screen.findByTestId('po-row-po-1')).toBeInTheDocument();
    expect(screen.getByTestId('po-card-po-1')).toBeInTheDocument();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD 1,234.50').length).toBeGreaterThan(0);
  });

  it('renders empty, forbidden, and recoverable error states', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve([] as never);
    });
    const first = render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('ape-empty')).toBeInTheDocument();
    first.unmount();

    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(new ApiError(403, { detail: 'denied' }));
      return Promise.resolve([] as never);
    });
    const second = render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('ape-forbidden')).toBeInTheDocument();
    second.unmount();

    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(new Error('network unavailable'));
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('ape-error')).toHaveTextContent('network unavailable');
  });

  it('writes composed filters with repeated statuses and clears cursor', async () => {
    window.history.replaceState(
      {},
      '',
      `/purchase-orders?organization_id=${ORG_A.id}&cursor=opaque`,
    );
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    await screen.findByTestId('ape-empty');
    fireEvent.change(screen.getByTestId('po-filter-farm'), { target: { value: FARM_A.id } });
    expect(new URLSearchParams(window.location.search).get('cursor')).toBeNull();
    fireEvent.change(screen.getByTestId('po-filter-supplier'), { target: { value: 'bp-1' } });
    fireEvent.change(screen.getByTestId('po-filter-search'), { target: { value: 'ACME ref' } });
    fireEvent.change(screen.getByTestId('po-filter-order-from'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(screen.getByTestId('po-filter-status-DRAFT'));
    fireEvent.click(screen.getByTestId('po-filter-status-APPROVED'));
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get('cursor')).toBeNull();
      expect(params.get('search')).toBe('ACME ref');
      expect(params.get('farm_id')).toBe(FARM_A.id);
      expect(params.get('business_partner_id')).toBe('bp-1');
      expect(params.get('order_date_from')).toBe('2026-08-01');
      expect(params.getAll('status')).toEqual(['DRAFT', 'APPROVED']);
    });
    await waitFor(() => {
      const calls = mockedApiFetch.mock.calls.map(([path]) => String(path));
      expect(
        calls.some((path) => path.includes('status=DRAFT') && path.includes('status=APPROVED')),
      ).toBe(true);
    });
  });

  it('traverses an opaque next cursor and returns to the previous page', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('cursor=page-two'))
        return Promise.resolve({
          items: [makePO({ id: 'po-2', po_number: 'PO-2' })],
          next_cursor: null,
        } as never);
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [makePO()], next_cursor: 'page-two' } as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    await screen.findByTestId('po-row-po-1');
    fireEvent.click(screen.getByTestId('po-page-next'));
    expect(await screen.findByTestId('po-row-po-2')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('cursor')).toBe('page-two');
    fireEvent.click(screen.getByTestId('po-page-previous'));
    expect(await screen.findByTestId('po-row-po-1')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('cursor')).toBeNull();
  });

  it('binds previous cursor history to URL-driven organization identity', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes(`/organizations/${ORG_A.id}/purchase-orders`)) {
        if (path.includes('cursor=a-page-three'))
          return Promise.resolve({
            items: [makePO({ id: 'po-a-3', po_number: 'PO-A-3' })],
            next_cursor: null,
          } as never);
        if (path.includes('cursor=a-page-two'))
          return Promise.resolve({
            items: [makePO({ id: 'po-a-2', po_number: 'PO-A-2' })],
            next_cursor: 'a-page-three',
          } as never);
        return Promise.resolve({ items: [makePO()], next_cursor: 'a-page-two' } as never);
      }
      if (path.includes(`/organizations/${ORG_B.id}/purchase-orders`)) {
        if (path.includes('cursor=b-page-two'))
          return Promise.resolve({
            items: [makePO({ id: 'po-b-2', organization_id: ORG_B.id, po_number: 'PO-B-2' })],
            next_cursor: null,
          } as never);
        return Promise.resolve({
          items: [makePO({ id: 'po-b-1', organization_id: ORG_B.id, po_number: 'PO-B-1' })],
          next_cursor: 'b-page-two',
        } as never);
      }
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    await screen.findByTestId('po-row-po-1');
    fireEvent.click(screen.getByTestId('po-page-next'));
    await screen.findByTestId('po-row-po-a-2');
    fireEvent.click(screen.getByTestId('po-page-next'));
    await screen.findByTestId('po-row-po-a-3');

    await act(() => {
      window.history.pushState({}, '', `/purchase-orders?organization_id=${ORG_B.id}`);
      urlListeners.forEach((listener) => listener());
    });
    await screen.findByTestId('po-row-po-b-1');
    expect(screen.getByTestId('po-page-previous')).toBeDisabled();
    fireEvent.click(screen.getByTestId('po-page-previous'));
    expect(new URLSearchParams(window.location.search).get('cursor')).toBeNull();

    fireEvent.click(screen.getByTestId('po-page-next'));
    await screen.findByTestId('po-row-po-b-2');
    expect(
      mockedApiFetch.mock.calls.some(
        ([path]) =>
          String(path).includes(`/organizations/${ORG_B.id}/purchase-orders`) &&
          /cursor=a-page-(two|three)/.test(String(path)),
      ),
    ).toBe(false);
    expect(new URLSearchParams(window.location.search).get('cursor')).toBe('b-page-two');
    expect(screen.getByTestId('po-page-previous')).toBeEnabled();
    fireEvent.click(screen.getByTestId('po-page-previous'));
    expect(await screen.findByTestId('po-row-po-b-1')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('cursor')).toBeNull();
  });

  it('recovers from a malformed cursor by returning to page one', async () => {
    window.history.replaceState(
      {},
      '',
      `/purchase-orders?organization_id=${ORG_A.id}&cursor=bad-token`,
    );
    let rejected = false;
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('cursor=bad-token') && !rejected) {
        rejected = true;
        return Promise.reject(new ApiError(422, { detail: 'invalid cursor' }));
      }
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [makePO()], next_cursor: null } as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('po-row-po-1')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('cursor')).toBeNull();
  });

  it('resets farm/filter/cursor state when the organization changes', async () => {
    window.history.replaceState(
      {},
      '',
      `/purchase-orders?organization_id=${ORG_A.id}&farm_id=${FARM_A.id}&search=old&cursor=old`,
    );
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    await screen.findByTestId('ape-empty');
    fireEvent.change(screen.getByTestId('po-org-selector'), { target: { value: ORG_B.id } });
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get('organization_id')).toBe(ORG_B.id);
      expect(params.get('farm_id')).toBeNull();
      expect(params.get('search')).toBeNull();
      expect(params.get('cursor')).toBeNull();
    });
  });

  it('rejects late organization and filter responses', async () => {
    const orgARequest = deferred<{ items: PurchaseOrder[]; next_cursor: null }>();
    const oldFilterRequest = deferred<{ items: PurchaseOrder[]; next_cursor: null }>();
    const newFilterRequest = deferred<{ items: PurchaseOrder[]; next_cursor: null }>();
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes(`/organizations/${ORG_A.id}/purchase-orders`) && !path.includes('search='))
        return orgARequest.promise as never;
      if (path.includes('search=old')) return oldFilterRequest.promise as never;
      if (path.includes('search=new')) return newFilterRequest.promise as never;
      if (path.includes(`/organizations/${ORG_B.id}/purchase-orders`))
        return Promise.resolve({
          items: [makePO({ id: 'po-b', organization_id: ORG_B.id, po_number: 'PO-B' })],
          next_cursor: null,
        } as never);
      return Promise.resolve({ items: [], next_cursor: null } as never);
    });
    render(<PurchaseOrdersPage />);
    await screen.findByTestId('po-org-selector');
    fireEvent.change(screen.getByTestId('po-org-selector'), { target: { value: ORG_B.id } });
    expect(await screen.findByTestId('po-row-po-b')).toBeInTheDocument();
    await act(() =>
      orgARequest.resolve({ items: [makePO({ id: 'po-stale' })], next_cursor: null }),
    );
    expect(screen.queryByTestId('po-row-po-stale')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('po-filter-search'), { target: { value: 'old' } });
    fireEvent.change(screen.getByTestId('po-filter-search'), { target: { value: 'new' } });
    await act(() =>
      newFilterRequest.resolve({
        items: [makePO({ id: 'po-new', organization_id: ORG_B.id })],
        next_cursor: null,
      }),
    );
    expect(await screen.findByTestId('po-row-po-new')).toBeInTheDocument();
    await act(() =>
      oldFilterRequest.resolve({
        items: [makePO({ id: 'po-old', organization_id: ORG_B.id })],
        next_cursor: null,
      }),
    );
    expect(screen.queryByTestId('po-row-po-old')).not.toBeInTheDocument();
  });

  it('never renders committed organization rows after a history URL change', async () => {
    const orgBRequest = deferred<{ items: PurchaseOrder[]; next_cursor: null }>();
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes(`/organizations/${ORG_A.id}/purchase-orders`))
        return Promise.resolve({ items: [makePO()], next_cursor: null } as never);
      if (path.includes(`/organizations/${ORG_B.id}/purchase-orders`))
        return orgBRequest.promise as never;
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByTestId('po-row-po-1')).toBeInTheDocument();
    renderedListOrganizations.length = 0;

    await act(() => {
      window.history.pushState({}, '', `/purchase-orders?organization_id=${ORG_B.id}`);
      urlListeners.forEach((listener) => listener());
    });
    expect(screen.queryByTestId('po-row-po-1')).not.toBeInTheDocument();
    expect(renderedListOrganizations.flat()).not.toContain(ORG_A.id);

    await act(() =>
      orgBRequest.resolve({
        items: [makePO({ id: 'po-b', organization_id: ORG_B.id, po_number: 'PO-B' })],
        next_cursor: null,
      }),
    );
    expect(await screen.findByTestId('po-row-po-b')).toBeInTheDocument();
    expect(renderedListOrganizations[renderedListOrganizations.length - 1]).toEqual([ORG_B.id]);
  });

  it('sanitizes unexpected internal API details', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      const value = bootstrap(path);
      if (value !== undefined) return Promise.resolve(value as never);
      if (path.includes('/purchase-orders'))
        return Promise.reject(
          new ApiError(500, {
            detail: 'sqlalchemy.exc.ProgrammingError: SELECT secret FROM internal_table',
          }),
        );
      return Promise.resolve([] as never);
    });
    render(<PurchaseOrdersPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
    expect(screen.queryByText(/sqlalchemy|SELECT secret/i)).not.toBeInTheDocument();
  });
});
