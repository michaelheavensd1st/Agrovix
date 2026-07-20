'use client';

/**
 * Inventory Dashboard — recent activity.
 *
 * The backend does not currently expose a cross-warehouse
 * transactions endpoint. To avoid an unbounded O(lots) fan-out of
 * per-lot ledger requests, this panel uses `lot.updated_at` from the
 * existing `/warehouses/{wh}/lots` response as an honest proxy for
 * "recently changed lots". Every UPSERT to the ledger touches the
 * lot's `updated_at`, so the ordering here matches actual movement
 * order — we just do not resolve the specific transaction type on
 * the dashboard. Users can click through into the per-lot ledger to
 * see the exact transaction rows.
 */

import Link from 'next/link';
import { EmptyState } from '@/components/ape-ui';
import type { RecentActivityRow } from '@/lib/inventory-dashboard';

function formatRelative(iso: string, nowIso: string): string {
  const diffMs = new Date(nowIso).getTime() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function InventoryDashboardRecentActivity({
  rows,
  nowIso,
}: {
  rows: RecentActivityRow[];
  nowIso: string;
}) {
  return (
    <section
      data-testid="inventory-dashboard-recent"
      aria-labelledby="inventory-dashboard-recent-heading"
      className="rounded-2xl border border-border bg-card/40 p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="inventory-dashboard-recent-heading" className="font-display text-lg">
          Recent lot activity
        </h2>
        <span
          className="text-xs text-muted-foreground"
          data-testid="inventory-dashboard-recent-count"
        >
          {rows.length} {rows.length === 1 ? 'lot' : 'lots'}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No recent inventory activity"
          description="Lots that receive a receipt, issue, transfer, adjustment or reversal will surface here."
        />
      ) : (
        <ol
          className="space-y-2"
          aria-label="Most recently updated lots"
          data-testid="inventory-dashboard-recent-list"
        >
          {rows.map((r) => (
            <li
              key={r.lot_id}
              data-testid={`inventory-dashboard-recent-row-${r.lot_id}`}
              className="flex items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.item_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{r.lot_code}</span>
                  <span aria-hidden="true"> · </span>
                  {r.warehouse_name}
                </p>
              </div>
              <div className="ml-3 text-right">
                <p className="font-mono text-xs">
                  {r.balance} {r.balance_unit}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`inventory-dashboard-recent-row-${r.lot_id}-relative`}
                  title={r.updated_at}
                >
                  {formatRelative(r.updated_at, nowIso)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 border-t border-border/50 pt-3 text-right">
        <Link
          href="/inventory?tab=history"
          data-testid="inventory-dashboard-recent-history-link"
          className="text-xs text-primary hover:underline"
        >
          View full transaction history →
        </Link>
      </div>
    </section>
  );
}
