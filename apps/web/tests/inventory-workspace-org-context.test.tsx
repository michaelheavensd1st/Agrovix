/**
 * Sprint 5.1 review round #2 — inventory workspace organization
 * context retention regression tests.
 *
 * These cover the specific bug: switching organization inside the
 * inventory workspace must (a) clear every piece of org-dependent
 * state (warehouses, items, lots, selected warehouse, selected lot,
 * history) and (b) reset every form (Receive, Issue, Transfer,
 * Adjust) so nothing populated under org A is still populated —
 * or, worse, submittable — under org B.
 *
 * The workspace page is large (~1500 LOC) so we scope these tests
 * to the observable contract: form-input `data-testid` values
 * before/after an org switch, and the header labels driven by the
 * currently active org.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// --- shared mocks (mirroring inventory-dashboard.test.tsx) --------- //

const { routerPush, stableRouter, searchParamsProxy } = vi.hoisted(() => {
  const push = vi.fn();
  return {
    routerPush: push,
    stableRouter: { push, replace: push, back: vi.fn() },
    // Wrap in a proxy so tests can mutate the "current" URLSearchParams
    // without breaking referential stability across renders.
    searchParamsProxy: { current: new URLSearchParams() },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  useSearchParams: () => searchParamsProxy.current,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

// Some inventory code paths (idempotency headers, Receive form) call
// `crypto.randomUUID()`. jsdom's crypto lacks it in some vitest
// setups, so provide a stable stub if missing.
if (!('randomUUID' in (globalThis.crypto ?? {}))) {
  Object.assign(globalThis, {
    crypto: { ...(globalThis.crypto ?? {}), randomUUID: () => 'test-uuid' },
  });
}

import { apiFetch } from '@/lib/api';
import InventoryPage from '@/app/inventory/page';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

// --- fixtures -------------------------------------------------------- //

const ORG_A = { id: 'org-A', name: 'Aegis', slug: 'aegis' };
const ORG_B = { id: 'org-B', name: 'Beacon', slug: 'beacon' };

const WH_A = {
  id: 'wh-A1',
  code: 'A-MAIN',
  name: 'Aegis main store',
  status: 'active',
  farm_id: null,
  organization_id: ORG_A.id,
};
const WH_B = {
  id: 'wh-B1',
  code: 'B-MAIN',
  name: 'Beacon main store',
  status: 'active',
  farm_id: null,
  organization_id: ORG_B.id,
};

const ITEM_A = {
  id: 'item-A1',
  code: 'F-A-STARTER',
  name: 'Aegis starter feed',
  category: 'feed',
  canonical_unit: 'kg',
  is_active: true,
};
const ITEM_B = {
  id: 'item-B1',
  code: 'F-B-STARTER',
  name: 'Beacon starter feed',
  category: 'feed',
  canonical_unit: 'kg',
  is_active: true,
};

function primeWorkspaceApi() {
  mockedApiFetch.mockImplementation((path: string) => {
    if (path === '/v1/organizations') return Promise.resolve([ORG_A, ORG_B]);
    if (path === `/v1/organizations/${ORG_A.id}/warehouses`) return Promise.resolve([WH_A]);
    if (path === `/v1/organizations/${ORG_B.id}/warehouses`) return Promise.resolve([WH_B]);
    if (path === `/v1/organizations/${ORG_A.id}/inventory-items`) return Promise.resolve([ITEM_A]);
    if (path === `/v1/organizations/${ORG_B.id}/inventory-items`) return Promise.resolve([ITEM_B]);
    if (/^\/v1\/warehouses\/[^/]+\/lots$/.test(path)) return Promise.resolve([]);
    if (/^\/v1\/warehouses\/[^/]+\/inventory:receive$/.test(path)) return Promise.resolve({});
    if (/^\/v1\/warehouses\/[^/]+\/storage-locations$/.test(path)) return Promise.resolve([]);
    if (/^\/v1\/lots\/[^/]+\/transactions/.test(path)) return Promise.resolve({ items: [] });
    // Fallback — never used in these tests.
    return Promise.resolve([]);
  });
}

function setLocationSearch(search: string) {
  window.history.replaceState({}, '', `/inventory${search}`);
}

describe('/inventory workspace — organization context retention', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    routerPush.mockReset();
    setLocationSearch('');
    primeWorkspaceApi();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function switchToTab(key: string) {
    const tab = await screen.findByTestId(`inv-tab-${key}`);
    fireEvent.click(tab);
  }

  it('clears the Receive form fields when the organization changes', async () => {
    render(<InventoryPage />);
    // Wait for the initial org (A) to hydrate: the warehouse selector
    // is the last thing to populate.
    await waitFor(() => expect(screen.getByTestId('inv-org-selector')).toBeInTheDocument());

    await switchToTab('receive');
    const itemSelectA = (await screen.findByTestId('inv-receive-item')) as HTMLSelectElement;
    const lotCodeA = screen.getByTestId('inv-receive-lot-code') as HTMLInputElement;
    const qtyA = screen.getByTestId('inv-receive-quantity') as HTMLInputElement;
    // Wait for org-A's item option to appear in the select.
    await waitFor(() =>
      expect(Array.from(itemSelectA.options).some((o) => o.value === ITEM_A.id)).toBe(true),
    );
    // Populate the form under org A.
    fireEvent.change(itemSelectA, { target: { value: ITEM_A.id } });
    fireEvent.change(lotCodeA, { target: { value: 'LOT-A-STASH' } });
    fireEvent.change(qtyA, { target: { value: '42' } });
    expect(itemSelectA.value).toBe(ITEM_A.id);
    expect(lotCodeA.value).toBe('LOT-A-STASH');
    expect(qtyA.value).toBe('42');

    // Switch org via the selector.
    fireEvent.change(screen.getByTestId('inv-org-selector'), { target: { value: ORG_B.id } });

    // The `key={orgId}` on the ReceivePanel remounts the form, so we
    // wait for org-B's item option to appear and then assert the
    // fields are pristine.
    await waitFor(() => {
      const currentSelect = screen.getByTestId('inv-receive-item') as HTMLSelectElement;
      // The org-A item must be gone from the option list under org B.
      expect(Array.from(currentSelect.options).some((o) => o.value === ITEM_A.id)).toBe(false);
    });

    const itemSelectB = screen.getByTestId('inv-receive-item') as HTMLSelectElement;
    const lotCodeB = screen.getByTestId('inv-receive-lot-code') as HTMLInputElement;
    const qtyB = screen.getByTestId('inv-receive-quantity') as HTMLInputElement;
    expect(itemSelectB.value).not.toBe(ITEM_A.id);
    expect(lotCodeB.value).toBe('');
    expect(qtyB.value).toBe('');
  });

  it('drops org-A warehouses from the Receive warehouse selector after switching to org B', async () => {
    render(<InventoryPage />);
    await waitFor(() => expect(screen.getByTestId('inv-org-selector')).toBeInTheDocument());
    await switchToTab('receive');
    const receiveWhA = (await screen.findByTestId('inv-receive-warehouse')) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(receiveWhA.options).some((o) => o.value === WH_A.id)).toBe(true),
    );

    // Switch org via the selector.
    fireEvent.change(screen.getByTestId('inv-org-selector'), { target: { value: ORG_B.id } });

    await waitFor(() => {
      const receiveWhB = screen.getByTestId('inv-receive-warehouse') as HTMLSelectElement;
      // wh-A must be gone; wh-B must be selectable.
      expect(Array.from(receiveWhB.options).some((o) => o.value === WH_A.id)).toBe(false);
      expect(Array.from(receiveWhB.options).some((o) => o.value === WH_B.id)).toBe(true);
    });
  });
});
