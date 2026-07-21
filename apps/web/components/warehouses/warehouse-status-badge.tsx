import type { WarehouseStatus } from '@/lib/inventory-warehouses';
import { statusLabel } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — status badge for a warehouse. Uses distinct
 * text + colour per lifecycle state so operators can scan a list
 * quickly. The `active` label is deliberately "Operational"
 * (see sprint spec: "active → operational").
 */
export function WarehouseStatusBadge({ status }: { status: WarehouseStatus }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : status === 'closed'
        ? 'bg-muted text-muted-foreground'
        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
  return (
    <span
      data-testid={`warehouse-status-badge-${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {statusLabel(status)}
    </span>
  );
}
