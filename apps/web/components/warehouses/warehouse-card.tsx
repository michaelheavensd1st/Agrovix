import type { Warehouse } from '@/lib/inventory-warehouses';
import { deriveScope, scopeLabel } from '@/lib/inventory-warehouses';
import { WarehouseStatusBadge } from './warehouse-status-badge';

/**
 * Sprint 5.2 — grid card view of a single warehouse (used by the
 * "Warehouses" quick tile on the inventory landing, and as a
 * compact preview above the list on mobile). Keeps the same
 * data-testid convention as `WarehouseRow`.
 */
export function WarehouseCard({
  warehouse,
  onOpen,
}: {
  warehouse: Warehouse;
  onOpen: (id: string) => void;
}) {
  const scope = deriveScope(warehouse);
  return (
    <button
      type="button"
      data-testid={`warehouse-card-${warehouse.code}`}
      onClick={() => onOpen(warehouse.id)}
      className="w-full rounded-2xl border border-border p-4 text-left transition hover:bg-secondary/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-lg">{warehouse.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{warehouse.code}</p>
        </div>
        <WarehouseStatusBadge status={warehouse.status} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{scopeLabel(scope)}</p>
    </button>
  );
}
