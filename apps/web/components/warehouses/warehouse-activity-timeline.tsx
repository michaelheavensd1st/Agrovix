import { useMemo, useState } from 'react';
import type { WarehouseLedgerTx } from '@/lib/inventory-warehouses';

const TX_TYPES = [
  'receipt',
  'issue',
  'consumption',
  'transfer_out',
  'transfer_in',
  'adjustment_increase',
  'adjustment_decrease',
  'reversal',
];

/**
 * Sprint 5.2 — cross-lot activity timeline for a single
 * warehouse. Transactions come pre-merged and pre-capped from
 * the fan-out (see `inspectActivityFanOut`). We apply date +
 * type + user filters client-side because the volume is bounded
 * at 100 by construction.
 *
 * `partial=true` means at least one lot's transactions failed to
 * load and the caller is showing a scoped warning; we surface an
 * inline note so operators know the list is understated.
 */
export function WarehouseActivityTimeline({
  transactions,
  partial = false,
  actorLabelFor,
}: {
  transactions: readonly WarehouseLedgerTx[];
  partial?: boolean;
  actorLabelFor?: (tx: WarehouseLedgerTx) => string;
}) {
  const [type, setType] = useState<string>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [userQuery, setUserQuery] = useState('');

  const filtered = useMemo(() => {
    const uq = userQuery.trim().toLowerCase();
    const from = dateFrom ? Date.parse(dateFrom) : Number.NEGATIVE_INFINITY;
    const to = dateTo ? Date.parse(dateTo) + 24 * 3600 * 1000 - 1 : Number.POSITIVE_INFINITY;
    return transactions.filter((tx) => {
      if (type && tx.transaction_type !== type) return false;
      const t = Date.parse(tx.performed_at);
      if (Number.isFinite(t)) {
        if (t < from || t > to) return false;
      }
      if (uq) {
        const actor = (
          actorLabelFor?.(tx) ??
          tx.actor_display ??
          tx.performed_by ??
          ''
        ).toLowerCase();
        if (!actor.includes(uq)) return false;
      }
      return true;
    });
  }, [transactions, type, dateFrom, dateTo, userQuery, actorLabelFor]);

  return (
    <section
      className="rounded-2xl border border-border p-4"
      data-testid="warehouse-activity-timeline"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg">Activity</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            data-testid="warehouse-activity-filter-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            <option value="">All types</option>
            {TX_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <input
            type="date"
            data-testid="warehouse-activity-filter-from"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
          <input
            type="date"
            data-testid="warehouse-activity-filter-to"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1"
          />
          <input
            type="search"
            data-testid="warehouse-activity-filter-user"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="User…"
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        </div>
      </div>
      {partial && (
        <p
          data-testid="warehouse-activity-partial"
          className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          One or more lots could not be loaded — the activity list below may be understated.
        </p>
      )}
      {transactions.length === 0 ? (
        <div
          data-testid="warehouse-activity-empty"
          className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        >
          No transactions have been posted in this warehouse yet.
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="warehouse-activity-no-match"
          className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        >
          No transactions match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Ref</th>
                <th className="px-3 py-2 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr
                  key={tx.id}
                  className="border-t border-border"
                  data-testid={`warehouse-activity-row-${tx.id}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{tx.performed_at}</td>
                  <td className="px-3 py-2">{tx.transaction_type}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {tx.quantity} {tx.unit}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {actorLabelFor?.(tx) ?? tx.actor_display ?? tx.performed_by ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {tx.reference_type ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">{tx.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
