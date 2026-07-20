'use client';

/**
 * Inventory Dashboard — attention panel.
 *
 * Surfaces lots that need action:
 *   · out-of-stock (balance ≤ 0)
 *   · already expired
 *   · expiring within 30 days
 *
 * The dashboard does NOT synthesise a per-item "low-stock threshold"
 * because the backend `InventoryItem` schema has no `reorder_level`
 * field yet. When that is added in a later sprint, this component
 * will be extended to render a "low stock" row alongside the existing
 * statuses.
 */

import { EmptyState } from '@/components/ape-ui';
import type { LotAttentionRow, LotStockStatus } from '@/lib/inventory-dashboard';

const STATUS_LABEL: Record<LotStockStatus, string> = {
  out_of_stock: 'Out of stock',
  expired: 'Expired',
  expiring_soon: 'Expiring soon',
  ok: 'OK',
};

const STATUS_STYLE: Record<LotStockStatus, string> = {
  out_of_stock: 'bg-destructive/10 text-destructive',
  expired: 'bg-destructive/10 text-destructive',
  expiring_soon: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  ok: 'bg-muted text-foreground/80',
};

export function InventoryDashboardAttentionPanel({ rows }: { rows: LotAttentionRow[] }) {
  return (
    <section
      data-testid="inventory-dashboard-attention"
      aria-labelledby="inventory-dashboard-attention-heading"
      className="rounded-2xl border border-border bg-card/40 p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="inventory-dashboard-attention-heading" className="font-display text-lg">
          Needs attention
        </h2>
        <span
          className="text-xs text-muted-foreground"
          data-testid="inventory-dashboard-attention-count"
        >
          {rows.length} {rows.length === 1 ? 'lot' : 'lots'}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Everything looks healthy"
          description="No lots are out of stock, expired, or expiring in the next 30 days."
        />
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full text-left text-sm"
            data-testid="inventory-dashboard-attention-table"
          >
            <thead className="text-xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Item
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Warehouse
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Lot
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Balance
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Expiry
                </th>
                <th scope="col" className="py-2 pr-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.lot_id}
                  data-testid={`inventory-dashboard-attention-row-${r.lot_id}`}
                  className="border-t border-border/50"
                >
                  <td className="py-2 pr-4">
                    <div className="font-medium">{r.item_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.item_category === 'unknown' ? '—' : r.item_category}
                    </div>
                  </td>
                  <td className="py-2 pr-4">{r.warehouse_name}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.lot_code}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.balance} {r.balance_unit}
                  </td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground">
                    {r.expiry_date ? (
                      <span>
                        {r.expiry_date}
                        {r.days_until_expiry !== null && (
                          <span className="ml-1">
                            (
                            {r.days_until_expiry < 0
                              ? `${Math.abs(r.days_until_expiry)}d ago`
                              : `${r.days_until_expiry}d`}
                            )
                          </span>
                        )}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <span
                      data-testid={`inventory-dashboard-attention-status-${r.lot_id}`}
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
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
