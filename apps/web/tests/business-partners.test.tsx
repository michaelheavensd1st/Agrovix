/**
 * Release 6.0.2 — Business Partner UI tests.
 *
 * Covers list rendering, filters, create submission with the
 * supplier-oriented default, detail-page fetch, and permission
 * gating. Uses the same mocking convention as the warehouse
 * tests: mock ``@/lib/api``'s ``apiFetch`` per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---- hoisted mocks ----------------------------------------------- //
const { routerPush, stableRouter, useParamsMock } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
    useParamsMock: vi.fn(() => ({ partnerId: '' })),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  useParams: () => useParamsMock(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn(), apiFetchResult: vi.fn() };
});

import { apiFetch } from '@/lib/api';
import BusinessPartnerListPage from '@/app/business-partners/page';
import NewBusinessPartnerPage from '@/app/business-partners/new/page';
import BusinessPartnerDetailPage from '@/app/business-partners/[partnerId]/page';
import EditBusinessPartnerPage from '@/app/business-partners/[partnerId]/edit/page';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

// ---- fixtures ---------------------------------------------------- //
const ORG = { id: 'org-A', name: 'Aegis Foods', slug: 'aegis' };
const ORG_B = { id: 'org-B', name: 'Beacon Foods', slug: 'beacon' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OWNER_USER = {
  id: 'user-owner',
  email: 'owner@ex.example',
  full_name: 'Owner',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: [] as string[],
  permission_scopes: [
    {
      organization_id: ORG.id,
      farm_id: null,
      permissions: ['*'],
    },
  ],
};

const VIEWER_USER = {
  id: 'user-viewer',
  email: 'viewer@ex.example',
  full_name: 'Viewer',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  permissions: [] as string[],
  permission_scopes: [
    {
      organization_id: ORG.id,
      farm_id: null,
      permissions: ['business_partner.read'],
    },
  ],
};

function makePartner(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bp-1',
    organization_id: ORG.id,
    code: 'ACME',
    legal_name: 'Acme Feeds Ltd.',
    trading_name: null,
    primary_address: null,
    email: null,
    phone: null,
    country_code: null,
    tax_identifier: null,
    metadata: null,
    notes: null,
    is_active: true,
    deactivated_at: null,
    deactivation_reason: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T00:00:00.000Z',
    capabilities: [
      {
        id: 'cap-1',
        business_partner_id: 'bp-1',
        capability: 'supplier',
        created_at: '2026-02-01T00:00:00.000Z',
      },
    ],
    supplier_profile: {
      id: 'sp-1',
      business_partner_id: 'bp-1',
      qualification_status: 'approved',
      qualification_note: null,
      qualified_by_id: 'user-owner',
      qualified_at: '2026-02-01T00:00:00.000Z',
      preference_tier: 'preferred',
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    },
    contacts: [],
    ...over,
  };
}

// ------------------------------------------------------------------ //
// List page
// ------------------------------------------------------------------ //
describe('BusinessPartnerListPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    window.history.replaceState({}, '', '/business-partners');
  });
  afterEach(() => vi.clearAllMocks());

  it('renders partners returned by the API and defaults the capability filter to supplier', async () => {
    const partner = makePartner();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        // Default filter must include capability=supplier.
        expect(path).toContain('capability=supplier');
        return Promise.resolve({ items: [partner], next_cursor: null });
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    await waitFor(() => {
      expect(screen.getByTestId(`bp-row-${partner.code}`)).toBeInTheDocument();
    });
    expect(screen.getByText('Acme Feeds Ltd.')).toBeInTheDocument();
    // Supplier is the pre-selected value in the capability filter.
    const capFilter = screen.getByTestId('bp-filter-capability') as HTMLSelectElement;
    expect(capFilter.value).toBe('supplier');
  });

  it('shows the create link when the user has business_partner.create', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    await waitFor(() => {
      expect(screen.getByTestId('bp-create-link')).toBeInTheDocument();
    });
  });

  it('hides the create link for a viewer without create permission', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(VIEWER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    // Wait for the empty state to appear.
    await waitFor(() => {
      expect(screen.getByTestId('bp-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bp-create-link')).toBeNull();
  });

  it('propagates the capability filter change into the API query', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return Promise.resolve({ items: [], next_cursor: null });
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    await waitFor(() => {
      expect(screen.getByTestId('bp-filter-capability')).toBeInTheDocument();
    });
    const capFilter = screen.getByTestId('bp-filter-capability') as HTMLSelectElement;
    fireEvent.change(capFilter, { target: { value: 'customer' } });
    await waitFor(() => {
      const listCalls = mockedApiFetch.mock.calls
        .map((c: any[]) => c[0])
        .filter((p: string) => p.startsWith(`/v1/organizations/${ORG.id}/business-partners`));
      expect(listCalls.some((p: string) => p.includes('capability=customer'))).toBe(true);
    });
  });

  it('shows the forbidden banner on a 403 from the API', async () => {
    const { ApiError } = await import('@/lib/api');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return Promise.reject(new ApiError(403, { detail: 'nope' }));
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    await waitFor(() => {
      expect(screen.getByTestId('bp-forbidden')).toBeInTheDocument();
    });
  });

  it('ignores a late prior-tenant success and keeps the new tenant authoritative', async () => {
    const oldRequest = deferred<any>();
    const newRequest = deferred<any>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG, ORG_B]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return oldRequest.promise;
      }
      if (path.startsWith(`/v1/organizations/${ORG_B.id}/business-partners`)) {
        return newRequest.promise;
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    const orgSelect = await screen.findByTestId('bp-org-select');
    fireEvent.change(orgSelect, { target: { value: ORG_B.id } });

    await act(async () => {
      newRequest.resolve({
        items: [makePartner({ id: 'bp-B', code: 'BEACON', legal_name: 'Beacon Partner' })],
        next_cursor: null,
      });
    });
    expect(await screen.findByText('Beacon Partner')).toBeInTheDocument();

    await act(async () => {
      oldRequest.resolve({
        items: [makePartner({ code: 'STALE-A', legal_name: 'Stale A Partner' })],
        next_cursor: null,
      });
    });
    expect(screen.queryByText('Stale A Partner')).toBeNull();
    expect(screen.getByText('Beacon Partner')).toBeInTheDocument();
  });

  it('ignores a late prior-tenant error after the new tenant has loaded', async () => {
    const { ApiError } = await import('@/lib/api');
    const oldRequest = deferred<any>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/organizations') return Promise.resolve([ORG, ORG_B]);
      if (path.startsWith(`/v1/organizations/${ORG.id}/business-partners`)) {
        return oldRequest.promise;
      }
      if (path.startsWith(`/v1/organizations/${ORG_B.id}/business-partners`)) {
        return Promise.resolve({
          items: [makePartner({ id: 'bp-B', code: 'BEACON', legal_name: 'Beacon Partner' })],
          next_cursor: null,
        });
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerListPage />);
    fireEvent.change(await screen.findByTestId('bp-org-select'), {
      target: { value: ORG_B.id },
    });
    expect(await screen.findByText('Beacon Partner')).toBeInTheDocument();

    await act(async () => {
      oldRequest.reject(new ApiError(403, { detail: 'stale tenant error' } as any));
    });
    expect(screen.queryByTestId('bp-forbidden')).toBeNull();
    expect(screen.queryByTestId('bp-error')).toBeNull();
    expect(screen.getByText('Beacon Partner')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ //
// New partner page
// ------------------------------------------------------------------ //
describe('NewBusinessPartnerPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    window.history.replaceState({}, '', `/business-partners/new?organization_id=${ORG.id}`);
  });
  afterEach(() => vi.clearAllMocks());

  it('submits the create payload with the supplier capability included by default', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/v1/organizations/${ORG.id}/business-partners` && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}');
        expect(body.code).toBe('ACME-01');
        expect(body.legal_name).toBe('Acme');
        expect(body.capabilities).toContain('supplier');
        expect(body.supplier_profile).not.toBeNull();
        return Promise.resolve(makePartner({ id: 'bp-new', code: 'ACME-01' }));
      }
      return Promise.resolve(null);
    });
    render(<NewBusinessPartnerPage />);
    fireEvent.change(screen.getByTestId('bp-create-code'), { target: { value: 'acme-01' } });
    fireEvent.change(screen.getByTestId('bp-create-legal-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('bp-create-submit'));
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/business-partners/bp-new');
    });
  });

  it('sends the frozen §4.1 fields when the user fills them in', async () => {
    mockedApiFetch.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}');
        // Frozen field-name assertions.
        expect(body.primary_address).toEqual({
          line1: '1 Silk Rd',
          line2: null,
          city: 'Mumbai',
          region: null,
          postal_code: null,
          country_code: 'IN',
        });
        expect(body.email).toBe('billing@acme.example');
        expect(body.phone).toBe('+91 22 5555 0100');
        expect(body.country_code).toBe('IN'); // uppercased by the form
        expect(body.tax_identifier).toBe('GSTIN29ABCDE1234F1Z5');
        // Old flat fields must not appear.
        expect(body.address_line_1).toBeUndefined();
        expect(body.city).toBeUndefined();
        expect(body.country).toBeUndefined();
        return Promise.resolve(makePartner({ id: 'bp-full', code: 'FULL-01' }));
      }
      return Promise.resolve(null);
    });
    render(<NewBusinessPartnerPage />);
    fireEvent.change(screen.getByTestId('bp-create-code'), { target: { value: 'full-01' } });
    fireEvent.change(screen.getByTestId('bp-create-legal-name'), { target: { value: 'Full' } });
    fireEvent.change(screen.getByTestId('bp-create-addr-line1'), {
      target: { value: '1 Silk Rd' },
    });
    fireEvent.change(screen.getByTestId('bp-create-addr-city'), { target: { value: 'Mumbai' } });
    fireEvent.change(screen.getByTestId('bp-create-addr-country-code'), {
      target: { value: 'in' },
    });
    fireEvent.change(screen.getByTestId('bp-create-email'), {
      target: { value: 'billing@acme.example' },
    });
    fireEvent.change(screen.getByTestId('bp-create-phone'), {
      target: { value: '+91 22 5555 0100' },
    });
    fireEvent.change(screen.getByTestId('bp-create-country-code'), { target: { value: 'in' } });
    fireEvent.change(screen.getByTestId('bp-create-tax-identifier'), {
      target: { value: 'GSTIN29ABCDE1234F1Z5' },
    });
    fireEvent.click(screen.getByTestId('bp-create-submit'));
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/business-partners/bp-full');
    });
  });

  it('surfaces the API error envelope on a 409 conflict', async () => {
    const { ApiError } = await import('@/lib/api');
    mockedApiFetch.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.reject(
          new ApiError(409, {
            detail: {
              code: 'business_partner_code_conflict',
              message: 'A partner with this code already exists in this organization.',
              context: { code: 'DUP' },
            },
          } as any),
        );
      }
      return Promise.resolve(null);
    });
    render(<NewBusinessPartnerPage />);
    fireEvent.change(screen.getByTestId('bp-create-code'), { target: { value: 'DUP' } });
    fireEvent.change(screen.getByTestId('bp-create-legal-name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('bp-create-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('bp-create-error')).toHaveTextContent(
        /A partner with this code already exists/i,
      );
    });
  });
});

// ------------------------------------------------------------------ //
// Detail page
// ------------------------------------------------------------------ //
describe('BusinessPartnerDetailPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    useParamsMock.mockReturnValue({ partnerId: 'bp-1' });
    window.history.replaceState({}, '', '/business-partners/bp-1');
  });
  afterEach(() => vi.clearAllMocks());

  it('renders header, capabilities and supplier profile from the API response', async () => {
    const partner = makePartner({
      primary_address: {
        line1: '1 Silk Rd',
        line2: null,
        city: 'Mumbai',
        region: null,
        postal_code: null,
        country_code: 'IN',
      },
      email: 'billing@acme.example',
      phone: '+91 22 5555 0100',
      country_code: 'IN',
      tax_identifier: 'GSTIN29ABCDE1234F1Z5',
    });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') return Promise.resolve(partner);
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Acme Feeds Ltd.')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bp-detail-capability-supplier')).toBeInTheDocument();
    expect(screen.getByTestId('bp-detail-supplier-profile')).toBeInTheDocument();
    // §4.1 field renderings.
    expect(screen.getByTestId('bp-detail-primary-address')).toHaveTextContent(/Silk Rd/);
    expect(screen.getByTestId('bp-detail-primary-address')).toHaveTextContent(/Mumbai/);
    expect(screen.getByTestId('bp-detail-email')).toHaveTextContent('billing@acme.example');
    expect(screen.getByTestId('bp-detail-phone')).toHaveTextContent('+91 22 5555 0100');
    expect(screen.getByTestId('bp-detail-country-code')).toHaveTextContent('IN');
    expect(screen.getByTestId('bp-detail-tax-identifier')).toHaveTextContent(
      'GSTIN29ABCDE1234F1Z5',
    );
    // Approved partner → deactivate button visible for an owner.
    expect(screen.getByTestId('bp-detail-deactivate')).toBeInTheDocument();
  });

  it('shows the restore button on an inactive partner and hides deactivate', async () => {
    const partner = makePartner({
      is_active: false,
      deactivated_at: '2026-02-05T00:00:00.000Z',
      deactivation_reason: 'seasonal pause',
    });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') return Promise.resolve(partner);
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await waitFor(() => {
      expect(screen.getByTestId('bp-detail-inactive')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bp-detail-restore')).toBeInTheDocument();
    expect(screen.queryByTestId('bp-detail-deactivate')).toBeNull();
  });

  it('renders a friendly error on 404', async () => {
    const { ApiError } = await import('@/lib/api');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') {
        return Promise.reject(
          new ApiError(404, {
            detail: { code: 'not_found', message: 'Business Partner not found.' },
          } as any),
        );
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await waitFor(() => {
      expect(screen.getByTestId('bp-detail-error')).toHaveTextContent(/not found/i);
    });
  });

  it('uses the shared 401 authentication path and redirects to login', async () => {
    const { ApiError } = await import('@/lib/api');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') {
        return Promise.reject(new ApiError(401, { detail: 'expired' } as any));
      }
      if (path === '/v1/business-partners/bp-1') return new Promise(() => {});
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('discards a stale response when the route partner id changes mid-flight', async () => {
    // First mount: bp-1 slow, then remount for bp-2 fast → the bp-1
    // response must be ignored so the header never flashes back.
    const slow = new Promise<any>(() => {}); // never resolves
    const fastPartner = makePartner({ id: 'bp-2', legal_name: 'Second Partner' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') return slow;
      if (path === '/v1/business-partners/bp-2') return Promise.resolve(fastPartner);
      return Promise.resolve(null);
    });
    useParamsMock.mockReturnValue({ partnerId: 'bp-1' });
    const { rerender } = render(<BusinessPartnerDetailPage />);
    // Switch route mid-flight.
    useParamsMock.mockReturnValue({ partnerId: 'bp-2' });
    rerender(<BusinessPartnerDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Second Partner')).toBeInTheDocument();
    });
    // Even if the slow bp-1 response completed later it must not paint
    // (this test doesn't resolve it, but the guard is what prevents it).
    expect(screen.queryByText('Acme Feeds Ltd.')).toBeNull();
  });

  it('does not paint a stale 404 for a previous partner id', async () => {
    const { ApiError } = await import('@/lib/api');
    let firstReject: (err: any) => void = () => {};
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') {
        return new Promise((_, reject) => {
          firstReject = reject;
        });
      }
      if (path === '/v1/business-partners/bp-2') {
        return Promise.resolve(makePartner({ id: 'bp-2', legal_name: 'Second' }));
      }
      return Promise.resolve(null);
    });
    useParamsMock.mockReturnValue({ partnerId: 'bp-1' });
    const { rerender } = render(<BusinessPartnerDetailPage />);
    // Switch to bp-2 (which resolves).
    useParamsMock.mockReturnValue({ partnerId: 'bp-2' });
    rerender(<BusinessPartnerDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Second')).toBeInTheDocument();
    });
    // Now the bp-1 promise rejects late — must NOT paint an error.
    firstReject(new ApiError(404, { detail: 'stale' } as any));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('bp-detail-error')).toBeNull();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('renders a null primary address without leaking placeholder structure', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1') {
        return Promise.resolve(makePartner({ primary_address: null }));
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await waitFor(() => expect(screen.getByText('Acme Feeds Ltd.')).toBeInTheDocument());
    expect(screen.getByTestId('bp-detail-primary-address')).toHaveTextContent('—');
  });

  it.each([
    ['success', null],
    ['403', 403],
    ['404', 404],
    ['generic error', 500],
  ])('ignores a stale post-mutation %s after the route changes', async (_label, status) => {
    const { ApiError } = await import('@/lib/api');
    const mutation = deferred<any>();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('route changed');
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1' && !init?.method) {
        return Promise.resolve(makePartner());
      }
      if (path === '/v1/business-partners/bp-1/deactivate') return mutation.promise;
      if (path === '/v1/business-partners/bp-2') {
        return Promise.resolve(makePartner({ id: 'bp-2', legal_name: 'Current Partner' }));
      }
      return Promise.resolve(null);
    });
    const { rerender } = render(<BusinessPartnerDetailPage />);
    fireEvent.click(await screen.findByTestId('bp-detail-deactivate'));
    useParamsMock.mockReturnValue({ partnerId: 'bp-2' });
    rerender(<BusinessPartnerDetailPage />);
    expect(await screen.findByText('Current Partner')).toBeInTheDocument();

    await act(async () => {
      if (status === null) mutation.resolve(makePartner({ is_active: false }));
      else mutation.reject(new ApiError(status, { detail: 'stale mutation' } as any));
    });
    expect(screen.getByText('Current Partner')).toBeInTheDocument();
    expect(screen.queryByTestId('bp-detail-error')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(
      mockedApiFetch.mock.calls.filter((call: any[]) => call[0] === '/v1/business-partners/bp-1'),
    ).toHaveLength(1);
    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('does not update state when unmounted during a mutation', async () => {
    const mutation = deferred<any>();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('unmounted');
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1' && !init?.method) {
        return Promise.resolve(makePartner());
      }
      if (path === '/v1/business-partners/bp-1/deactivate') return mutation.promise;
      return Promise.resolve(null);
    });
    const { unmount } = render(<BusinessPartnerDetailPage />);
    fireEvent.click(await screen.findByTestId('bp-detail-deactivate'));
    unmount();
    await act(async () => mutation.reject(new Error('late failure')));
    expect(alertSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('supports permitted qualification and contact lifecycle mutations', async () => {
    const contact = {
      id: 'contact-1',
      business_partner_id: 'bp-1',
      name: 'Alice',
      job_title: null,
      email: null,
      phone: null,
      contact_role: 'accounts',
      is_primary: true,
      is_active: true,
      deactivated_at: null,
      deactivation_reason: null,
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    };
    let current = makePartner({ contacts: [contact] });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('lifecycle');
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve(OWNER_USER);
      if (path === '/v1/business-partners/bp-1' && !init?.method) {
        return Promise.resolve(current);
      }
      if (path.endsWith('/supplier-profile') && init?.method === 'PUT') {
        return Promise.resolve(current.supplier_profile);
      }
      if (path.endsWith('/contacts') && init?.method === 'POST') return Promise.resolve(contact);
      if (path.endsWith('/deactivate') && path.includes('contact-1')) {
        current = makePartner({ contacts: [{ ...contact, is_active: false }] });
        return Promise.resolve(current.contacts[0]);
      }
      if (path.endsWith('/restore') && path.includes('contact-1')) {
        current = makePartner({ contacts: [contact] });
        return Promise.resolve(contact);
      }
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    await screen.findByTestId('bp-detail-save-supplier-profile');
    fireEvent.change(screen.getByTestId('bp-detail-qualification'), {
      target: { value: 'blocked' },
    });
    fireEvent.click(screen.getByTestId('bp-detail-save-supplier-profile'));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/v1/business-partners/bp-1/supplier-profile',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    fireEvent.change(screen.getByTestId('bp-add-contact-name'), {
      target: { value: 'New Contact' },
    });
    fireEvent.click(screen.getByTestId('bp-add-contact-submit'));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/v1/business-partners/bp-1/contacts',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    fireEvent.click(screen.getByTestId('bp-contact-deactivate-contact-1'));
    await waitFor(() => expect(screen.getByTestId('bp-contact-restore-contact-1')).toBeVisible());
    fireEvent.click(screen.getByTestId('bp-contact-restore-contact-1'));
    await waitFor(() =>
      expect(screen.getByTestId('bp-contact-deactivate-contact-1')).toBeVisible(),
    );
    promptSpy.mockRestore();
  });

  it('disables qualification changes for a read-only user', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/auth/me') return Promise.resolve(VIEWER_USER);
      if (path === '/v1/business-partners/bp-1') return Promise.resolve(makePartner());
      return Promise.resolve(null);
    });
    render(<BusinessPartnerDetailPage />);
    expect(await screen.findByTestId('bp-detail-qualification')).toBeDisabled();
    expect(screen.queryByTestId('bp-detail-save-supplier-profile')).toBeNull();
  });
});

describe('EditBusinessPartnerPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    useParamsMock.mockReturnValue({ partnerId: 'bp-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it.each([
    [403, 'Forbidden.'],
    [404, 'Not found.'],
  ])('renders the stable edit error for %i', async (status, message) => {
    const { ApiError } = await import('@/lib/api');
    mockedApiFetch.mockRejectedValue(new ApiError(status, { detail: message } as any));
    render(<EditBusinessPartnerPage />);
    expect(await screen.findByTestId('bp-edit-error')).toHaveTextContent(message);
  });

  it('ignores a stale edit load after the route changes', async () => {
    const oldLoad = deferred<any>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/business-partners/bp-1') return oldLoad.promise;
      if (path === '/v1/business-partners/bp-2') {
        return Promise.resolve(makePartner({ id: 'bp-2', legal_name: 'Current Edit' }));
      }
      return Promise.resolve(null);
    });
    const { rerender } = render(<EditBusinessPartnerPage />);
    useParamsMock.mockReturnValue({ partnerId: 'bp-2' });
    rerender(<EditBusinessPartnerPage />);
    expect(await screen.findByDisplayValue('Current Edit')).toBeInTheDocument();
    await act(async () => oldLoad.resolve(makePartner({ legal_name: 'Stale Edit' })));
    expect(screen.queryByDisplayValue('Stale Edit')).toBeNull();
    expect(screen.getByDisplayValue('Current Edit')).toBeInTheDocument();
  });

  it('ignores a mutation completion after the edit route changes', async () => {
    const mutation = deferred<any>();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/business-partners/bp-1' && !init?.method) {
        return Promise.resolve(makePartner());
      }
      if (path === '/v1/business-partners/bp-1' && init?.method === 'PATCH') {
        return mutation.promise;
      }
      if (path === '/v1/business-partners/bp-2') {
        return Promise.resolve(makePartner({ id: 'bp-2', legal_name: 'Current Edit' }));
      }
      return Promise.resolve(null);
    });
    const { rerender } = render(<EditBusinessPartnerPage />);
    fireEvent.click(await screen.findByTestId('bp-edit-submit'));
    useParamsMock.mockReturnValue({ partnerId: 'bp-2' });
    rerender(<EditBusinessPartnerPage />);
    expect(await screen.findByDisplayValue('Current Edit')).toBeInTheDocument();
    await act(async () => mutation.resolve(makePartner({ legal_name: 'Saved Stale Edit' })));
    expect(routerPush).not.toHaveBeenCalledWith('/business-partners/bp-1');
    expect(screen.getByDisplayValue('Current Edit')).toBeInTheDocument();
  });
});
