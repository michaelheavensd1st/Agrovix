import type { Warehouse } from '@/lib/inventory-warehouses';
import { deriveScope, scopeLabel } from '@/lib/inventory-warehouses';
import { WarehouseStatusBadge } from './warehouse-status-badge';

/**
 * Sprint 5.2 — one warehouse row. Total-inventory-items and
 * last-activity intentionally render as "—" because the backend
 * cannot answer either without fan-out (deferred to the detail
 * page per sprint scope).
 */
export function WarehouseRow({
  warehouse,
  onOpen,
}: {
  warehouse: Warehouse;
  onOpen: (id: string) => void;
}) {
  const scope = deriveScope(warehouse);
  return (
    <tr
      className="border-t border-border hover:bg-secondary/40"
      data-testid={`warehouse-row-${warehouse.code}`}
    >
      <td className="px-3 py-2 font-medium">{warehouse.name}</td>
      <td className="px-3 py-2 font-mono text-xs">{warehouse.code}</td>
      <td className="px-3 py-2 text-sm">{scopeLabel(scope)}</td>
      <td className="px-3 py-2">
        <WarehouseStatusBadge status={warehouse.status} />
      </td>
      <td
        className="px-3 py-2 text-right text-sm text-muted-foreground"
        data-testid={`warehouse-row-${warehouse.code}-items`}
      >
        —
      </td>
      <td
        className="px-3 py-2 text-right text-sm text-muted-foreground"
        data-testid={`warehouse-row-${warehouse.code}-last-activity`}
      >
        —
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          data-testid={`warehouse-row-${warehouse.code}-open`}
          onClick={() => onOpen(warehouse.id)}
          className="text-xs font-medium text-primary hover:underline"
        >
          Open →
        </button>
      </td>
    </tr>
  );
}
