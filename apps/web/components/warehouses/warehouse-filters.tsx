import type {
  WarehouseListFilters,
  WarehouseScope,
  WarehouseStatus,
} from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — status + scope filter selectors. Sort is handled
 * in the table header (WarehouseTable) so it stays adjacent to
 * the column being sorted.
 *
 * We deliberately do NOT provide a "site" filter because the
 * backend cannot resolve site names per-organization without
 * additional fan-out (see sprint scope decisions).
 */
export function WarehouseFilters({
  filters,
  onChange,
}: {
  filters: WarehouseListFilters;
  onChange: (next: WarehouseListFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="warehouse-filters">
      <select
        data-testid="warehouse-filter-status"
        value={filters.status}
        onChange={(e) =>
          onChange({ ...filters, status: e.target.value as WarehouseStatus | 'all' })
        }
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="all">All statuses</option>
        <option value="active">Operational</option>
        <option value="maintenance">Maintenance</option>
        <option value="closed">Closed</option>
      </select>
      <select
        data-testid="warehouse-filter-scope"
        value={filters.scope}
        onChange={(e) => onChange({ ...filters, scope: e.target.value as WarehouseScope | 'all' })}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        <option value="all">All scopes</option>
        <option value="farm_linked">Farm-linked</option>
        <option value="organization_wide">Organization-wide</option>
      </select>
    </div>
  );
}
