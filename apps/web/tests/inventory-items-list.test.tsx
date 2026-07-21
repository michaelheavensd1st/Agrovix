/**
 * Sprint 5.3 — Group 1: List, Search, Filters, Deep Links.
 *
 * Covers the list-scope UX contract:
 *   - loading skeleton → empty state → populated table;
 *   - org selector + preserved organization_id deep links;
 *   - debounced search that cleans up its timer on unmount;
 *   - filter / sort / pagination composition;
 *   - invalid ?organization_id falls back cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { routerPush, stableRouter } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  useParams: () => ({ itemId: '' }),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from '@/lib/api';
import InventoryItemListPage from '@/app/inventory/items/page';
import {
  filterItems,
  sortItems,
  resolveOrganizationId,
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

// ---- pure helpers ------------------------------------------------- //
describe('inventory-items pure helpers', () => {
  it('resolveOrganizationId validates against the caller orgs', () => {
    const orgs = [{ id: 'a' }, { id: 'b' }];
    expect(resolveOrganizationId('b', orgs)).toBe('b');
    expect(resolveOrganizationId('spoofed', orgs)).toBe('a');
    expect(resolveOrganizationId(null, orgs)).toBe('a');
    expect(resolveOrganizationId('a', [])).toBeNull();
  });

  it('filterItems + sortItems compose', () => {
    const rows = [
      makeItem({ id: '1', name: 'Alpha', code: 'A', category: 'feed', canonical_unit: 'kg' }),
      makeItem({ id: '2', name: 'Bravo', code: 'B', category: 'medicine', canonical_unit: 'mL' }),
      makeItem({
        id: '3',
        name: 'Coral',
        code: 'C',
        category: 'feed',
        canonical_unit: 'kg',
        is_active: false,
      }),
    ];
    expect(
      filterItems(rows, { query: '', category: 'feed', unit: 'all', status: 'all' }),
    ).toHaveLength(2);
    expect(
      filterItems(rows, { query: '', category: 'all', unit: 'all', status: 'inactive' }).map(
        (r) => r.id,
      ),
    ).toEqual(['3']);
    expect(sortItems(rows, { key: 'code', direction: 'desc' }).map((r) => r.code)).toEqual([
      'C',
      'B',
      'A',
    ]);
  });
});

// ---- list page --------------------------------------------------- //
describe('InventoryItemListPage', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    window.history.replaceState({}, '', '/inventory/items');
  });
  afterEach(() => vi.clearAllMocks());

  it('shows the loading skeleton, then the populated table', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve([
          makeItem({ id: 'i-1', code: 'FEED-A', name: 'Starter A' }),
          makeItem({
            id: 'i-2',
            code: 'MED-B',
            name: 'Antibiotic',
            category: 'medicine',
            canonical_unit: 'mL',
            is_active: false,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    expect(await screen.findByTestId('item-list-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('item-row-FEED-A')).toBeInTheDocument());
    expect(screen.getByTestId('item-row-MED-B')).toBeInTheDocument();
    expect(screen.getByTestId('item-status-badge-inactive')).toBeInTheDocument();
  });

  it('renders the empty state when there are no items', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
  });

  it('debounced search + status filter narrow the visible rows', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve([
          makeItem({ id: 'i-1', code: 'FEED-A', name: 'Starter A' }),
          makeItem({
            id: 'i-2',
            code: 'MED-B',
            name: 'Antibiotic',
            category: 'medicine',
            canonical_unit: 'mL',
            is_active: false,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-row-FEED-A')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('item-search'), { target: { value: 'antibio' } });
    await waitFor(
      () => {
        expect(screen.queryByTestId('item-row-FEED-A')).not.toBeInTheDocument();
        expect(screen.getByTestId('item-row-MED-B')).toBeInTheDocument();
      },
      { timeout: 800 },
    );
    // Clear + filter by status only.
    fireEvent.change(screen.getByTestId('item-search'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('item-filter-status'), { target: { value: 'inactive' } });
    await waitFor(() => {
      expect(screen.queryByTestId('item-row-FEED-A')).not.toBeInTheDocument();
      expect(screen.getByTestId('item-row-MED-B')).toBeInTheDocument();
    });
  });

  it('name sort toggles asc → desc', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve([
          makeItem({ id: '2', name: 'Bravo', code: 'B' }),
          makeItem({ id: '1', name: 'Alpha', code: 'A' }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-table')).toBeInTheDocument());
    const asc = within(screen.getByTestId('item-table')).getAllByRole('row');
    expect(asc[1]).toHaveAttribute('data-testid', 'item-row-A');
    fireEvent.click(screen.getByTestId('item-table-sort-name'));
    const desc = within(screen.getByTestId('item-table')).getAllByRole('row');
    expect(desc[1]).toHaveAttribute('data-testid', 'item-row-B');
  });

  it('pagination page-size + prev/next work', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve(
          Array.from({ length: 15 }, (_, i) =>
            makeItem({
              id: `i-${i}`,
              code: `CODE-${String(i).padStart(2, '0')}`,
              name: `Item ${i}`,
            }),
          ),
        );
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-list-page-indicator')).toHaveTextContent('1 / 2'),
    );
    fireEvent.click(screen.getByTestId('item-list-next'));
    await waitFor(() =>
      expect(screen.getByTestId('item-list-page-indicator')).toHaveTextContent('2 / 2'),
    );
    // Reset by upping page size.
    fireEvent.change(screen.getByTestId('item-list-page-size'), { target: { value: '25' } });
    await waitFor(() =>
      expect(screen.getByTestId('item-list-page-indicator')).toHaveTextContent('1 / 1'),
    );
  });

  it('respects ?organization_id when present and valid', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      if (path === `/v1/organizations/${ORG_B.id}/inventory-items`) {
        return Promise.resolve([
          makeItem({ id: 'x', code: 'BEACON-X', organization_id: ORG_B.id }),
        ]);
      }
      return Promise.resolve([]);
    });
    window.history.replaceState({}, '', `/inventory/items?organization_id=${ORG_B.id}`);
    render(<InventoryItemListPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-list-org-name')).toHaveTextContent('Beacon'),
    );
    expect(screen.getByTestId('item-row-BEACON-X')).toBeInTheDocument();
  });

  it('invalid ?organization_id falls back to the first authorized org', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve([makeItem({ code: 'FEED-A' })]);
      }
      return Promise.resolve([]);
    });
    window.history.replaceState({}, '', '/inventory/items?organization_id=spoofed');
    render(<InventoryItemListPage />);
    await waitFor(() =>
      expect(screen.getByTestId('item-list-org-name')).toHaveTextContent('Aegis'),
    );
    expect(screen.getByTestId('item-row-FEED-A')).toBeInTheDocument();
  });

  it('open button navigates with organization_id preserved', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) {
        return Promise.resolve([makeItem({ id: 'i-1', code: 'FEED-A' })]);
      }
      return Promise.resolve([]);
    });
    render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-row-FEED-A')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('item-row-FEED-A-open'));
    expect(routerPush).toHaveBeenCalledWith(`/inventory/items/i-1?organization_id=${ORG_A.id}`);
  });

  it('search debounce cleans up on unmount without firing an obsolete update', async () => {
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations') return Promise.resolve([ORG_A]);
      if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const { unmount } = render(<InventoryItemListPage />);
    await waitFor(() => expect(screen.getByTestId('item-empty-state')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('item-search'), { target: { value: 'typing…' } });
    // Unmount BEFORE the debounce fires. If the timer leaked we
    // would see a React "state update on unmounted component" warning.
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args) => {
      errors.push(String(args[0] ?? ''));
    };
    try {
      unmount();
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      console.error = originalError;
    }
    expect(errors.some((e) => /unmounted component|state update/i.test(e))).toBe(false);
  });
});
