/**
 * Sprint 5.3 — Inventory Item Management shared types + helpers.
 *
 * Every value in this module maps 1:1 to a real backend field or
 * a derived computation done client-side. Where the backend
 * cannot answer a question truthfully, the UI must display an
 * unavailable state rather than fabricate a value.
 *
 * Enums (category / unit) mirror the FastAPI enums exactly so a
 * mismatch would fail validation at the backend rather than
 * pretending to be a supported value.
 */

// ------------------------------------------------------------------ //
// Enum mirrors — must match `app.models.inventory` exactly.
// ------------------------------------------------------------------ //
export const ITEM_CATEGORIES = ['feed', 'medicine', 'chemical', 'supply'] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const STOCK_UNITS = ['kg', 'g', 'L', 'mL', 'count', 'bag', 'pack'] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export function categoryLabel(c: ItemCategory): string {
  switch (c) {
    case 'feed':
      return 'Feed';
    case 'medicine':
      return 'Medicine';
    case 'chemical':
      return 'Chemical';
    case 'supply':
      return 'Supply';
  }
}

// ------------------------------------------------------------------ //
// Domain types
// ------------------------------------------------------------------ //
export interface ItemOrganization {
  id: string;
  name: string;
  slug?: string;
}

export interface InventoryItem {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  category: ItemCategory;
  canonical_unit: StockUnit;
  sku: string | null;
  is_active: boolean;
  metadata_json: Record<string, unknown> | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemWarehouse {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  status: string;
}

export interface ItemLot {
  id: string;
  item_id: string;
  warehouse_id: string;
  storage_location_id: string | null;
  lot_code: string;
  expiry_date: string | null;
  balance: string;
  balance_unit: StockUnit;
  created_at?: string;
  updated_at?: string;
}

export interface ItemLedgerTx {
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

// ------------------------------------------------------------------ //
// Organization guard.
// ------------------------------------------------------------------ //
export function resolveOrganizationId(
  requested: string | null | undefined,
  orgs: readonly { id: string }[],
): string | null {
  if (orgs.length === 0) return null;
  if (requested && orgs.some((o) => o.id === requested)) return requested;
  return orgs[0].id;
}

// ------------------------------------------------------------------ //
// List filters / sort / search.
// ------------------------------------------------------------------ //
export interface ItemListFilters {
  query: string;
  category: ItemCategory | 'all';
  status: 'all' | 'active' | 'inactive';
  unit: StockUnit | 'all';
}

export type ItemSortKey = 'name' | 'code' | 'category' | 'canonical_unit' | 'updated_at';
export interface ItemSort {
  key: ItemSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_ITEM_FILTERS: ItemListFilters = {
  query: '',
  category: 'all',
  status: 'all',
  unit: 'all',
};
export const DEFAULT_ITEM_SORT: ItemSort = { key: 'name', direction: 'asc' };

export function filterItems(
  items: readonly InventoryItem[],
  filters: ItemListFilters,
): InventoryItem[] {
  const q = filters.query.trim().toLowerCase();
  return items.filter((i) => {
    if (filters.category !== 'all' && i.category !== filters.category) return false;
    if (filters.unit !== 'all' && i.canonical_unit !== filters.unit) return false;
    if (filters.status === 'active' && !i.is_active) return false;
    if (filters.status === 'inactive' && i.is_active) return false;
    if (!q) return true;
    return (
      i.name.toLowerCase().includes(q) ||
      i.code.toLowerCase().includes(q) ||
      (i.sku ?? '').toLowerCase().includes(q) ||
      (i.description ?? '').toLowerCase().includes(q)
    );
  });
}

export function sortItems(items: readonly InventoryItem[], sort: ItemSort): InventoryItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    const dir = sort.direction === 'asc' ? 1 : -1;
    switch (sort.key) {
      case 'name':
        return a.name.localeCompare(b.name) * dir;
      case 'code':
        return a.code.localeCompare(b.code) * dir;
      case 'category':
        return a.category.localeCompare(b.category) * dir;
      case 'canonical_unit':
        return a.canonical_unit.localeCompare(b.canonical_unit) * dir;
      case 'updated_at':
        return (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()) * dir;
    }
  });
  return copy;
}

// ------------------------------------------------------------------ //
// Bounded-concurrency mapper (used for both availability + activity
// fan-outs). Never unbounded Promise.all.
// ------------------------------------------------------------------ //
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

// ------------------------------------------------------------------ //
// Availability aggregation for a single item.
// ------------------------------------------------------------------ //
export interface ItemAvailabilityRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  lot_count: number;
  total_balance: number;
  canonical_unit: StockUnit;
  earliest_expiry: string | null;
  has_expired: boolean;
  expiring_soon: boolean;
  low_stock: boolean;
}

export const LOW_STOCK_THRESHOLD = 5;
export const EXPIRING_SOON_DAYS = 30;

