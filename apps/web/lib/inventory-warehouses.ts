/**
 * Sprint 5.2 — Warehouse Management shared types + helpers.
 *
 * Everything in this module is derived from Sprint 4 backend
 * endpoints. NO backend changes were introduced for Sprint 5.2;
 * where the backend cannot answer a question truthfully (per-org
 * sites, per-warehouse activity, per-warehouse item totals) the UI
 * must show an unavailable state rather than invent data.
 */

// ------------------------------------------------------------------- //
// Types
// ------------------------------------------------------------------- //

export interface WarehouseOrganization {
  id: string;
  name: string;
  slug?: string;
}

export type WarehouseStatus = 'active' | 'maintenance' | 'closed';

export interface Warehouse {
  id: string;
  organization_id: string;
  farm_id: string | null;
  site_id: string | null;
  code: string;
  name: string;
  description: string | null;
  address: string | null;
  status: WarehouseStatus;
  metadata_json: Record<string, unknown> | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseInventoryItem {
  id: string;
  code: string;
  name: string;
  category: string;
  canonical_unit: string;
}

export interface WarehouseLot {
  id: string;
  item_id: string;
  warehouse_id: string;
  lot_code: string;
  expiry_date: string | null;
  balance: string;
  balance_unit: string;
  created_at?: string;
  updated_at?: string;
}

export interface WarehouseLedgerTx {
  id: string;
  transaction_type: string;
  quantity: string;
  unit: string;
  performed_at: string;
  reason: string | null;
  reference_type: string | null;
  performed_by?: string | null;
  actor_display?: string | null;
  lot_id?: string;
}

// ------------------------------------------------------------------- //
// Derived UI concepts (from raw warehouse fields).
// ------------------------------------------------------------------- //

/**
 * Scope is a UI-level derivation of `farm_id`. It is NOT a backend
 * field and must never be presented as one.
 */
export type WarehouseScope = 'farm_linked' | 'organization_wide';

export function deriveScope(w: Pick<Warehouse, 'farm_id'>): WarehouseScope {
  return w.farm_id ? 'farm_linked' : 'organization_wide';
}

export function scopeLabel(scope: WarehouseScope): string {
  return scope === 'farm_linked' ? 'Farm-linked' : 'Organization-wide';
}

/** UI status label. `active` → "Operational" per Sprint 5.2 spec. */
export function statusLabel(status: WarehouseStatus): string {
  if (status === 'active') return 'Operational';
  if (status === 'closed') return 'Closed';
  return 'Maintenance';
}

// ------------------------------------------------------------------- //
// Organization guard (mirrors Sprint 5.1 `resolveOrganizationId`).
// Local copy so Sprint 5.2 can ship independently of PR #6.
// ------------------------------------------------------------------- //

export function resolveOrganizationId(
  requested: string | null | undefined,
  orgs: readonly { id: string }[],
): string | null {
  if (orgs.length === 0) return null;
  if (requested && orgs.some((o) => o.id === requested)) return requested;
  return orgs[0].id;
}

// ------------------------------------------------------------------- //
// List filtering + sorting + search.
// ------------------------------------------------------------------- //

export interface WarehouseListFilters {
  query: string;
  status: WarehouseStatus | 'all';
  scope: WarehouseScope | 'all';
}

export type WarehouseSortKey = 'name' | 'code' | 'status' | 'updated_at';
export interface WarehouseSort {
  key: WarehouseSortKey;
  direction: 'asc' | 'desc';
}

export function filterWarehouses(
  warehouses: readonly Warehouse[],
  filters: WarehouseListFilters,
): Warehouse[] {
  const q = filters.query.trim().toLowerCase();
  return warehouses.filter((w) => {
    if (filters.status !== 'all' && w.status !== filters.status) return false;
    if (filters.scope !== 'all' && deriveScope(w) !== filters.scope) return false;
    if (!q) return true;
    return (
      w.name.toLowerCase().includes(q) ||
      w.code.toLowerCase().includes(q) ||
      (w.description ?? '').toLowerCase().includes(q)
    );
  });
}

export function sortWarehouses(warehouses: readonly Warehouse[], sort: WarehouseSort): Warehouse[] {
  const copy = [...warehouses];
  copy.sort((a, b) => {
    const dir = sort.direction === 'asc' ? 1 : -1;
    switch (sort.key) {
      case 'name':
        return a.name.localeCompare(b.name) * dir;
      case 'code':
        return a.code.localeCompare(b.code) * dir;
      case 'status':
        return a.status.localeCompare(b.status) * dir;
      case 'updated_at':
        return (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()) * dir;
      default:
        return 0;
    }
  });
  return copy;
}

// ------------------------------------------------------------------- //
// Warehouse-detail inventory aggregation.
//
// For a single warehouse we already have every lot; total inventory
// items is the count of distinct item_ids across lots with a
// positive balance.
// ------------------------------------------------------------------- //

export interface WarehouseInventoryRow {
  item_id: string;
  item_name: string;
  item_code: string;
  canonical_unit: string;
  category: string;
  active_lots: number;
  total_balance: number;
  low_stock: boolean;
  earliest_expiry: string | null;
  expiring_soon: boolean;
  has_expired: boolean;
}

export const LOW_STOCK_THRESHOLD = 5;
export const EXPIRING_SOON_DAYS = 30;

function parseBalance(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function daysBetween(iso: string, nowIso: string): number {
  const a = Date.parse(iso);
  const b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((a - b) / (1000 * 60 * 60 * 24));
}

export function buildWarehouseInventoryRows(input: {
  lots: readonly WarehouseLot[];
  items: readonly WarehouseInventoryItem[];
  nowIso: string;
}): WarehouseInventoryRow[] {
  const { lots, items, nowIso } = input;
  const byItem = new Map<
    string,
    {
      item: WarehouseInventoryItem | undefined;
      active_lots: number;
      total_balance: number;
      earliest_expiry: string | null;
      expiring_soon: boolean;
      has_expired: boolean;
    }
  >();
  for (const lot of lots) {
    const bal = parseBalance(lot.balance);
    const prev = byItem.get(lot.item_id) ?? {
      item: items.find((i) => i.id === lot.item_id),
      active_lots: 0,
      total_balance: 0,
      earliest_expiry: null as string | null,
      expiring_soon: false,
      has_expired: false,
    };
    prev.total_balance += bal;
    if (bal > 0) prev.active_lots += 1;
    if (lot.expiry_date) {
      const days = daysBetween(lot.expiry_date, nowIso);
      if (days < 0) prev.has_expired = true;
      else if (days <= EXPIRING_SOON_DAYS) prev.expiring_soon = true;
      if (!prev.earliest_expiry || lot.expiry_date < prev.earliest_expiry) {
        prev.earliest_expiry = lot.expiry_date;
      }
    }
    byItem.set(lot.item_id, prev);
  }
  const rows: WarehouseInventoryRow[] = [];
  for (const [itemId, agg] of byItem) {
    rows.push({
      item_id: itemId,
      item_name: agg.item?.name ?? itemId,
      item_code: agg.item?.code ?? '—',
      canonical_unit: agg.item?.canonical_unit ?? '—',
      category: agg.item?.category ?? '—',
      active_lots: agg.active_lots,
      total_balance: agg.total_balance,
      low_stock: agg.total_balance > 0 && agg.total_balance < LOW_STOCK_THRESHOLD,
      earliest_expiry: agg.earliest_expiry,
      expiring_soon: agg.expiring_soon,
      has_expired: agg.has_expired,
    });
  }
  rows.sort((a, b) => a.item_name.localeCompare(b.item_name));
  return rows;
}

// ------------------------------------------------------------------- //
// Bounded-concurrency mapper for activity fan-out.
//
// Explicitly required by the sprint: no unbounded Promise.all. This
// runs `worker(input)` for every input with at most `concurrency`
// requests in flight at a time. Rejections are surfaced through the
// returned settled tuples so a single 403/500 does not abort the
// fan-out (auth failures are inspected by the caller).
// ------------------------------------------------------------------- //

export async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  concurrency: number,
  worker: (input: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(inputs.length);
  const n = Math.max(1, concurrency);
  let cursor = 0;
  async function next(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= inputs.length) return;
      try {
        const value = await worker(inputs[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(n, inputs.length); i += 1) workers.push(next());
  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------------- //
// Warehouse-activity fan-out result inspector.
// ------------------------------------------------------------------- //

export type ActivityFanOutOutcome =
  | { kind: 'ok'; transactions: WarehouseLedgerTx[] }
  | { kind: 'partial'; transactions: WarehouseLedgerTx[] }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' };

export const ACTIVITY_LIMIT = 100;
export const ACTIVITY_CONCURRENCY = 5;

/**
 * Merge fan-out results into a newest-first, capped list. Auth
 * failures take precedence over every other outcome so the caller
 * can redirect / render a forbidden banner without ever exposing
 * partial data. Passing `getStatus` decouples this from the API
 * client's specific error shape for testability.
 */
export function inspectActivityFanOut(
  results: PromiseSettledResult<{ items: WarehouseLedgerTx[] }>[],
  getStatus: (reason: unknown) => number | null,
): ActivityFanOutOutcome {
  for (const r of results) {
    if (r.status === 'rejected') {
      const s = getStatus(r.reason);
      if (s === 401) return { kind: 'unauthenticated' };
      if (s === 403) return { kind: 'forbidden' };
    }
  }
  let hadFailure = false;
  const merged: WarehouseLedgerTx[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const items = r.value?.items;
      if (Array.isArray(items)) {
        for (const tx of items) merged.push(tx);
      }
    } else {
      hadFailure = true;
    }
  }
  merged.sort((a, b) => new Date(b.performed_at).getTime() - new Date(a.performed_at).getTime());
  const capped = merged.slice(0, ACTIVITY_LIMIT);
  return { kind: hadFailure ? 'partial' : 'ok', transactions: capped };
}

// ------------------------------------------------------------------- //
// Debounce helper (search).
// ------------------------------------------------------------------- //

export type DebouncedFunction<A extends unknown[]> = ((...args: A) => void) & {
  cancel: () => void;
};

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): DebouncedFunction<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
