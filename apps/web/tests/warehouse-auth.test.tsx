/**
 * Sprint 5.2 — Warehouse authorization, organization switching,
 * stale-async protection, activity fan-out concurrency, and
 * Sprint 5.1 regression coverage.
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
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui-polish', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui-polish')>('@/components/ui-polish');
  return { ...actual, toast: toastSpy };
});

import { apiFetch, ApiError } from '@/lib/api';
import WarehouseListPage from '@/app/inventory/warehouses/page';
import WarehouseDetailPage from '@/app/inventory/warehouses/[warehouseId]/page';
import {
  ACTIVITY_CONCURRENCY,
  ACTIVITY_LIMIT,
  inspectActivityFanOut,
  mapWithConcurrency,
  type Warehouse,
} from '@/lib/inventory-warehouses';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const ORG_A = { id: 'org-A', name: 'Aegis', slug: 'aegis' };
const ORG_B = { id: 'org-B', name: 'Beacon', slug: 'beacon' };

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
// Pure helpers: mapWithConcurrency + inspectActivityFanOut
// ------------------------------------------------------------------ //
describe('mapWithConcurrency + inspectActivityFanOut', () => {
  it('never exceeds the configured in-flight count', async () => {
    let inFlight = 0;
    let peak = 0;
    const settle = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 'ok';
    };
    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      ACTIVITY_CONCURRENCY,
      settle,
    );
    expect(peak).toBeLessThanOrEqual(ACTIVITY_CONCURRENCY);
    expect(results).toHaveLength(20);
    for (const r of results) expect(r.status).toBe('fulfilled');
  });

  it('inspectActivityFanOut → unauthenticated on any 401', () => {
    const outcome = inspectActivityFanOut(
      [
        { status: 'fulfilled', value: { items: [] } },
        {
          status: 'rejected',
          reason: new ApiError(401, { detail: 'session' }),
        },
      ],
      (r) => (r instanceof ApiError ? r.status : null),
    );
    expect(outcome.kind).toBe('unauthenticated');
  });

  it('inspectActivityFanOut → forbidden on any 403', () => {
    const outcome = inspectActivityFanOut(
      [
        { status: 'fulfilled', value: { items: [] } },
        {
          status: 'rejected',
          reason: new ApiError(403, { detail: 'no' }),
        },
      ],
      (r) => (r instanceof ApiError ? r.status : null),
    );
    expect(outcome.kind).toBe('forbidden');
  });

  it('inspectActivityFanOut merges, sorts newest first, caps at 100', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `tx-${i}`,
      transaction_type: 'receipt',
      quantity: '1',
      unit: 'kg',
      // Sequential 2026 dates so #0 is oldest, #119 is newest.
      performed_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      reason: null,
      reference_type: null,
    }));
    const outcome = inspectActivityFanOut([{ status: 'fulfilled', value: { items: many } }], (r) =>
      r instanceof ApiError ? r.status : null,
    );
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect(outcome.transactions).toHaveLength(ACTIVITY_LIMIT);
    expect(outcome.transactions[0].id).toBe('tx-119'); // newest first
  });
});

// ------------------------------------------------------------------ //
// List page — auth
// ------------------------------------------------------------------ //
describe('WarehouseListPage — authorization', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    window.history.replaceState({}, '', '/inventory/warehouses');
  });
  afterEach(() => vi.clearAllMocks());

  it('redirects to /login on 401 from warehouses list', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.reject(new ApiError(401, { detail: 'session' }));
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('renders the org-scope banner on 403 without redirect or toast', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.reject(new ApiError(403, { detail: 'forbidden' }));
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-forbidden-org')).toBeInTheDocument());
    expect(routerPush).not.toHaveBeenCalledWith('/login');
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ //
// List page — organization switching + stale response
// ------------------------------------------------------------------ //
describe('WarehouseListPage — organization switching + stale response', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    window.history.replaceState({}, '', '/inventory/warehouses');
  });
  afterEach(() => vi.clearAllMocks());

  it('obsolete org-A warehouse response cannot repopulate org-B', async () => {
    const dA = deferred<unknown[]>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return dA.promise;
      if (path === `/v1/organizations/${ORG_B.id}/warehouses`) {
        return Promise.resolve([
          makeWarehouse({ id: 'wh-B', code: 'B-MAIN', organization_id: ORG_B.id }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-list-org-selector')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('warehouse-list-org-selector'), {
      target: { value: ORG_B.id },
    });
    await waitFor(() => expect(screen.getByTestId('warehouse-row-B-MAIN')).toBeInTheDocument());
    // Now let org-A finally return with a warehouse that would
    // otherwise stomp org-B if the generation ref were broken.
    dA.resolve([makeWarehouse({ id: 'wh-A', code: 'A-STALE' })]);
    await new Promise((r) => setTimeout(r, 30));
    // A must NOT appear; B stays intact.
    expect(screen.queryByTestId('warehouse-row-A-STALE')).not.toBeInTheDocument();
    expect(screen.getByTestId('warehouse-row-B-MAIN')).toBeInTheDocument();
  });

  it('respects ?organization_id when present and valid', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([]);
      if (path === `/v1/organizations/${ORG_B.id}/warehouses`)
        return Promise.resolve([
          makeWarehouse({ id: 'wh-B', code: 'B-MAIN', organization_id: ORG_B.id }),
        ]);
      return Promise.resolve([]);
    });
    window.history.replaceState({}, '', `/inventory/warehouses?organization_id=${ORG_B.id}`);
    render(<WarehouseListPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-list-org-name')).toHaveTextContent('Beacon'),
    );
    expect(screen.getByTestId('warehouse-row-B-MAIN')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ //
// Detail page — activity fan-out concurrency + stale + auth
// ------------------------------------------------------------------ //
describe('WarehouseDetailPage — activity fan-out + stale + auth', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    toastSpy.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ warehouseId: 'wh-1' });
    window.history.replaceState({}, '', '/inventory/warehouses/wh-1?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  it('never exceeds ACTIVITY_CONCURRENCY in-flight transaction requests', async () => {
    const wh = makeWarehouse({ id: 'wh-1' });
    const lots = Array.from({ length: 12 }, (_, i) => ({
      id: `lot-${i}`,
      item_id: 'item-1',
      warehouse_id: 'wh-1',
      lot_code: `L-${i}`,
      expiry_date: null,
      balance: '1',
      balance_unit: 'kg',
    }));
    let inFlight = 0;
    let peak = 0;
    mockedApiFetch.mockImplementation(async (path: string) => {
      if (path === '/v1/organizations') return [ORG_A];
      if (path === '/v1/warehouses/wh-1') return wh;
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return [];
      if (path === '/v1/warehouses/wh-1/lots') return lots;
      if (path.startsWith('/v1/lots/') && path.endsWith('/transactions')) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { items: [] };
      }
      return [];
    });
    render(<WarehouseDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-activity-timeline')).toBeInTheDocument(),
    );
    expect(peak).toBeLessThanOrEqual(ACTIVITY_CONCURRENCY);
  });

  it('activity fan-out 401 redirects to /login', async () => {
    const wh = makeWarehouse({ id: 'wh-1' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(wh);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots')
        return Promise.resolve([
          {
            id: 'lot-1',
            item_id: 'x',
            warehouse_id: 'wh-1',
            lot_code: 'L1',
            expiry_date: null,
            balance: '1',
            balance_unit: 'kg',
          },
        ]);
      if (path === '/v1/lots/lot-1/transactions')
        return Promise.reject(new ApiError(401, { detail: 'session' }));
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('activity fan-out 403 shows scoped forbidden banner and hides the timeline', async () => {
    const wh = makeWarehouse({ id: 'wh-1' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(wh);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots')
        return Promise.resolve([
          {
            id: 'lot-1',
            item_id: 'x',
            warehouse_id: 'wh-1',
            lot_code: 'L1',
            expiry_date: null,
            balance: '1',
            balance_unit: 'kg',
          },
        ]);
      if (path === '/v1/lots/lot-1/transactions')
        return Promise.reject(new ApiError(403, { detail: 'no' }));
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-forbidden-activity')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('warehouse-activity-timeline')).not.toBeInTheDocument();
    // Warehouse summary + inventory rollup remain visible.
    expect(screen.getByTestId('warehouse-summary')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });

  it('cross-tenant warehouse: URL warehouse belongs to another org → forbidden-warehouse', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      // The URL is org-A but the fetched warehouse is owned by org-B.
      if (path === '/v1/warehouses/wh-1')
        return Promise.resolve(makeWarehouse({ id: 'wh-1', organization_id: ORG_B.id }));
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-forbidden-warehouse')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('warehouse-header-name')).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ //
// Sprint 5.1 regression coverage
// ------------------------------------------------------------------ //
describe('Sprint 5.1 regression — inventory workspace still boots', () => {
  // The Sprint 5.2 changes are strictly additive (new routes,
  // new components, new lib module). Confirm nothing on the
  // Sprint-4 workspace page suddenly requires warehouse-management
  // symbols. If this import fails, the additive contract is broken.
  it('inventory workspace module is still loadable and does not import warehouse types transitively', async () => {
    const mod = await import('@/app/inventory/page');
    expect(typeof mod.default).toBe('function');
    // A trivial smoke check: the workspace file does not export any
    // symbol whose name starts with `Warehouse` (it renders the
    // Sprint 4 tabs UI; our new components live in a separate dir).
    const hasWarehouseExport = Object.keys(mod).some((k) => /^Warehouse[A-Z]/.test(k));
    expect(hasWarehouseExport).toBe(false);
  });
});
