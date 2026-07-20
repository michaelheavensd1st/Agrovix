/**
 * Sprint 5.1 — Inventory Dashboard types and pure aggregation helpers.
 *
 * The dashboard is a read-only projection over the existing Sprint 4
 * inventory endpoints. It performs NO writes and MUST NOT duplicate
 * business logic that already lives in the backend inventory engine.
 *
 * Every metric in this module is derived from data returned by:
 *   - GET /v1/organizations/{org}/warehouses
 *   - GET /v1/organizations/{org}/inventory-items
 *   - GET /v1/warehouses/{wh}/lots      (returns balance in canonical unit)
 *
 * Anything the backend does not currently expose (per-item
 * reorder_level, estimated stock value, warehouse utilization,
 * pending / in-transit transfer states) is DELIBERATELY omitted.
 * See docs/sprint_5/API_MAPPING.md for the full gap list.
 */

import type { UUID } from '@/lib/types';

// --------------------------------------------------------------------- //
// Types mirroring the FastAPI response models we consume.
// --------------------------------------------------------------------- //

export type InventoryItemCategory = 'feed' | 'medicine' | 'chemical' | 'supply';

export type WarehouseStatus = 'active' | 'closed' | 'maintenance';

export interface DashboardOrganization {
  id: UUID;
  name: string;
  slug: string;
}

export interface DashboardWarehouse {
  id: UUID;
  code: string;
  name: string;
  status: WarehouseStatus;
  farm_id: UUID | null;
  organization_id: UUID;
}

export interface DashboardInventoryItem {
  id: UUID;
  code: string;
  name: string;
  category: InventoryItemCategory;
  canonical_unit: string;
  is_active: boolean;
}

/**
 * Mirrors `InventoryLotWithBalance` on the backend. `balance` is
 * returned as a JSON number from FastAPI's Decimal serializer.
 */
export interface DashboardLot {
  id: UUID;
  item_id: UUID;
  warehouse_id: UUID;
  storage_location_id: UUID | null;
  lot_code: string;
  expiry_date: string | null; // ISO date, no time
  balance: number | string; // arrives as string from Decimal serializer
  balance_unit: string;
  updated_at: string; // ISO datetime
  created_at: string;
}

// --------------------------------------------------------------------- //
// Derived shapes surfaced to the UI. These are frontend-only helpers
// — the raw shapes above remain the authoritative API contract.
// --------------------------------------------------------------------- //

/** Categorised, humanised stock status for a single lot. */
export type LotStockStatus = 'out_of_stock' | 'expiring_soon' | 'expired' | 'ok';

export interface LotAttentionRow {
  lot_id: UUID;
  item_name: string;
  item_category: InventoryItemCategory | 'unknown';
  warehouse_name: string;
  lot_code: string;
  balance: number;
  balance_unit: string;
  expiry_date: string | null;
  status: LotStockStatus;
  /** Whole days remaining until expiry, or negative if already expired. */
  days_until_expiry: number | null;
}

export interface RecentActivityRow {
  lot_id: UUID;
  item_name: string;
  warehouse_name: string;
  lot_code: string;
  balance: number;
  balance_unit: string;
  updated_at: string;
}

export interface DashboardSummary {
  total_active_items: number;
  total_warehouses: number;
  total_active_warehouses: number;
  total_lots: number;
  out_of_stock_lots: number;
  expiring_soon_lots: number;
  expired_lots: number;
}

/** Structure returned by the aggregator, ready for rendering. */
export interface DashboardProjection {
  summary: DashboardSummary;
  attention: LotAttentionRow[];
  recent_activity: RecentActivityRow[];
}

// --------------------------------------------------------------------- //
// Pure aggregation helpers — no I/O, easy to unit-test.
// --------------------------------------------------------------------- //

/** Configurable expiry-window (calendar days). Kept as a constant so
 * every screen — and every test — sees the same value. */
export const EXPIRING_SOON_DAYS = 30;

/** Cap on the number of rows surfaced in each list. */
export const ATTENTION_LIST_LIMIT = 20;
export const RECENT_ACTIVITY_LIMIT = 10;

/** Parse the JSON balance (arrives as string from FastAPI Decimal). */
export function parseBalance(raw: number | string): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : 0;
}

