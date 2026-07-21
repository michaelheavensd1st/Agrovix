import type { ItemCategory, ItemListFilters, StockUnit } from '@/lib/inventory-items';
import { ITEM_CATEGORIES, STOCK_UNITS, categoryLabel } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — item filter row. Options are drawn from the same
 * enums the backend enforces, so a picked value is guaranteed
 * to be an accepted filter.
 */
export function InventoryItemFilters({
  filters,
  onChange,
}: {
  filters: ItemListFilters;
  onChange: (next: ItemListFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="item-filters">
      <select
        data-testid="item-filter-category"
        value={filters.category}
        onChange={(e) => onChange({ ...filters, category: e.target.value as ItemCategory | 'all' })}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="all">All categories</option>
        {ITEM_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {categoryLabel(c)}
          </option>
        ))}
      </select>
      <select
        data-testid="item-filter-unit"
        value={filters.unit}
        onChange={(e) => onChange({ ...filters, unit: e.target.value as StockUnit | 'all' })}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="all">All units</option>
        {STOCK_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
      <select
        data-testid="item-filter-status"
        value={filters.status}
        onChange={(e) =>
          onChange({ ...filters, status: e.target.value as ItemListFilters['status'] })
        }
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </div>
  );
}
