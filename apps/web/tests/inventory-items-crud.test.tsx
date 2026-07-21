/**
 * Sprint 5.3 — Group 2: Create, Edit, Lifecycle.
 *
 * Covers the mutation contract:
 *   - valid create + refetch;
 *   - form validation blocks empty submits;
 *   - duplicate-code (409) surfaces a friendly error;
 *   - valid edit + immutable fields (code/category/unit);
 *   - lifecycle confirmation → PATCH is_active;
 *   - lifecycle API failure surfaces a toast rather than
 *     mutating state;
 *   - org switch while POST is pending is safe (stale
 *     completion cannot reload / navigate in the new org).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, stableRouter, useParamsMock } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
    useParamsMock: vi.fn(() => ({ itemId: '' })),
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
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui-polish', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui-polish')>('@/components/ui-polish');
  return { ...actual, toast: toastSpy };
});

import { apiFetch, ApiError } from '@/lib/api';
import InventoryItemListPage from '@/app/inventory/items/page';
import InventoryItemDetailPage from '@/app/inventory/items/[itemId]/page';
import type { InventoryItem } from '@/lib/inventory-items';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const ORG_A = { id: 'org-A', name: 'Aegis', slug: 'aegis' };
const ORG_B = { id: 'org-B', name: 'Beacon', slug: 'beacon' };

function makeItem(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-1',
    organization_id: ORG_A.id,
    code: 'FEED-001',
    name: 'Starter feed',
    description: null,
    category: 'feed',
    canonical_unit: 'kg',
    sku: null,
    is_active: true,
    metadata_json: null,
    deleted_at: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-10T00:00:00.000Z',
    ...over,
  };
}

// ---- Create ------------------------------------------------------- //
describe('Item create', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    window.history.replaceState({}, '', '/inventory/items');
  });
  afterEach(() => vi.clearAllMocks());

  it('posts the create payload and refetches the list on success', async () => {
    const created = makeItem({
      id: 'i-new',
      code: 'MED-01',
      name: 'Antibiotic',
      category: 'medicine',
    });
    let listResponse: InventoryItem[] = [];
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items` && init?.method === 'POST') {
        listResponse = [created];
        return Promise.resolve(created);
      }
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`)
        return Promise.resolve(listResponse);
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-list-new'));
    fireEvent.change(await screen.findByTestId('item-form-create-name'), {
      target: { value: 'Antibiotic' },
    });
    fireEvent.change(screen.getByTestId('item-form-create-code'), {
      target: { value: 'MED-01' },
    });
    fireEvent.change(screen.getByTestId('item-form-create-category'), {
      target: { value: 'medicine' },
    });
    fireEvent.change(screen.getByTestId('item-form-create-unit'), {
      target: { value: 'mL' },
    });
    fireEvent.click(screen.getByTestId('item-form-create-submit'));
    await waitFor(() => expect(screen.getByTestId('item-row-MED-01')).toBeInTheDocument());
    const postCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === `/v1/organizations/${ORG_A.id}/inventory-items` &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      code: 'MED-01',
      name: 'Antibiotic',
      category: 'medicine',
      canonical_unit: 'mL',
    });
  });

  it('409 surfaces a duplicate-code error without dismissing the form', async () => {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items` && init?.method === 'POST') {
        return Promise.reject(new ApiError(409, { detail: 'duplicate' }));
      }
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-list-new'));
    fireEvent.change(await screen.findByTestId('item-form-create-name'), {
      target: { value: 'Duplicate' },
    });
    fireEvent.change(screen.getByTestId('item-form-create-code'), {
      target: { value: 'DUPE' },
    });
    fireEvent.click(screen.getByTestId('item-form-create-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('item-form-create-error')).toHaveTextContent(/already exists/i),
    );
  });

  it('required-field validation blocks empty submits', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-list-new'));
    // Click submit immediately — native `required` blocks the POST.
    fireEvent.click(await screen.findByTestId('item-form-create-submit'));
    const posts = mockedApiFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('org switch while POST is pending: stale completion cannot navigate/reload org-B', async () => {
    // A deferred POST for org-A; org-B loads first.
    let resolvePost!: (v: InventoryItem) => void;
    const postPromise = new Promise<InventoryItem>((res) => {
      resolvePost = res;
    });
    const org_A_items: InventoryItem[] = [];
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items` && init?.method === 'POST') {
        return postPromise;
      }
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve(org_A_items);
      }
      if (path === `/v1/organizations/${ORG_B.id}/inventory-items`) {
        return Promise.resolve([
          makeItem({ id: 'b-1', code: 'BEACON-1', organization_id: ORG_B.id }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    // A empty → open form → fill → submit (POST pends).
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-list-new'));
    fireEvent.change(await screen.findByTestId('item-form-create-name'), {
      target: { value: 'Pending' },
    });
    fireEvent.change(screen.getByTestId('item-form-create-code'), {
      target: { value: 'PEND-A' },
    });
    fireEvent.click(screen.getByTestId('item-form-create-submit'));
    // Switch to B before A's POST resolves. B renders.
    fireEvent.change(screen.getByTestId('item-list-org-selector'), {
      target: { value: ORG_B.id },
    });
    await waitFor(() => expect(screen.getByTestId('item-row-BEACON-1')).toBeInTheDocument());
    const org_B_gets_before = mockedApiFetch.mock.calls.filter(
      ([p, init]) =>
        String(p) === `/v1/organizations/${ORG_B.id}/inventory-items` &&
        (init as RequestInit | undefined)?.method !== 'POST',
    ).length;
    // Resolve A's POST now — it must NOT reload B, must NOT navigate,
    // must NOT show a success toast in B.
    resolvePost(makeItem({ id: 'a-new', code: 'PEND-A' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('item-row-PEND-A')).not.toBeInTheDocument();
    // Critical guarantee: NO additional refetch of org-B's list fired
    // after A's stale POST completed.
    const org_B_gets_after = mockedApiFetch.mock.calls.filter(
      ([p, init]) =>
        String(p) === `/v1/organizations/${ORG_B.id}/inventory-items` &&
        (init as RequestInit | undefined)?.method !== 'POST',
    ).length;
    expect(org_B_gets_after).toBe(org_B_gets_before);
    // No cross-org success toast fired.
    expect(toastSpy).not.toHaveBeenCalledWith(expect.stringMatching(/created/i), 'success');
    // No navigation happened either.
    expect(routerPush).not.toHaveBeenCalledWith(expect.stringMatching(/item/i));
  });
});

// ---- Edit + Lifecycle -------------------------------------------- //
describe('Item edit + lifecycle', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ itemId: 'item-1' });
    window.history.replaceState({}, '', '/inventory/items/item-1?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  function primeDetail(item: InventoryItem) {
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      if (path === '/v1/inventory-items/item-1' && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body ?? '{}'));
        return Promise.resolve({ ...item, ...patch, updated_at: '2026-02-16T00:00:00Z' });
      }
      return Promise.resolve([]);
    });
  }

  it('edit form submits name/description/sku via PATCH and rehydrates the header', async () => {
    primeDetail(makeItem({ id: 'item-1', name: 'Old name', code: 'FEED-01' }));
    render(<InventoryItemDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-header-name')).toHaveTextContent('Old name'),
    );
    fireEvent.click(screen.getByTestId('item-header-edit'));
    fireEvent.change(await screen.findByTestId('item-form-edit-name'), {
      target: { value: 'New name' },
    });
    fireEvent.change(screen.getByTestId('item-form-edit-sku'), {
      target: { value: 'SKU-ALPHA' },
    });
    fireEvent.click(screen.getByTestId('item-form-edit-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('item-header-name')).toHaveTextContent('New name'),
    );
    // Reopen edit and verify code/category/unit are disabled.
    fireEvent.click(screen.getByTestId('item-header-edit'));
    expect(await screen.findByTestId('item-form-edit-code')).toBeDisabled();
    expect(screen.getByTestId('item-form-edit-category')).toBeDisabled();
    expect(screen.getByTestId('item-form-edit-unit')).toBeDisabled();
  });

  it('deactivate flow: confirm → PATCH is_active=false → header shows Activate', async () => {
    primeDetail(makeItem({ id: 'item-1', is_active: true }));
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-header-deactivate')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-header-deactivate'));
    fireEvent.click(await screen.findByTestId('item-detail-status-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('item-header-activate')).toBeInTheDocument());
    const patchCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === '/v1/inventory-items/item-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ is_active: false });
  });

  it('activate flow reactivates via PATCH is_active=true', async () => {
    primeDetail(makeItem({ id: 'item-1', is_active: false }));
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-header-activate')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-header-activate'));
    fireEvent.click(await screen.findByTestId('item-detail-status-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('item-header-deactivate')).toBeInTheDocument());
    const patchCall = mockedApiFetch.mock.calls.find(
      ([p, init]) =>
        String(p) === '/v1/inventory-items/item-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ is_active: true });
  });

  it('lifecycle API failure keeps the item in the current state and toasts an error', async () => {
    const item = makeItem({ id: 'item-1', is_active: true });
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      if (path === '/v1/inventory-items/item-1' && init?.method === 'PATCH') {
        return Promise.reject(new ApiError(500, { detail: 'boom' }));
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-header-deactivate')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-header-deactivate'));
    fireEvent.click(await screen.findByTestId('item-detail-status-confirm-confirm'));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error'));
    // Item is still active because the PATCH failed.
    expect(screen.getByTestId('item-header-deactivate')).toBeInTheDocument();
  });

  it('edit 403 surfaces a scoped permission error message', async () => {
    const item = makeItem({ id: 'item-1' });
    mockedApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      if (path === '/v1/inventory-items/item-1' && init?.method === 'PATCH') {
        return Promise.reject(new ApiError(403, { detail: 'no' }));
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-header-edit')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-header-edit'));
    fireEvent.change(await screen.findByTestId('item-form-edit-name'), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(screen.getByTestId('item-form-edit-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('item-form-edit-error')).toHaveTextContent(/permission/i),
    );
  });
});
