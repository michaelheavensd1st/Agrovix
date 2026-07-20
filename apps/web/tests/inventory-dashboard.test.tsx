/**
 * Sprint 5.1 — Inventory Dashboard tests.
 *
 * We split the coverage into two layers:
 *
 *   1. Pure aggregation unit tests over `buildDashboardProjection`
 *      — deterministic, easy to reason about, no I/O.
 *   2. React rendering tests over the dashboard page + panels using
 *      a mocked `apiFetch` so we can exercise loading / empty /
 *      error / 401 / 403 states end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import {
  ATTENTION_LIST_LIMIT,
  buildDashboardProjection,
  classifyLot,
  daysBetween,
  EXPIRING_SOON_DAYS,
  parseBalance,
  RECENT_ACTIVITY_LIMIT,
  type DashboardInventoryItem,
  type DashboardLot,
  type DashboardWarehouse,
} from '@/lib/inventory-dashboard';
import { InventoryDashboardSummaryCards } from '@/components/inventory-dashboard/summary-cards';
import { InventoryDashboardAttentionPanel } from '@/components/inventory-dashboard/attention-panel';
import { InventoryDashboardRecentActivity } from '@/components/inventory-dashboard/recent-activity';
import { InventoryDashboardQuickActions } from '@/components/inventory-dashboard/quick-actions';

// --------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------- //

const NOW = '2026-02-15T12:00:00.000Z';

const WH_MAIN: DashboardWarehouse = {
  id: 'wh-1',
  code: 'MAIN',
  name: 'Main store',
  status: 'active',
  farm_id: null,
  organization_id: 'org-1',
};
const WH_COLD: DashboardWarehouse = {
  id: 'wh-2',
  code: 'COLD',
  name: 'Cold room',
  status: 'active',
  farm_id: null,
  organization_id: 'org-1',
};
const WH_CLOSED: DashboardWarehouse = {
  id: 'wh-3',
  code: 'ARCH',
  name: 'Archived',
  status: 'closed',
  farm_id: null,
  organization_id: 'org-1',
};

const ITEM_FEED: DashboardInventoryItem = {
  id: 'item-1',
  code: 'F-STARTER',
  name: 'Starter feed',
  category: 'feed',
  canonical_unit: 'kg',
  is_active: true,
};
const ITEM_MED: DashboardInventoryItem = {
  id: 'item-2',
  code: 'M-VACC',
  name: 'Vaccine A',
  category: 'medicine',
  canonical_unit: 'mL',
  is_active: true,
};
const ITEM_INACTIVE: DashboardInventoryItem = {
  id: 'item-3',
  code: 'S-BAG',
  name: 'Old bags',
  category: 'supply',
  canonical_unit: 'count',
  is_active: false,
};

function makeLot(overrides: Partial<DashboardLot>): DashboardLot {
  return {
    id: 'lot-x',
    item_id: 'item-1',
    warehouse_id: 'wh-1',
    storage_location_id: null,
    lot_code: 'L-DEFAULT',
    expiry_date: null,
    balance: '100',
    balance_unit: 'kg',
    updated_at: '2026-02-14T10:00:00.000Z',
    created_at: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

// --------------------------------------------------------------------- //
// Pure aggregation unit tests
// --------------------------------------------------------------------- //

describe('inventory-dashboard aggregation', () => {
  it('parseBalance handles strings, numbers and garbage', () => {
    expect(parseBalance('12.5')).toBe(12.5);
    expect(parseBalance(0)).toBe(0);
    expect(parseBalance('not-a-number')).toBe(0);
  });

  it('daysBetween computes whole calendar-day differences', () => {
    expect(daysBetween('2026-02-15T00:00:00.000Z', NOW)).toBe(0);
    expect(daysBetween('2026-03-17T12:00:00.000Z', NOW)).toBe(30);
    expect(daysBetween('2026-02-14T12:00:00.000Z', NOW)).toBe(-1);
  });

  it('classifyLot marks out-of-stock lots regardless of expiry', () => {
    expect(classifyLot(makeLot({ balance: '0' }), NOW)).toBe('out_of_stock');
    expect(classifyLot(makeLot({ balance: '0', expiry_date: '2027-01-01' }), NOW)).toBe(
      'out_of_stock',
    );
  });

  it('classifyLot marks expired vs expiring_soon based on days_until_expiry', () => {
    expect(classifyLot(makeLot({ balance: '10', expiry_date: '2026-02-01' }), NOW)).toBe('expired');
    expect(classifyLot(makeLot({ balance: '10', expiry_date: '2026-02-20' }), NOW)).toBe(
      'expiring_soon',
    );
    expect(classifyLot(makeLot({ balance: '10', expiry_date: '2027-01-01' }), NOW)).toBe('ok');
  });

  it('buildDashboardProjection produces expected summary + splits attention rows', () => {
    const projection = buildDashboardProjection({
      warehouses: [WH_MAIN, WH_COLD, WH_CLOSED],
      items: [ITEM_FEED, ITEM_MED, ITEM_INACTIVE],
      lots: [
        makeLot({ id: 'lot-ok', item_id: 'item-1', balance: '50' }),
        makeLot({ id: 'lot-out', item_id: 'item-1', balance: '0' }),
        makeLot({
          id: 'lot-expired',
          item_id: 'item-2',
          warehouse_id: 'wh-2',
          balance: '25',
          balance_unit: 'mL',
          expiry_date: '2026-01-31',
        }),
        makeLot({
          id: 'lot-soon',
          item_id: 'item-2',
          warehouse_id: 'wh-2',
          balance: '10',
          balance_unit: 'mL',
          expiry_date: '2026-02-25',
        }),
      ],
      nowIso: NOW,
    });

    expect(projection.summary).toEqual({
      total_active_items: 2,
      total_warehouses: 3,
      total_active_warehouses: 2,
      total_lots: 4,
      out_of_stock_lots: 1,
      expiring_soon_lots: 1,
      expired_lots: 1,
    });

    expect(projection.attention).toHaveLength(3);
    expect(projection.attention[0].status).toBe('out_of_stock');
    expect(projection.attention[1].status).toBe('expired');
    expect(projection.attention[2].status).toBe('expiring_soon');
    expect(projection.attention[0].warehouse_name).toBe('Main store');
    expect(projection.attention[1].item_name).toBe('Vaccine A');
  });

  it('buildDashboardProjection returns healthy empty projection when nothing to show', () => {
    const projection = buildDashboardProjection({
      warehouses: [],
      items: [],
      lots: [],
      nowIso: NOW,
    });
    expect(projection.summary.total_lots).toBe(0);
    expect(projection.attention).toEqual([]);
    expect(projection.recent_activity).toEqual([]);
  });

  it('recent activity is sorted by updated_at DESC and truncated', () => {
    const many: DashboardLot[] = Array.from({ length: 15 }, (_, i) =>
      makeLot({
        id: `lot-${i}`,
        lot_code: `L-${i}`,
        updated_at: `2026-02-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );
    const projection = buildDashboardProjection({
      warehouses: [WH_MAIN],
      items: [ITEM_FEED],
      lots: many,
      nowIso: NOW,
    });
    expect(projection.recent_activity).toHaveLength(RECENT_ACTIVITY_LIMIT);
    // Most recent update should come first.
    expect(projection.recent_activity[0].lot_code).toBe('L-14');
  });

  it('attention list is capped by ATTENTION_LIST_LIMIT', () => {
    const many: DashboardLot[] = Array.from({ length: ATTENTION_LIST_LIMIT + 5 }, (_, i) =>
      makeLot({ id: `lot-${i}`, lot_code: `L-${i}`, balance: '0' }),
    );
    const projection = buildDashboardProjection({
      warehouses: [WH_MAIN],
      items: [ITEM_FEED],
      lots: many,
      nowIso: NOW,
    });
    expect(projection.summary.out_of_stock_lots).toBe(ATTENTION_LIST_LIMIT + 5);
    expect(projection.attention).toHaveLength(ATTENTION_LIST_LIMIT);
  });

  it('EXPIRING_SOON_DAYS is a stable public constant', () => {
    expect(EXPIRING_SOON_DAYS).toBe(30);
  });
});

// --------------------------------------------------------------------- //
// Component rendering tests
// --------------------------------------------------------------------- //

describe('InventoryDashboardSummaryCards', () => {
  it('renders every metric with a testable value node', () => {
    render(
      <InventoryDashboardSummaryCards
        summary={{
          total_active_items: 7,
          total_warehouses: 2,
          total_active_warehouses: 2,
          total_lots: 14,
          out_of_stock_lots: 1,
          expiring_soon_lots: 3,
          expired_lots: 0,
        }}
      />,
    );
    expect(
      screen.getByTestId('inventory-dashboard-metric-total_active_items-value'),
    ).toHaveTextContent('7');
    expect(
      screen.getByTestId('inventory-dashboard-metric-out_of_stock_lots-value'),
    ).toHaveTextContent('1');
    expect(
      screen.getByTestId('inventory-dashboard-metric-expiring_soon_lots-value'),
    ).toHaveTextContent('3');
  });
});

describe('InventoryDashboardAttentionPanel', () => {
  it('shows the empty state when there are no attention rows', () => {
    render(<InventoryDashboardAttentionPanel rows={[]} />);
    expect(screen.getByTestId('inventory-dashboard-attention')).toBeInTheDocument();
    expect(screen.getByText(/Everything looks healthy/i)).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-dashboard-attention-table')).not.toBeInTheDocument();
  });

  it('renders a table row per attention lot with the correct status label', () => {
    render(
      <InventoryDashboardAttentionPanel
        rows={[
          {
            lot_id: 'lot-out',
            item_name: 'Starter feed',
            item_category: 'feed',
            warehouse_name: 'Main store',
            lot_code: 'L-1',
            balance: 0,
            balance_unit: 'kg',
            expiry_date: null,
            status: 'out_of_stock',
            days_until_expiry: null,
          },
          {
            lot_id: 'lot-soon',
            item_name: 'Vaccine A',
            item_category: 'medicine',
            warehouse_name: 'Cold room',
            lot_code: 'L-2',
            balance: 5,
            balance_unit: 'mL',
            expiry_date: '2026-02-25',
            status: 'expiring_soon',
            days_until_expiry: 10,
          },
        ]}
      />,
    );
    expect(screen.getByTestId('inventory-dashboard-attention-status-lot-out')).toHaveTextContent(
      'Out of stock',
    );
    expect(screen.getByTestId('inventory-dashboard-attention-status-lot-soon')).toHaveTextContent(
      'Expiring soon',
    );
    expect(screen.getByTestId('inventory-dashboard-attention-count')).toHaveTextContent('2 lots');
  });
});

describe('InventoryDashboardRecentActivity', () => {
  it('shows empty state when there is no activity', () => {
    render(<InventoryDashboardRecentActivity rows={[]} nowIso={NOW} />);
    expect(screen.getByText(/No recent inventory activity/i)).toBeInTheDocument();
  });

  it('renders a per-lot row with a relative timestamp', () => {
    render(
      <InventoryDashboardRecentActivity
        nowIso={NOW}
        rows={[
          {
            lot_id: 'lot-a',
            item_name: 'Starter feed',
            warehouse_name: 'Main store',
            lot_code: 'L-1',
            balance: 42,
            balance_unit: 'kg',
            updated_at: '2026-02-15T11:30:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByTestId('inventory-dashboard-recent-row-lot-a')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-dashboard-recent-row-lot-a-relative')).toHaveTextContent(
      /30m ago/,
    );
    expect(screen.getByTestId('inventory-dashboard-recent-history-link')).toHaveAttribute(
      'href',
      '/inventory?tab=history',
    );
  });
});

describe('InventoryDashboardQuickActions', () => {
  it('renders every planned action, with deferred ones non-interactive', () => {
    render(<InventoryDashboardQuickActions />);
    const receive = screen.getByTestId('inventory-dashboard-action-receive-stock');
    expect(receive.tagName).toBe('A');
    expect(receive).toHaveAttribute('href', '/inventory?tab=receive');

    const suppliers = screen.getByTestId('inventory-dashboard-action-suppliers');
    expect(suppliers.tagName).toBe('DIV');
    expect(suppliers).toHaveAttribute('aria-disabled', 'true');
    expect(within(suppliers).getByText(/Coming later in Sprint 5/i)).toBeInTheDocument();
  });
});

// --------------------------------------------------------------------- //
// Page-level rendering with mocked apiFetch
// --------------------------------------------------------------------- //

const { routerPush, stableRouter } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { apiFetch, ApiError } from '@/lib/api';
import InventoryDashboardPage from '@/app/inventory/dashboard/page';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function primeApi(config: {
  orgs?: unknown;
  warehouses?: unknown;
  items?: unknown;
  lotsByWh?: Record<string, unknown>;
  throwOn?: string;
}) {
  mockedApiFetch.mockImplementation((path: string) => {
    if (config.throwOn && path.includes(config.throwOn)) {
      return Promise.reject(new ApiError(500, { detail: 'boom' }));
    }
    if (path === '/v1/organizations') {
      return Promise.resolve(config.orgs ?? []);
    }
    if (path.endsWith('/warehouses')) {
      return Promise.resolve(config.warehouses ?? []);
    }
    if (path.endsWith('/inventory-items')) {
      return Promise.resolve(config.items ?? []);
    }
    const lotsMatch = path.match(/^\/v1\/warehouses\/(.+)\/lots$/);
    if (lotsMatch) {
      const key = lotsMatch[1];
      return Promise.resolve(config.lotsByWh?.[key] ?? []);
    }
    return Promise.reject(new ApiError(404, { detail: `unmocked ${path}` }));
  });
}

describe('InventoryDashboardPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', async () => {
    primeApi({ orgs: [{ id: 'org-1', name: 'Aegis', slug: 'aegis' }] });
    render(<InventoryDashboardPage />);
    // The loading label appears before the projection resolves.
    expect(await screen.findByTestId('ape-loading')).toBeInTheDocument();
  });

  it('renders the empty state when there are no warehouses and no items', async () => {
    primeApi({
      orgs: [{ id: 'org-1', name: 'Aegis', slug: 'aegis' }],
      warehouses: [],
      items: [],
    });
    render(<InventoryDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('inventory-dashboard-empty')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('inventory-dashboard-empty-cta')).toHaveAttribute(
      'href',
      '/inventory?tab=warehouses',
    );
  });

  it('renders summary cards + attention + recent lists when the org has data', async () => {
    primeApi({
      orgs: [{ id: 'org-1', name: 'Aegis', slug: 'aegis' }],
      warehouses: [WH_MAIN, WH_COLD],
      items: [ITEM_FEED, ITEM_MED],
      lotsByWh: {
        [WH_MAIN.id]: [
          makeLot({ id: 'lot-ok', balance: '50' }),
          makeLot({ id: 'lot-out', balance: '0' }),
        ],
        [WH_COLD.id]: [
          makeLot({
            id: 'lot-soon',
            item_id: 'item-2',
            warehouse_id: 'wh-2',
            balance: '10',
            balance_unit: 'mL',
            expiry_date: '2099-01-01', // not expiring — we still expect it in "recent"
          }),
        ],
      },
    });
    render(<InventoryDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('inventory-dashboard-summary')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('inventory-dashboard-metric-total_lots-value')).toHaveTextContent(
      '3',
    );
    expect(
      screen.getByTestId('inventory-dashboard-metric-out_of_stock_lots-value'),
    ).toHaveTextContent('1');
    expect(screen.getByTestId('inventory-dashboard-attention-row-lot-out')).toBeInTheDocument();
    // Recent activity should include all 3 lots.
    expect(screen.getByTestId('inventory-dashboard-recent-count')).toHaveTextContent('3 lots');
    // Tenant context surfaced.
    expect(screen.getByTestId('inventory-dashboard-org-name')).toHaveTextContent('Aegis');
  });

  it('surfaces a friendly ErrorBanner when the org bootstrap fails', async () => {
    mockedApiFetch.mockRejectedValueOnce(new ApiError(500, { detail: 'downstream 500' }));
    render(<InventoryDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('ape-error')).toBeInTheDocument());
  });

  it('redirects to /login on a 401 from the org bootstrap', async () => {
    mockedApiFetch.mockRejectedValueOnce(new ApiError(401, { detail: 'unauthenticated' }));
    render(<InventoryDashboardPage />);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });

  it('shows the forbidden banner when the API returns 403 on the org listing', async () => {
    // First call resolves with an org, second call (warehouses) rejects 403.
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') {
        return Promise.resolve([{ id: 'org-1', name: 'Aegis', slug: 'aegis' }]);
      }
      return Promise.reject(new ApiError(403, { detail: 'forbidden' }));
    });
    render(<InventoryDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('ape-forbidden')).toBeInTheDocument());
  });
});