/** Whole calendar days between two ISO timestamps (UTC day boundaries).
 *
 * Uses UTC day-floor semantics so a lot expiring `2026-02-15T00:00:00Z`
 * compared against a "now" of `2026-02-15T12:00:00Z` is treated as
 * expiring today (0), not "1 day ago". */
export function daysBetween(fromIso: string, referenceIso: string): number {
  const from = new Date(fromIso);
  const ref = new Date(referenceIso);
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const refDay = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  return Math.floor((fromDay - refDay) / (1000 * 60 * 60 * 24));
}

/** Classify a single lot into a rendering status. */
export function classifyLot(
  lot: DashboardLot,
  nowIso: string,
  expiringSoonDays = EXPIRING_SOON_DAYS,
): LotStockStatus {
  const balance = parseBalance(lot.balance);
  if (balance <= 0) return 'out_of_stock';
  if (lot.expiry_date) {
    const daysLeft = daysBetween(lot.expiry_date, nowIso);
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= expiringSoonDays) return 'expiring_soon';
  }
  return 'ok';
}

/**
 * Aggregate the three raw API result sets into the dashboard projection.
 *
 * @param nowIso a wall-clock ISO timestamp — passed in so the caller
 *   (and tests) can freeze time deterministically.
 */
export function buildDashboardProjection(input: {
  warehouses: DashboardWarehouse[];
  items: DashboardInventoryItem[];
  lots: DashboardLot[];
  nowIso: string;
}): DashboardProjection {
  const { warehouses, items, lots, nowIso } = input;

  const itemsById = new Map(items.map((i) => [i.id, i]));
  const warehousesById = new Map(warehouses.map((w) => [w.id, w]));

  let outOfStock = 0;
  let expiringSoon = 0;
  let expired = 0;

  const attentionRows: LotAttentionRow[] = [];
  const recentRows: RecentActivityRow[] = [];

  for (const lot of lots) {
    const item = itemsById.get(lot.item_id);
    const warehouse = warehousesById.get(lot.warehouse_id);
    const item_name = item?.name ?? 'Unknown item';
    const item_category = item?.category ?? 'unknown';
    const warehouse_name = warehouse?.name ?? 'Unknown warehouse';
    const balance = parseBalance(lot.balance);
    const status = classifyLot(lot, nowIso);
    const days_until_expiry = lot.expiry_date ? daysBetween(lot.expiry_date, nowIso) : null;

    if (status === 'out_of_stock') outOfStock += 1;
    if (status === 'expiring_soon') expiringSoon += 1;
    if (status === 'expired') expired += 1;

    if (status !== 'ok') {
      attentionRows.push({
        lot_id: lot.id,
        item_name,
        item_category,
        warehouse_name,
        lot_code: lot.lot_code,
        balance,
        balance_unit: lot.balance_unit,
        expiry_date: lot.expiry_date,
        status,
        days_until_expiry,
      });
    }

    recentRows.push({
      lot_id: lot.id,
      item_name,
      warehouse_name,
      lot_code: lot.lot_code,
      balance,
      balance_unit: lot.balance_unit,
      updated_at: lot.updated_at,
    });
  }

  // Sort attention: out-of-stock first, then expired, then expiring-soon
  // (nearest to expiry first).
  const STATUS_ORDER: Record<LotStockStatus, number> = {
    out_of_stock: 0,
    expired: 1,
    expiring_soon: 2,
    ok: 3,
  };
  attentionRows.sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    // Within the same status, oldest expiry (or lowest balance) first.
    if (a.status === 'out_of_stock' && b.status === 'out_of_stock') {
      return a.balance - b.balance;
    }
    return (a.days_until_expiry ?? 0) - (b.days_until_expiry ?? 0);
  });

  // Sort recent activity by updated_at DESC.
  recentRows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  const summary: DashboardSummary = {
    total_active_items: items.filter((i) => i.is_active).length,
    total_warehouses: warehouses.length,
    total_active_warehouses: warehouses.filter((w) => w.status === 'active').length,
    total_lots: lots.length,
    out_of_stock_lots: outOfStock,
    expiring_soon_lots: expiringSoon,
    expired_lots: expired,
  };

  return {
    summary,
    attention: attentionRows.slice(0, ATTENTION_LIST_LIMIT),
    recent_activity: recentRows.slice(0, RECENT_ACTIVITY_LIMIT),
  };
}
