import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, stableRouter } = vi.hoisted(() => {
  const push = vi.fn();
  return { routerPush: push, stableRouter: { push, replace: vi.fn(), back: vi.fn() } };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ siteId: 'site-1' }),
  useRouter: () => stableRouter,
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock('@/components/ui-polish', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui-polish')>('@/components/ui-polish');
  return { ...actual, toast: vi.fn() };
});

import SiteUnitsPage from '@/app/sites/[siteId]/page';
import { ApiError, apiFetch } from '@/lib/api';
import type {
  CurrentUser,
  Farm,
  ProductionSite,
  ProductionUnit,
  ProductionUnitType,
} from '@/lib/types';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const SITE: ProductionSite = {
  id: 'site-1',
  farm_id: 'farm-1',
  name: 'Main Site',
  code: 'MAIN',
  status: 'active',
};
const FARM: Farm = {
  id: 'farm-1',
  organization_id: 'org-1',
  name: 'Test Farm',
  code: 'FARM',
  deleted_at: null,
};
const ADMIN: CurrentUser = {
  id: 'user-1',
  email: 'admin@example.com',
  full_name: 'Administrator',
  is_active: true,
  is_verified: true,
  is_superuser: true,
  permissions: [],
};
const SYSTEM_TYPE: ProductionUnitType = {
  id: 'type-system',
  organization_id: null,
  code: 'GROW_OUT_POND',
  name: 'grow_out_pond',
  display_name: 'Grow-out Pond',
  plural_name: 'Grow-out Ponds',
  vertical: 'aquaculture',
  category: 'pond',
  is_system: true,
};
const CUSTOM_TYPE: ProductionUnitType = {
  ...SYSTEM_TYPE,
  id: 'type-custom',
  organization_id: 'org-1',
  code: 'CUSTOM_TANK',
  display_name: 'Custom Tank',
  plural_name: 'Custom Tanks',
  is_system: false,
};
const CREATED: ProductionUnit = {
  id: 'unit-1',
  site_id: 'site-1',
  unit_type_id: SYSTEM_TYPE.id,
  name: 'Pond One',
  code: 'POND-01',
  capacity: 10000,
  status: 'active',
};

