import type { WarehouseInventoryRow } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — item-level rollup for the current warehouse.
 * Every row is aggregated from Sprint 4 lots (active lots +
 * canonical balance + expiry). Low-stock and expiring-soon are
 * derived and never spoofed.
 */
export function WarehouseInventoryTable({
  rows,
  onOpenItem,
  onReceive,
  onIssue,
  onTransfer,
}: {
  rows: readonly WarehouseInventoryRow[];
  onOpenItem?: (itemId: string) => void;
  onReceive?: (itemId: string) => void;
  onIssue?: (itemId: string) => void;
  onTransfer?: (itemId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-2xl border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        data-testid="warehouse-inventory-empty"
      >
        No inventory in this warehouse yet.
      </div>
    );
  }
  return (
    <div
      className="overflow-x-auto rounded-md border border-border"
      data-testid="warehouse-inventory-table"
    >
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Category</th>
            <th className="px-3 py-2 text-right">Active lots</th>
            <th className="px-3 py-2 text-right">Available balance</th>
            <th className="px-3 py-2 text-left">Flags</th>
            <th className="px-3 py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.item_id}
              className="border-t border-border"
              data-testid={`warehouse-inventory-row-${r.item_code}`}
            >
              <td className="px-3 py-2">
                <p className="font-medium">{r.item_name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{r.item_code}</p>
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.category}</td>
              <td className="px-3 py-2 text-right font-mono">{r.active_lots}</td>
              <td className="px-3 py-2 text-right font-mono">
                {r.total_balance} {r.canonical_unit}
              </td>
              <td className="px-3 py-2 text-xs">
                <div className="flex flex-wrap gap-1">
                  {r.low_stock && (
                    <span
                      className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                      data-testid={`warehouse-inventory-flag-low-${r.item_code}`}
                    >
                      Low stock
                    </span>
                  )}
                  {r.expiring_soon && (
                    <span
                      className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                      data-testid={`warehouse-inventory-flag-expiring-${r.item_code}`}
                    >
                      Expiring soon
                    </span>
                  )}
                  {r.has_expired && (
                    <span
                      className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                      data-testid={`warehouse-inventory-flag-expired-${r.item_code}`}
                    >
                      Has expired lots
                    </span>
                  )}
                  {!r.low_stock && !r.expiring_soon && !r.has_expired && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex flex-wrap justify-end gap-1 text-xs">
                  {onOpenItem && (
                    <button
                      type="button"
                      data-testid={`warehouse-inventory-view-${r.item_code}`}
                      onClick={() => onOpenItem(r.item_id)}
                      className="rounded-md border border-border px-2 py-0.5 hover:bg-secondary"
                    >
                      View
                    </button>
                  )}
                  {onReceive && (
                    <button
                      type="button"
                      data-testid={`warehouse-inventory-receive-${r.item_code}`}
                      onClick={() => onReceive(r.item_id)}
                      className="rounded-md border border-border px-2 py-0.5 hover:bg-secondary"
                    >
                      Receive
                    </button>
                  )}
                  {onIssue && (
                    <button
                      type="button"
                      data-testid={`warehouse-inventory-issue-${r.item_code}`}
                      onClick={() => onIssue(r.item_id)}
                      className="rounded-md border border-border px-2 py-0.5 hover:bg-secondary"
                    >
                      Issue
                    </button>
                  )}
                  {onTransfer && (
                    <button
                      type="button"
                      data-testid={`warehouse-inventory-transfer-${r.item_code}`}
                      onClick={() => onTransfer(r.item_id)}
                      className="rounded-md border border-border px-2 py-0.5 hover:bg-secondary"
                    >
                      Transfer
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
