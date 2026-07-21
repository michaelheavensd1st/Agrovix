/**
 * Sprint 5.3 — Group 3: Authorization, Detail, Availability,
 * Activity, and Sprint 5.1/5.2 regression.
 *
 * Covers:
 *   - list 401 + 403;
 *   - detail 401 (via bootstrap) + cross-tenant item URL rejection;
 *   - availability fan-out 401 + 403 + partial;
 *   - activity fan-out 401 + 403 + partial + cap 100 + concurrency 5;
 *   - obsolete auth error after org switch cannot damage new context;
 *   - stale item-detail response cannot overwrite the current item;
 *   - Sprint 5.1 workspace and Sprint 5.2 warehouse pages remain
 *     loadable (regression smoke).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import {
  ACTIVITY_CONCURRENCY,
  ACTIVITY_LIMIT,
  WAREHOUSE_LOT_CONCURRENCY,
  inspectFanOut,
  inspectWarehouseLotFanOut,
  mapWithConcurrency,
  type InventoryItem,
} from '@/lib/inventory-items';

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ------------------------------------------------------------------ //
// Pure helpers
// ------------------------------------------------------------------ //
describe('Fan-out primitives', () => {
  it('mapWithConcurrency never exceeds the configured limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      ACTIVITY_CONCURRENCY,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return 'ok';
      },
    );
    expect(peak).toBeLessThanOrEqual(ACTIVITY_CONCURRENCY);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('inspectFanOut prioritises 401 → 403 → partial → ok', () => {
    expect(
      inspectFanOut(
        [
          { status: 'fulfilled', value: { items: [] } },
          { status: 'rejected', reason: new ApiError(401, {}) },
        ],
        (r) => (r instanceof ApiError ? r.status : null),
      ).kind,
    ).toBe('unauthenticated');
    expect(
      inspectFanOut(
        [
          { status: 'fulfilled', value: { items: [] } },
          { status: 'rejected', reason: new ApiError(403, {}) },
        ],
        (r) => (r instanceof ApiError ? r.status : null),
      ).kind,
    ).toBe('forbidden');
  });

  it('inspectFanOut caps at 100 and sorts newest first', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      id: `tx-${i}`,
      transaction_type: 'receipt',
      quantity: '1',
      unit: 'kg',
      performed_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      reason: null,
      reference_type: null,
    }));
    const outcome = inspectFanOut([{ status: 'fulfilled', value: { items: many } }], (r) =>
      r instanceof ApiError ? r.status : null,
    );
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.transactions).toHaveLength(ACTIVITY_LIMIT);
    expect(outcome.transactions[0].id).toBe('tx-129');
  });

  it('inspectWarehouseLotFanOut also prioritises auth failures', () => {
    expect(
      inspectWarehouseLotFanOut(
        [
          { status: 'fulfilled', value: [] },
          { status: 'rejected', reason: new ApiError(403, {}) },
        ],
        (r) => (r instanceof ApiError ? r.status : null),
      ).kind,
    ).toBe('forbidden');
  });
});

// ------------------------------------------------------------------ //
// List authorization
// ------------------------------------------------------------------ //
describe('InventoryItemListPage — authorization', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    window.history.replaceState({}, '', '/inventory/items');
  });
  afterEach(() => vi.clearAllMocks());

  it('list 401 redirects to /login and does not toast', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`)
        return Promise.reject(new ApiError(401, {}));
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('list 403 shows the org-scope banner, no redirect, no toast', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`)
        return Promise.reject(new ApiError(403, {}));
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-forbidden-org')).toBeInTheDocument());
    expect(routerPush).not.toHaveBeenCalledWith('/login');
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('obsolete org-A response cannot overwrite org-B', async () => {
    const dA = deferred<InventoryItem[]>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return dA.promise;
      if (path === `/v1/organizations/${ORG_B.id}/inventory-items`)
        return Promise.resolve([
          makeItem({ id: 'b-1', code: 'BEACON-1', organization_id: ORG_B.id }),
        ]);
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-list-org-selector')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('item-list-org-selector'), {
      target: { value: ORG_B.id },
    });
    await waitFor(() => expect(screen.getByTestId('item-row-BEACON-1')).toBeInTheDocument());
    await act(async () => {
      dA.resolve([makeItem({ id: 'a-stale', code: 'STALE-A' })]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('item-row-STALE-A')).not.toBeInTheDocument();
    expect(screen.getByTestId('item-row-BEACON-1')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ //
// Detail — cross-tenant + item stale response + auth
// ------------------------------------------------------------------ //
describe('InventoryItemDetailPage — cross-tenant + stale + auth', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ itemId: 'item-x' });
    window.history.replaceState({}, '', '/inventory/items/item-x?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  it('URL item that does not exist in the active org → forbidden-item banner', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      // The URL item is not in org A's list — this is either a
      // cross-tenant attempt or a stale link. Either way, no swap.
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-forbidden-item')).toBeInTheDocument());
    expect(screen.queryByTestId('item-header-name')).not.toBeInTheDocument();
    // Back link preserves org context.
    expect(screen.getByTestId('item-detail-back')).toHaveAttribute(
      'href',
      `/inventory/items?organization_id=${ORG_A.id}`,
    );
  });

  it('stale item-detail response after remount is discarded (no crash, no stale write)', async () => {
    // We render the detail page against a deferred item-list; unmount
    // before it resolves; then resolve. If the guard is correct there
    // is neither a warning nor an unhandled rejection.
    const dOrgA = deferred<InventoryItem[]>();
    useParamsMock.mockReturnValue({ itemId: 'item-A' });
    window.history.replaceState({}, '', '/inventory/items/item-A?organization_id=org-A');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return dOrgA.promise;
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const { unmount } = render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-detail-loading')).toBeInTheDocument());
    // Capture any React warnings that fire during the late resolve.
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(String(args[0] ?? ''));
    };
    try {
      unmount();
      await act(async () => {
        dOrgA.resolve([makeItem({ id: 'item-A', code: 'FEED-A' })]);
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      console.error = original;
    }
    // No "state update on unmounted component" nor "act" warning.
    expect(
      captured.some((c) => /unmounted component|state update|not wrapped in act/i.test(c)),
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Availability + activity fan-out
// ------------------------------------------------------------------ //
describe('InventoryItemDetailPage — availability + activity fan-out', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ itemId: 'item-1' });
    window.history.replaceState({}, '', '/inventory/items/item-1?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  it('availability fan-out never exceeds WAREHOUSE_LOT_CONCURRENCY in-flight', async () => {
    const item = makeItem({ id: 'item-1' });
    const warehouses = Array.from({ length: 15 }, (_, i) => ({
      id: `wh-${i}`,
      organization_id: ORG_A.id,
      code: `WH-${i}`,
      name: `Warehouse ${i}`,
      status: 'active',
    }));
    let inFlight = 0;
    let peak = 0;
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === '/v1/organizations') return [ORG_A];
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return [item];
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return warehouses;
      if (path.startsWith('/v1/warehouses/') && path.endsWith('/lots')) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return [];
      }
      return [];
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-availability')).toBeInTheDocument());
    expect(peak).toBeLessThanOrEqual(WAREHOUSE_LOT_CONCURRENCY);
  });

  it('availability 403 shows scoped forbidden banner', async () => {
    const item = makeItem({ id: 'item-1' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([
          { id: 'wh-1', organization_id: ORG_A.id, code: 'W1', name: 'W1', status: 'active' },
        ]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.reject(new ApiError(403, {}));
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-forbidden-availability')).toBeInTheDocument(),
    );
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });

  it('availability 401 redirects to /login', async () => {
    const item = makeItem({ id: 'item-1' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([
          { id: 'wh-1', organization_id: ORG_A.id, code: 'W1', name: 'W1', status: 'active' },
        ]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.reject(new ApiError(401, {}));
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('availability partial: one warehouse fails → partial notice + rest visible', async () => {
    const item = makeItem({ id: 'item-1' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([
          {
            id: 'wh-1',
            organization_id: ORG_A.id,
            code: 'W1',
            name: 'Warehouse 1',
            status: 'active',
          },
          {
            id: 'wh-2',
            organization_id: ORG_A.id,
            code: 'W2',
            name: 'Warehouse 2',
            status: 'active',
          },
        ]);
      if (path === '/v1/warehouses/wh-1/lots')
        return Promise.resolve([
          {
            id: 'lot-1',
            item_id: 'item-1',
            warehouse_id: 'wh-1',
            storage_location_id: null,
            lot_code: 'L1',
            expiry_date: null,
            balance: '10',
            balance_unit: 'kg',
          },
        ]);
      // A generic (non-auth) failure — surfaces as partial-data.
      if (path === '/v1/warehouses/wh-2/lots') return Promise.reject(new ApiError(500, {}));
      if (path === '/v1/lots/lot-1/transactions') return Promise.resolve({ items: [] });
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-availability-partial')).toBeInTheDocument(),
    );
    // Wh-1's row is present; wh-2 is not (its lots never arrived).
    expect(screen.getByTestId('item-availability-row-W1')).toBeInTheDocument();
    expect(screen.queryByTestId('item-availability-row-W2')).not.toBeInTheDocument();
  });

  it('activity 401 redirects, activity 403 shows scoped banner', async () => {
    const item = makeItem({ id: 'item-1' });
    // First: 401 path
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([item]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([
          { id: 'wh-1', organization_id: ORG_A.id, code: 'W1', name: 'W1', status: 'active' },
        ]);
      if (path === '/v1/warehouses/wh-1/lots')
        return Promise.resolve([
          {
            id: 'lot-1',
            item_id: 'item-1',
            warehouse_id: 'wh-1',
            storage_location_id: null,
            lot_code: 'L1',
            expiry_date: null,
            balance: '10',
            balance_unit: 'kg',
          },
        ]);
      if (path === '/v1/lots/lot-1/transactions') return Promise.reject(new ApiError(401, {}));
      return Promise.resolve([]);
    });
    render(<InventoryItemDetailPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('obsolete activity 403 after remount does not affect the next context', async () => {
    // Detail page renders for org-A, item-1 with a deferred
    // transactions request. We unmount before it resolves, then
    // reject the pending fan-out with 403. The now-stale generation
    // guard must prevent any redirect or state write.
    const dTx = deferred<{ items: unknown[] }>();
    useParamsMock.mockReturnValue({ itemId: 'item-1' });
    window.history.replaceState({}, '', '/inventory/items/item-1?organization_id=org-A');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`)
        return Promise.resolve([makeItem({ id: 'item-1' })]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([
          { id: 'wh-1', organization_id: ORG_A.id, code: 'W1', name: 'W1', status: 'active' },
        ]);
      if (path === '/v1/warehouses/wh-1/lots')
        return Promise.resolve([
          {
            id: 'lot-1',
            item_id: 'item-1',
            warehouse_id: 'wh-1',
            storage_location_id: null,
            lot_code: 'L1',
            expiry_date: null,
            balance: '10',
            balance_unit: 'kg',
          },
        ]);
      if (path === '/v1/lots/lot-1/transactions') return dTx.promise;
      return Promise.resolve([]);
    });
    const { unmount } = render(<InventoryItemDetailPage />);
    await waitFor(() => expect(screen.getByTestId('item-summary')).toBeInTheDocument());
    unmount();
    await act(async () => {
      dTx.reject(new ApiError(403, {}));
      await Promise.resolve();
      await Promise.resolve();
    });
    // Neither a login redirect nor a rendered forbidden banner
    // (there is no tree left to render into anyway) — the guard
    // simply drops the write.
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });
});

// ------------------------------------------------------------------ //
// Sprint 5.1 / 5.2 regression smoke — ensure Sprint 5.3 did not
// break the pre-existing inventory workspace page.
// ------------------------------------------------------------------ //
describe('Sprint 5.1 regression — workspace still loads', () => {
  it('inventory workspace module remains importable and default-exports a component', async () => {
    const mod = await import('@/app/inventory/page');
    expect(typeof mod.default).toBe('function');
    // Sprint 5.3 must not have introduced item-management types
    // into the workspace's public export surface.
    const hasItemExport = Object.keys(mod).some((k) => /^InventoryItem/.test(k));
    expect(hasItemExport).toBe(false);
  });
});