function baseMock({
  units = [],
  user = ADMIN,
  types = [SYSTEM_TYPE, CUSTOM_TYPE],
}: {
  units?: ProductionUnit[];
  user?: CurrentUser;
  types?: ProductionUnitType[];
} = {}) {
  mockedApiFetch.mockImplementation((path: string) => {
    if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
    if (path === '/v1/sites/site-1/units') return Promise.resolve(units);
    if (path === '/v1/auth/me') return Promise.resolve(user);
    if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
    if (path === '/v1/production-unit-types?organization_id=org-1') {
      return Promise.resolve(types);
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
}

async function openDialog() {
  await waitFor(() => expect(screen.getByText('No units yet')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('site-create-unit-empty'));
  expect(await screen.findByRole('dialog', { name: 'Create Production Unit' })).toBeInTheDocument();
}

function fillValidForm() {
  fireEvent.change(screen.getByTestId('production-unit-field-type'), {
    target: { value: SYSTEM_TYPE.id },
  });
  fireEvent.change(screen.getByTestId('production-unit-field-name'), {
    target: { value: 'Pond One' },
  });
  fireEvent.change(screen.getByTestId('production-unit-field-code'), {
    target: { value: 'POND-01' },
  });
  fireEvent.change(screen.getByTestId('production-unit-field-capacity'), {
    target: { value: '10000' },
  });
}

describe('Production Unit creation', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
  });

  it('renders helpful empty-state and header actions only for an authorized user', async () => {
    baseMock();
    const { unmount } = render(<SiteUnitsPage />);
    await waitFor(() => expect(screen.getByText('No units yet')).toBeInTheDocument());
    expect(screen.getByTestId('site-create-unit-header')).toBeInTheDocument();
    expect(screen.getByTestId('site-create-unit-empty')).toBeInTheDocument();
    expect(screen.getByText(/Create the first pond, cage, tank/i)).toBeInTheDocument();

    unmount();
    mockedApiFetch.mockReset();
    baseMock({ user: { ...ADMIN, is_superuser: false, permissions: [] } });
    render(<SiteUnitsPage />);
    await waitFor(() => expect(screen.getByText('No units yet')).toBeInTheDocument());
    expect(screen.queryByTestId('site-create-unit-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('site-create-unit-empty')).not.toBeInTheDocument();
  });

  it('shows unit-type loading and then system and organization-specific options', async () => {
    let resolveTypes!: (types: ProductionUnitType[]) => void;
    const typePromise = new Promise<ProductionUnitType[]>((resolve) => {
      resolveTypes = resolve;
    });
    baseMock();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path === '/v1/production-unit-types?organization_id=org-1') return typePromise;
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    expect(screen.getByTestId('production-unit-field-type')).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Loading unit types…' })).toBeInTheDocument();

    resolveTypes([SYSTEM_TYPE, CUSTOM_TYPE]);
    expect(
      await screen.findByRole('option', { name: /Grow-out Pond — System/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Custom Tank — Organization/ })).toBeInTheDocument();
  });

  it('posts the complete payload, closes, renders immediately, and refreshes the list', async () => {
    let listCalls = 0;
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path === '/v1/production-unit-types?organization_id=org-1') {
        return Promise.resolve([SYSTEM_TYPE, CUSTOM_TYPE]);
      }
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.resolve(CREATED);
      }
      if (path === '/v1/sites/site-1/units') {
        listCalls += 1;
        return Promise.resolve(listCalls === 1 ? [] : [CREATED]);
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));

    expect(await screen.findByTestId('unit-card-POND-01')).toHaveTextContent('Pond One');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBe(2));
    const post = mockedApiFetch.mock.calls.find(
      ([path, init]) => path === '/v1/sites/site-1/units' && init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      unit_type_id: 'type-system',
      name: 'Pond One',
      code: 'POND-01',
      capacity: 10000,
      status: 'active',
    });
  });

  it('blocks invalid local values and presents inline validation', async () => {
    baseMock();
    render(<SiteUnitsPage />);
    await openDialog();
    fireEvent.change(screen.getByTestId('production-unit-field-capacity'), {
      target: { value: '-1' },
    });
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    expect(await screen.findByText('Select a unit type.')).toBeInTheDocument();
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Code is required.')).toBeInTheDocument();
    expect(screen.getByText(/Capacity must be a whole number/i)).toBeInTheDocument();
    expect(mockedApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('maps 422 server validation errors to their fields', async () => {
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.reject(
          new ApiError(422, {
            detail: [
              { loc: ['body', 'capacity'], msg: 'Input should be greater than or equal to 0' },
            ],
          } as never),
        );
      }
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    expect(await screen.findByText(/greater than or equal to 0/i)).toBeInTheDocument();
    expect(screen.getByTestId('production-unit-create-error')).toHaveTextContent(/highlighted/i);
  });

  it('keeps the dialog open and identifies duplicate codes on 409', async () => {
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.reject(new ApiError(409, { detail: 'duplicate' }));
      }
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    expect(await screen.findByText(/already exists at the site/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('handles create authorization failures and redirects expired sessions', async () => {
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.reject(new ApiError(403, { detail: 'forbidden' }));
      }
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    const { unmount } = render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    expect(await screen.findByText(/don't have permission to create/i)).toBeInTheDocument();

    unmount();
    mockedApiFetch.mockReset();
    mockedApiFetch.mockRejectedValue(new ApiError(401, { detail: 'expired' }));
    render(<SiteUnitsPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('surfaces empty unit types and disables submission', async () => {
    baseMock({ types: [] });
    render(<SiteUnitsPage />);
    await openDialog();
    expect(screen.getByRole('option', { name: 'No unit types available' })).toBeInTheDocument();
    expect(screen.getByTestId('production-unit-create-submit')).toBeDisabled();
    expect(screen.getByText(/No system or organization unit types/i)).toBeInTheDocument();
  });

  it('surfaces a network failure without closing the dialog', async () => {
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.reject(new Error('Network request failed'));
      }
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    expect(await screen.findByText('Network request failed')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('production-unit-create-submit')).toBeEnabled();
  });

  it('disables submission while the create request is pending and prevents duplicates', async () => {
    let resolveCreate!: (unit: ProductionUnit) => void;
    const createPromise = new Promise<ProductionUnit>((resolve) => {
      resolveCreate = resolve;
    });
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') return createPromise;
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    const submit = screen.getByTestId('production-unit-create-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('Creating…');
    expect(
      mockedApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    resolveCreate(CREATED);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('redirects to login when creation returns 401', async () => {
    baseMock();
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/sites/site-1/units' && init?.method === 'POST') {
        return Promise.reject(new ApiError(401, { detail: 'expired' }));
      }
      if (path === '/v1/sites/site-1') return Promise.resolve(SITE);
      if (path === '/v1/sites/site-1/units') return Promise.resolve([]);
      if (path === '/v1/auth/me') return Promise.resolve(ADMIN);
      if (path === '/v1/farms/farm-1') return Promise.resolve(FARM);
      if (path.startsWith('/v1/production-unit-types')) return Promise.resolve([SYSTEM_TYPE]);
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    render(<SiteUnitsPage />);
    await openDialog();
    fillValidForm();
    fireEvent.click(screen.getByTestId('production-unit-create-submit'));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('focuses the first field and restores focus to the trigger after close', async () => {
    baseMock();
    render(<SiteUnitsPage />);
    await waitFor(() => expect(screen.getByText('No units yet')).toBeInTheDocument());
    const trigger = screen.getByTestId('site-create-unit-header');
    trigger.focus();
    fireEvent.click(trigger);
    const firstField = await screen.findByTestId('production-unit-field-type');
    await waitFor(() => expect(firstField).toHaveFocus());
    fireEvent.click(screen.getByTestId('production-unit-create-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