function parseBalance(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function daysBetween(iso: string, nowIso: string): number {
  const a = Date.parse(iso);
  const b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((a - b) / (1000 * 60 * 60 * 24));
}

/**
 * Build the per-warehouse availability rows for one item. `lots` is
 * the *filtered* subset of lots that reference this item across the
 * fan-out. Malformed balances are treated as data-quality issues
 * (`has_data_quality_issue` at row level would live on the caller
 * — here we simply skip malformed balances rather than coerce to 0).
 */
export function buildItemAvailability(input: {
  item: InventoryItem;
  warehouses: readonly ItemWarehouse[];
  lots: readonly ItemLot[];
  nowIso: string;
}): ItemAvailabilityRow[] {
  const { item, warehouses, lots, nowIso } = input;
  const byWh = new Map<string, ItemAvailabilityRow>();
  const warehouseIndex = new Map(warehouses.map((w) => [w.id, w]));
  for (const lot of lots) {
    if (lot.item_id !== item.id) continue;
    const wh = warehouseIndex.get(lot.warehouse_id);
    const bal = parseBalance(lot.balance);
    const existing = byWh.get(lot.warehouse_id) ?? {
      warehouse_id: lot.warehouse_id,
      warehouse_code: wh?.code ?? '—',
      warehouse_name: wh?.name ?? 'Unknown warehouse',
      lot_count: 0,
      total_balance: 0,
      canonical_unit: item.canonical_unit,
      earliest_expiry: null as string | null,
      has_expired: false,
      expiring_soon: false,
      low_stock: false,
    };
    if (Number.isFinite(bal)) {
      existing.total_balance += bal;
      if (bal > 0) existing.lot_count += 1;
    }
    if (lot.expiry_date) {
      const days = daysBetween(lot.expiry_date, nowIso);
      if (Number.isFinite(days)) {
        if (days < 0) existing.has_expired = true;
        else if (days <= EXPIRING_SOON_DAYS) existing.expiring_soon = true;
      }
      if (!existing.earliest_expiry || lot.expiry_date < existing.earliest_expiry) {
        existing.earliest_expiry = lot.expiry_date;
      }
    }
    byWh.set(lot.warehouse_id, existing);
  }
  const rows = Array.from(byWh.values()).map((r) => ({
    ...r,
    low_stock: r.total_balance > 0 && r.total_balance < LOW_STOCK_THRESHOLD,
  }));
  rows.sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name));
  return rows;
}

// ------------------------------------------------------------------ //
// Activity fan-out inspector.
//
// Sprint 5.3 review round: the backend transactions endpoint is
// cursor-paginated (`{ items, next_cursor, limit }`). If any lot's
// response carries a non-null `next_cursor` we did NOT fetch every
// transaction for that lot, so the merged activity list cannot be
// treated as complete — surface it as partial the same way we do
// for a failed lot request.
// ------------------------------------------------------------------ //
export interface TransactionPage {
  items: ItemLedgerTx[];
  next_cursor: string | null;
  limit?: number;
}

export type ActivityFanOutOutcome =
  | { kind: 'ok'; transactions: ItemLedgerTx[] }
  | { kind: 'partial'; transactions: ItemLedgerTx[] }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' };

export const ACTIVITY_LIMIT = 100;
export const ACTIVITY_CONCURRENCY = 5;
export const ACTIVITY_PER_LOT_LIMIT = 100;
export const WAREHOUSE_LOT_CONCURRENCY = 5;

export function inspectFanOut(
  results: PromiseSettledResult<TransactionPage>[],
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
  let truncatedByCursor = false;
  const merged: ItemLedgerTx[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const items = r.value?.items;
      if (Array.isArray(items)) {
        for (const tx of items) merged.push(tx);
      }
      // A lingering next_cursor means the lot has additional
      // transactions we did not fetch. The merged/globally-sorted
      // result therefore cannot be described as complete.
      if (r.value?.next_cursor) truncatedByCursor = true;
    } else {
      hadFailure = true;
    }
  }
  merged.sort((a, b) => new Date(b.performed_at).getTime() - new Date(a.performed_at).getTime());
  const capped = merged.slice(0, ACTIVITY_LIMIT);
  return {
    kind: hadFailure || truncatedByCursor ? 'partial' : 'ok',
    transactions: capped,
  };
}

/**
 * Similar inspector but for a fan-out that returns arrays of lots
 * (the availability precursor step). Auth failures take precedence.
 */
export type WarehouseLotFanOutOutcome =
  | { kind: 'ok'; lots: ItemLot[]; partial: false }
  | { kind: 'partial'; lots: ItemLot[]; partial: true }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' };

export function inspectWarehouseLotFanOut(
  results: PromiseSettledResult<ItemLot[]>[],
  getStatus: (reason: unknown) => number | null,
): WarehouseLotFanOutOutcome {
  for (const r of results) {
    if (r.status === 'rejected') {
      const s = getStatus(r.reason);
      if (s === 401) return { kind: 'unauthenticated' };
      if (s === 403) return { kind: 'forbidden' };
    }
  }
  let hadFailure = false;
  const merged: ItemLot[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (Array.isArray(r.value)) for (const lot of r.value) merged.push(lot);
    } else {
      hadFailure = true;
    }
  }
  return hadFailure
    ? { kind: 'partial', lots: merged, partial: true }
    : { kind: 'ok', lots: merged, partial: false };
}

// ------------------------------------------------------------------ //
// Cleanup-aware debounce. Returns a `{ trigger, cancel }` pair so
// the caller can flush timers on unmount.
// ------------------------------------------------------------------ //
export function makeDebouncer<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): { trigger: (...args: A) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger(...args) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, wait);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
