import { useMemo, useState } from 'react';
import type { ItemLedgerTx } from '@/lib/inventory-items';

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
 * Sprint 5.3 — merged activity across every lot that references
 * this item. Data comes pre-capped at 100 from the caller's
 * bounded fan-out. `partial=true` when any lot's transactions
 * failed to load; we surface it inline so operators know the
 * list is understated.
 */
export function InventoryItemActivity({
  transactions,
  partial = false,
}: {
  transactions: readonly ItemLedgerTx[];
  partial?: boolean;
}) {
  const [type, setType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filtered = useMemo(() => {
    const from = dateFrom ? Date.parse(dateFrom) : Number.NEGATIVE_INFINITY;
    const to = dateTo ? Date.parse(dateTo) + 86_400_000 - 1 : Number.POSITIVE_INFINITY;
    return transactions.filter((tx) => {
      if (type && tx.transaction_type !== type) return false;
      const t = Date.parse(tx.performed_at);
      if (Number.isFinite(t) && (t < from || t > to)) return false;
      return true;
    });
  }, [transactions, type, dateFrom, dateTo]);

  return (
    <section className="rounded-2xl border border-border p-4" data-testid="item-activity">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg">Activity</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            data-testid="item-activity-filter-type"
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
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="item-activity-filter-from"
            className="rounded-md border border-border bg-background px-2 py-1"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="item-activity-filter-to"
            className="rounded-md border border-border bg-background px-2 py-1"
          />
        </div>
      </div>
      {partial && (
        <p
          data-testid="item-activity-partial"
          className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          One or more lots could not be loaded — the activity list below may be understated.
        </p>
      )}
      {transactions.length === 0 ? (
        <div
          data-testid="item-activity-empty"
          className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground"
        >
          No transactions reference this item across any lot.
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="item-activity-no-match"
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
                <th className="px-3 py-2 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => (
                <tr
                  key={tx.id}
                  className="border-t border-border"
                  data-testid={`item-activity-row-${tx.id}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{tx.performed_at}</td>
                  <td className="px-3 py-2">{tx.transaction_type}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {tx.quantity} {tx.unit}
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
