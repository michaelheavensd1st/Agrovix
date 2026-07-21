import type { ItemAvailabilityRow } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — per-warehouse availability rollup for a single
 * item. The `partial` flag comes from a bounded fan-out failure
 * (some warehouses could not be queried); we surface an explicit
 * "understated" notice so an operator never mistakes a partial
 * total for a complete one.
 */
export function InventoryItemAvailabilityTable({
  rows,
  partial = false,
  onOpenWarehouse,
}: {
  rows: readonly ItemAvailabilityRow[];
  partial?: boolean;
  onOpenWarehouse?: (warehouseId: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="item-availability">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-lg">Warehouse availability</h2>
      </div>
      {partial && (
        <p
          data-testid="item-availability-partial"
          className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          One or more warehouses could not be loaded — the totals below may be understated.
        </p>
      )}
      {rows.length === 0 ? (
        <div
          data-testid="item-availability-empty"
          className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        >
          No warehouse holds a positive-balance lot of this item.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Warehouse</th>
                <th className="px-3 py-2 text-right">Lots</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2 text-left">Flags</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.warehouse_id}
                  className="border-t border-border"
                  data-testid={`item-availability-row-${r.warehouse_code}`}
                >
                  <td className="px-3 py-2">
                    <p className="font-medium">{r.warehouse_name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {r.warehouse_code}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.lot_count}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.total_balance} {r.canonical_unit}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="flex flex-wrap gap-1">
                      {r.low_stock && (
                        <span
                          className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                          data-testid={`item-availability-flag-low-${r.warehouse_code}`}
                        >
                          Low stock
                        </span>
                      )}
                      {r.expiring_soon && (
                        <span
                          className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                          data-testid={`item-availability-flag-expiring-${r.warehouse_code}`}
                        >
                          Expiring soon
                        </span>
                      )}
                      {r.has_expired && (
                        <span
                          className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                          data-testid={`item-availability-flag-expired-${r.warehouse_code}`}
                        >
                          Has expired lots
                        </span>
                      )}
                      {!r.low_stock && !r.expiring_soon && !r.has_expired && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {onOpenWarehouse && (
                      <button
                        type="button"
                        onClick={() => onOpenWarehouse(r.warehouse_id)}
                        data-testid={`item-availability-open-${r.warehouse_code}`}
                        className="text-primary hover:underline"
                      >
                        Open warehouse →
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
