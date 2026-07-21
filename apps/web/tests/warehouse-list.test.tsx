/**
 * Sprint 5.2 — Warehouse list, search, filters, sorting, and
 * detail-page happy-path rendering. Pure aggregation helpers
 * from `@/lib/inventory-warehouses` are covered inline before the
 * page-level integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---- module mocks ------------------------------------------------- //
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

import { apiFetch } from '@/lib/api';
import WarehouseListPage from '@/app/inventory/warehouses/page';
import WarehouseDetailPage from '@/app/inventory/warehouses/[warehouseId]/page';
import {
  deriveScope,
  filterWarehouses,
  sortWarehouses,
  resolveOrganizationId,
  buildWarehouseInventoryRows,
  LOW_STOCK_THRESHOLD,
  type Warehouse,
} from '@/lib/inventory-warehouses';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

// ---- fixtures ----------------------------------------------------- //
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
    description: 'Primary storage facility.',
    address: '10 Ocean Dr.',
    status: 'active',
    metadata_json: null,
    deleted_at: null,
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-10T00:00:00.000Z',
    ...over,
  };
}

function setLocationSearch(search: string) {
  window.history.replaceState({}, '', `/inventory/warehouses${search}`);
}

// ---- pure helpers ------------------------------------------------- //
describe('inventory-warehouses helpers', () => {
  it('deriveScope maps farm_id → farm_linked / organization_wide', () => {
    expect(deriveScope({ farm_id: null })).toBe('organization_wide');
    expect(deriveScope({ farm_id: 'farm-1' })).toBe('farm_linked');
  });

  it('resolveOrganizationId honours a valid requested id, falls back to first otherwise', () => {
    const orgs = [{ id: 'a' }, { id: 'b' }];
    expect(resolveOrganizationId('b', orgs)).toBe('b');
    expect(resolveOrganizationId('spoofed', orgs)).toBe('a');
    expect(resolveOrganizationId(null, orgs)).toBe('a');
    expect(resolveOrganizationId('a', [])).toBeNull();
  });

  it('filterWarehouses respects query + status + scope', () => {
    const rows = [
      makeWarehouse({ id: '1', name: 'Main', code: 'M', status: 'active', farm_id: null }),
      makeWarehouse({ id: '2', name: 'Cold', code: 'C', status: 'closed', farm_id: 'f-1' }),
      makeWarehouse({ id: '3', name: 'Dry', code: 'D', status: 'active', farm_id: 'f-1' }),
    ];
    expect(filterWarehouses(rows, { query: 'main', status: 'all', scope: 'all' })).toHaveLength(1);
    expect(filterWarehouses(rows, { query: '', status: 'closed', scope: 'all' })).toHaveLength(1);
    expect(filterWarehouses(rows, { query: '', status: 'all', scope: 'farm_linked' })).toHaveLength(
      2,
    );
  });

  it('sortWarehouses supports name, code, status, updated_at in both directions', () => {
    const rows = [
      makeWarehouse({ id: '1', name: 'Bravo', code: 'B', updated_at: '2026-02-05T00:00:00Z' }),
      makeWarehouse({ id: '2', name: 'Alpha', code: 'A', updated_at: '2026-02-10T00:00:00Z' }),
    ];
    expect(sortWarehouses(rows, { key: 'name', direction: 'asc' }).map((r) => r.id)).toEqual([
      '2',
      '1',
    ]);
    expect(sortWarehouses(rows, { key: 'updated_at', direction: 'desc' }).map((r) => r.id)).toEqual(
      ['2', '1'],
    );
  });

  it('buildWarehouseInventoryRows flags low_stock / expiring / expired', () => {
    const rows = buildWarehouseInventoryRows({
      lots: [
        {
          id: 'l-ok',
          item_id: 'i-1',
          warehouse_id: 'wh-1',
          lot_code: 'L1',
          expiry_date: null,
          balance: '50',
          balance_unit: 'kg',
        },
        {
          id: 'l-low',
          item_id: 'i-2',
          warehouse_id: 'wh-1',
          lot_code: 'L2',
          expiry_date: null,
          balance: String(LOW_STOCK_THRESHOLD - 1),
          balance_unit: 'kg',
        },
        {
          id: 'l-exp',
          item_id: 'i-3',
          warehouse_id: 'wh-1',
          lot_code: 'L3',
          expiry_date: '2020-01-01',
          balance: '10',
          balance_unit: 'mL',
        },
      ],
      items: [
        { id: 'i-1', code: 'FEED', name: 'Feed', category: 'feed', canonical_unit: 'kg' },
        { id: 'i-2', code: 'MED', name: 'Med', category: 'medicine', canonical_unit: 'kg' },
        { id: 'i-3', code: 'CHM', name: 'Chem', category: 'chemical', canonical_unit: 'mL' },
      ],
      nowIso: '2026-02-15T00:00:00Z',
    });
    const byCode = new Map(rows.map((r) => [r.item_code, r]));
    expect(byCode.get('FEED')?.low_stock).toBe(false);
    expect(byCode.get('MED')?.low_stock).toBe(true);
    expect(byCode.get('CHM')?.has_expired).toBe(true);
  });
});

// ---- page: list --------------------------------------------------- //
describe('WarehouseListPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    setLocationSearch('');
  });
  afterEach(() => vi.clearAllMocks());

  it('shows a loading skeleton then the populated table', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) {
        return Promise.resolve([
          makeWarehouse({ id: 'wh-1', name: 'Main store', code: 'MAIN' }),
          makeWarehouse({ id: 'wh-2', name: 'Cold room', code: 'COLD', status: 'closed' }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    expect(await screen.findByTestId('warehouse-list-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('warehouse-row-MAIN')).toBeInTheDocument());
    expect(screen.getByTestId('warehouse-row-COLD')).toBeInTheDocument();
    expect(screen.getByTestId('warehouse-status-badge-closed')).toBeInTheDocument();
  });

  it('shows the empty state when no warehouses exist', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-empty-state')).toBeInTheDocument());
    expect(screen.queryByTestId('warehouse-table')).not.toBeInTheDocument();
  });

  it('debounced search + status filter narrow the visible rows', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) {
        return Promise.resolve([
          makeWarehouse({ id: 'wh-1', name: 'Main store', code: 'MAIN', status: 'active' }),
          makeWarehouse({ id: 'wh-2', name: 'Cold room', code: 'COLD', status: 'closed' }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-row-MAIN')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('warehouse-search'), { target: { value: 'cold' } });
    await waitFor(
      () => {
        expect(screen.queryByTestId('warehouse-row-MAIN')).not.toBeInTheDocument();
        expect(screen.getByTestId('warehouse-row-COLD')).toBeInTheDocument();
      },
      { timeout: 800 },
    );
    // Clear + filter by status only.
    fireEvent.change(screen.getByTestId('warehouse-search'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('warehouse-filter-status'), {
      target: { value: 'closed' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('warehouse-row-MAIN')).not.toBeInTheDocument();
      expect(screen.getByTestId('warehouse-row-COLD')).toBeInTheDocument();
    });
  });

  it('sort-by-name toggles asc → desc', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`) {
        return Promise.resolve([
          makeWarehouse({ id: 'wh-2', name: 'Bravo', code: 'B' }),
          makeWarehouse({ id: 'wh-1', name: 'Alpha', code: 'A' }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-table')).toBeInTheDocument());
    // Default is name asc → Alpha first
    const rowsAsc = within(screen.getByTestId('warehouse-table')).getAllByRole('row');
    // rowsAsc[0] is the header row; rowsAsc[1] is the first body row.
    expect(rowsAsc[1]).toHaveAttribute('data-testid', 'warehouse-row-A');
    // Click name again to flip to desc → Bravo first
    fireEvent.click(screen.getByTestId('warehouse-table-sort-name'));
    const rowsDesc = within(screen.getByTestId('warehouse-table')).getAllByRole('row');
    expect(rowsDesc[1]).toHaveAttribute('data-testid', 'warehouse-row-B');
  });

  it('surfaces the org-scope forbidden banner when list returns 403', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.reject(new ApiError(403, { detail: 'forbidden' }));
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-forbidden-org')).toBeInTheDocument());
    expect(routerPush).not.toHaveBeenCalledWith('/login');
    expect(screen.queryByTestId('warehouse-table')).not.toBeInTheDocument();
  });

  it('preserves organization context when switching orgs from the selector', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/warehouses`)
        return Promise.resolve([makeWarehouse({ id: 'wh-A', code: 'A-MAIN' })]);
      if (path === `/v1/organizations/${ORG_B.id}/warehouses`)
        return Promise.resolve([
          makeWarehouse({ id: 'wh-B', code: 'B-MAIN', organization_id: ORG_B.id }),
        ]);
      return Promise.resolve([]);
    });
    render(<WarehouseListPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-row-A-MAIN')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('warehouse-list-org-selector'), {
      target: { value: ORG_B.id },
    });
    await waitFor(() => {
      expect(screen.getByTestId('warehouse-row-B-MAIN')).toBeInTheDocument();
      expect(screen.queryByTestId('warehouse-row-A-MAIN')).not.toBeInTheDocument();
    });
  });
});

// ---- page: detail happy path ------------------------------------- //
describe('WarehouseDetailPage — happy path', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    useParamsMock.mockReset();
    useParamsMock.mockReturnValue({ warehouseId: 'wh-1' });
    window.history.replaceState({}, '', '/inventory/warehouses/wh-1?organization_id=org-A');
  });
  afterEach(() => vi.clearAllMocks());

  it('renders header, summary, inventory rollup, activity, quick actions', async () => {
    const wh = makeWarehouse({ id: 'wh-1', name: 'Main store', code: 'MAIN' });
    const items = [
      { id: 'item-1', code: 'FEED', name: 'Starter feed', category: 'feed', canonical_unit: 'kg' },
    ];
    const lots = [
      {
        id: 'lot-1',
        item_id: 'item-1',
        warehouse_id: 'wh-1',
        lot_code: 'L-1',
        expiry_date: null,
        balance: '25',
        balance_unit: 'kg',
      },
    ];
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(wh);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve(items);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.resolve(lots);
      if (path === '/v1/lots/lot-1/transactions') {
        return Promise.resolve({
          items: [
            {
              id: 'tx-1',
              transaction_type: 'receipt',
              quantity: '25',
              unit: 'kg',
              performed_at: '2026-02-14T12:00:00.000Z',
              reason: null,
              reference_type: null,
              lot_id: 'lot-1',
            },
          ],
        });
      }
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-header-name')).toHaveTextContent('Main store'),
    );
    expect(screen.getByTestId('warehouse-summary')).toBeInTheDocument();
    expect(screen.getByTestId('warehouse-inventory-table')).toBeInTheDocument();
    expect(screen.getByTestId('warehouse-inventory-row-FEED')).toHaveTextContent('25 kg');
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-activity-row-tx-1')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('warehouse-quick-action-receive')).toBeInTheDocument();
  });

  it('shows the closed-warehouse guard: quick actions disabled except history', async () => {
    const wh = makeWarehouse({ id: 'wh-1', status: 'closed', code: 'CLOSED' });
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === '/v1/warehouses/wh-1') return Promise.resolve(wh);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === '/v1/warehouses/wh-1/lots') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<WarehouseDetailPage />);
    await waitFor(() => expect(screen.getByTestId('warehouse-quick-actions')).toBeInTheDocument());
    expect(screen.getByTestId('warehouse-quick-action-receive')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // History still opens the workspace.
    expect(screen.getByTestId('warehouse-quick-action-history')).toHaveAttribute('href');
    // Header shows a Reopen button (not Close).
    expect(screen.getByTestId('warehouse-header-reopen')).toBeInTheDocument();
  });
});
