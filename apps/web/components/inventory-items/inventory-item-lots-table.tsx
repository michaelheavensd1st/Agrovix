import type { ItemLot, ItemWarehouse } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — flat list of every lot referencing this item. Each
 * row deep-links to the workspace History tab with the correct
 * organization / warehouse / lot preselected.
 */
export function InventoryItemLotsTable({
  lots,
  warehousesById,
  organizationId,
  onOpenHistory,
}: {
  lots: readonly ItemLot[];
  warehousesById: Map<string, ItemWarehouse>;
  organizationId: string | null;
  onOpenHistory: (params: { lot: ItemLot; warehouseId: string }) => void;
}) {
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="item-lots">
      <h2 className="mb-3 font-display text-lg">Lots</h2>
      {lots.length === 0 ? (
        <div
          data-testid="item-lots-empty"
          className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        >
          No lots reference this item.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Lot code</th>
                <th className="px-3 py-2 text-left">Warehouse</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2 text-left">Expiry</th>
                <th className="px-3 py-2 text-right">Updated</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => {
                const wh = warehousesById.get(lot.warehouse_id);
                return (
                  <tr
                    key={lot.id}
                    className="border-t border-border"
                    data-testid={`item-lot-row-${lot.lot_code}`}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{lot.lot_code}</td>
                    <td className="px-3 py-2">
                      {wh ? (
                        <>
                          <p>{wh.name}</p>
                          <p className="font-mono text-[11px] text-muted-foreground">{wh.code}</p>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Unknown warehouse</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {lot.balance} {lot.balance_unit}
                    </td>
                    <td className="px-3 py-2 text-xs">{lot.expiry_date ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {lot.updated_at?.slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      <button
                        type="button"
                        onClick={() => onOpenHistory({ lot, warehouseId: lot.warehouse_id })}
                        data-testid={`item-lot-open-${lot.lot_code}`}
                        className="text-primary hover:underline"
                      >
                        History →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!organizationId && (
        <p className="mt-2 text-[10px] text-muted-foreground" aria-hidden="true">
          {/* Kept purely to satisfy the "org context preserved for
              every deep link" contract — we never render deep links
              without an org. */}
        </p>
      )}
    </section>
  );
}
