/**
 * Sprint 5.2 — Warehouse CRUD tests.
 *
 * Covers create + edit + close + reopen + validation semantics.
 * Uses the same mocking convention as `warehouse-list.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, stableRouter, useParamsMock } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
    useParamsMock: vi.fn(() => ({ warehouseId: '' })),
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  useParams: () => useParamsMock(),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch, ApiError } from '@/lib/api';
import WarehouseListPage from '@/app/inventory/warehouses/page';
import WarehouseDetailPage from '@/app/inventory/warehouses/[warehouseId]/page';
import type { Warehouse } from '@/lib/inventory-warehouses';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const ORG_A = { id: 'org-A', name: 'Aegis', slug: 'aegis' };

function makeWarehouse(over: Partial<Warehouse> = {}): Warehouse {
  return {
    id: 'wh-1',
    organization_id: ORG_A.id,
    farm_id: null,
    site_id: null,
    code: 'MAIN',
    name: 'Main store',
    description: null,
    address: null,
    status: 'active',
    metadata_json: null,
    deleted_at: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-10T00:00:00.000Z',
    ...over,
  };
}

// ------------------------------------------------------------------ //
// Create
// ------------------------------------------------------------------ //
describe('Warehouse create', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    window.history.replaceState({}, '', '/inventory/warehouses');
  });
  afterEach(() => vi.clearAllMocks());

  it('posts the create payload and refetches the list on success', async () => {
    const created = makeWarehouse({ id: 'wh-new', name: 'Cold room', code: 'COLD' });
    let listResponse: unknown[] = [];
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses` && init?.method === 'POST') {
        listResponse = [created];
        return Promise.resolve(created);
      }
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve(listResponse);
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    // Wait for the empty state to appear.
    await waitFor(() => expect(screen.getByTestId('warehouse-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-list-new'));
    fireEvent.change(await screen.findByTestId('warehouse-form-create-name'), {
      target: { value: 'Cold room' },
    });
    fireEvent.change(screen.getByTestId('warehouse-form-create-code'), {
      target: { value: 'COLD' },
    });
    fireEvent.click(screen.getByTestId('warehouse-form-create-submit'));
    await waitFor(() => expect(screen.getByTestId('warehouse-row-COLD')).toBeInTheDocument());
    // The POST call captured the payload.
    const postCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === `/v1/organizations/${ORG_A.id}/warehouses` &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(body).toMatchObject({ name: 'Cold room', code: 'COLD' });
  });

  it('surfaces a duplicate-code error on 409 without refetching', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses` && init?.method === 'POST') {
        return Promise.reject(new ApiError(409, { detail: 'duplicate' }));
      }
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-list-new'));
    fireEvent.change(await screen.findByTestId('warehouse-form-create-name'), {
      target: { value: 'Cold room' },
    });
    fireEvent.change(screen.getByTestId('warehouse-form-create-code'), {
      target: { value: 'COLD' },
    });
    fireEvent.click(screen.getByTestId('warehouse-form-create-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-form-create-error')).toHaveTextContent(
        /already exists/i,
      ),
    );
  });

  it('blocks submit when required fields are empty', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-list-new'));
    // Native `required` blocks submission — the mocked apiFetch must
    // never receive a POST.
    const submit = await screen.findByTestId('warehouse-form-create-submit');
    fireEvent.click(submit);
    const posts = mockedApiFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ //
// Edit + Close + Reopen
// ------------------------------------------------------------------ //
describe('Warehouse edit / close / reopen', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ warehouseId: 'wh-1' });
    window.history.replaceState({}, '', '/inventory/warehouses/wh-1?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  function primeDetail(wh: ReturnType<typeof makeWarehouse>) {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1' && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body ?? '{}'));
        return Promise.resolve({ ...wh, ...patch, updated_at: '2026-02-16T00:00:00Z' });
      }
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(wh);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.resolve([]);
      return Promise.resolve([]);
    });
  }

  it('edits name / description / status via PATCH and rehydrates the header', async () => {
    primeDetail(makeWarehouse({ id: 'wh-1', name: 'Main store', code: 'MAIN', status: 'active' }));
    render(<WarehouseDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-header-name')).toHaveTextContent('Main store'),
    );
    fireEvent.click(screen.getByTestId('warehouse-header-edit'));
    fireEvent.change(await screen.findByTestId('warehouse-form-edit-name'), {
      target: { value: 'Main STORE — renamed' },
    });
    fireEvent.change(screen.getByTestId('warehouse-form-edit-description'), {
      target: { value: 'Renamed by test.' },
    });
    fireEvent.change(screen.getByTestId('warehouse-form-edit-status'), {
      target: { value: 'maintenance' },
    });
    fireEvent.click(screen.getByTestId('warehouse-form-edit-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-header-name')).toHaveTextContent('Main STORE — renamed'),
    );
    // Immutable code field is disabled in edit mode.
    fireEvent.click(screen.getByTestId('warehouse-header-edit'));
    const codeInput = (await screen.findByTestId('warehouse-form-edit-code')) as HTMLInputElement;
    expect(codeInput).toBeDisabled();
  });

  it('close flow: prompt confirmation, PATCH to closed, header shows Reopen', async () => {
    primeDetail(makeWarehouse({ id: 'wh-1', status: 'active' }));
    render(<WarehouseDetailPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-header-close')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-header-close'));
    // Confirmation dialog appears.
    const confirm = await screen.findByTestId('warehouse-detail-status-confirm-confirm');
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId('warehouse-header-reopen')).toBeInTheDocument());
    // Verify the PATCH body carried status='closed'.
    const patchCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === '/v1/warehouses/wh-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ status: 'closed' });
  });

  it('reopen flow: closed warehouse can be reopened via PATCH', async () => {
    primeDetail(makeWarehouse({ id: 'wh-1', status: 'closed' }));
    render(<WarehouseDetailPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-header-reopen')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-header-reopen'));
    fireEvent.click(await screen.findByTestId('warehouse-detail-status-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('warehouse-header-close')).toBeInTheDocument());
    const patchCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === '/v1/warehouses/wh-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ status: 'active' });
  });

  it('surfaces a friendly permission message when edit returns 403', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1' && init?.method === 'PATCH')
        return Promise.reject(new ApiError(403, { detail: 'forbidden' }));
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(makeWarehouse({ id: 'wh-1' }));
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-header-edit')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('warehouse-header-edit'));
    fireEvent.change(await screen.findByTestId('warehouse-form-edit-name'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(screen.getByTestId('warehouse-form-edit-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-form-edit-error')).toHaveTextContent(/permission/i),
    );
  });
});
