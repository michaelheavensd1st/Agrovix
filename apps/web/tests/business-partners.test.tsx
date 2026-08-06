/**
 * Release 6.0.2 — Business Partner UI tests.
 *
 * Covers list rendering, filters, create submission with the
 * supplier-oriented default, detail-page fetch, and permission
 * gating. Uses the same mocking convention as the warehouse
 * tests: mock ``@/lib/api``'s ``apiFetch`` per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

// ---- fixtures ---------------------------------------------------- //
const ORG = { id: 'org-A', name: 'Aegis Foods', slug: 'aegis' };

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
      if (
        path === `/v1/organizations/${ORG.id}/business-partners` &&
        init?.method === 'POST'
      ) {
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
    fireEvent.change(screen.getByTestId('bp-create-addr-line1'), { target: { value: '1 Silk Rd' } });
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
});
