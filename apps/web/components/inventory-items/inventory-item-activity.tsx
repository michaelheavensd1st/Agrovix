import { useMemo, useState } from 'react';
import type { ItemLedgerTx } from '@/lib/inventory-items';
import { isReversibleTransaction } from '@/lib/stock-operations';

// Sprint 5.4: filters and display now key off the exact backend
// enum values. Only the five operation-level categories are shown
// in the filter — TRANSFER lumps out+in so the operator sees a
// single logical entry per operation regardless of side.
const TX_FILTERS: Array<{ value: string; label: string; matches: (t: string) => boolean }> = [
  { value: '', label: 'All types', matches: () => true },
  { value: 'RECEIPT', label: 'Receipt', matches: (t) => t === 'receipt' },
  { value: 'ISSUE', label: 'Issue', matches: (t) => t === 'issue' || t === 'consumption' },
  {
    value: 'TRANSFER',
    label: 'Transfer',
    matches: (t) => t === 'transfer_out' || t === 'transfer_in',
  },
  {
    value: 'ADJUSTMENT',
    label: 'Adjustment',
    matches: (t) => t === 'adjustment_increase' || t === 'adjustment_decrease',
  },
  { value: 'REVERSAL', label: 'Reversal', matches: (t) => t === 'reversal' },
];

/**
 * Sprint 5.3 + 5.4 — merged activity across every lot that
 * references this item. Sprint 5.4 adds per-row reversal actions
 * (only enabled on eligible transaction types) and operation-type
 * filters keyed to the API enums.
 *
 * `partial=true` retains its Sprint 5.3 meaning: the merged list
 * is understated.
 */
export function InventoryItemActivity({
  transactions,
  partial = false,
  onReverse,
}: {
  transactions: readonly ItemLedgerTx[];
  partial?: boolean;
  onReverse?: (tx: ItemLedgerTx) => void;
}) {
  const [type, setType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Sprint 5.4.1 — reversal eligibility is derived from activity
  // state, not just the transaction type. Any transaction that
  // already has a corresponding reversal row in the loaded
  // activity slice is treated as already-reversed and must not
  // offer a fresh Reverse action.
  const alreadyReversedIds = useMemo(() => {
    const s = new Set<string>();
    for (const tx of transactions) {
      if (tx.reverses_transaction_id) s.add(tx.reverses_transaction_id);
    }
    return s;
  }, [transactions]);

  const filtered = useMemo(() => {
    const filter = TX_FILTERS.find((f) => f.value === type) ?? TX_FILTERS[0];
    const from = dateFrom ? Date.parse(dateFrom) : Number.NEGATIVE_INFINITY;
    const to = dateTo ? Date.parse(dateTo) + 86_400_000 - 1 : Number.POSITIVE_INFINITY;
    return transactions.filter((tx) => {
      if (!filter.matches(tx.transaction_type)) return false;
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
          <label className="flex items-center gap-1">
            <span className="sr-only">Operation type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              data-testid="item-activity-filter-type"
              aria-label="Operation type"
              className="rounded-md border border-border bg-background px-2 py-1"
            >
              {TX_FILTERS.map((f) => (
                <option key={f.value || 'all'} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="sr-only">Start date</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              data-testid="item-activity-filter-from"
              aria-label="Start date"
              className="rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="sr-only">End date</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              data-testid="item-activity-filter-to"
              aria-label="End date"
              className="rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
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
                {onReverse && <th className="px-3 py-2 text-right">Action</th>}
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
                  {onReverse && (
                    <td className="px-3 py-2 text-right">
                      {isReversibleTransaction(tx) && !alreadyReversedIds.has(tx.id) ? (
                        <button
                          type="button"
                          data-testid={`item-activity-reverse-${tx.id}`}
                          onClick={() => onReverse(tx)}
                          className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-secondary"
                        >
                          {tx.transaction_type === 'transfer_out' ? 'Reverse transfer' : 'Reverse'}
                        </button>
                      ) : alreadyReversedIds.has(tx.id) ? (
                        <span
                          data-testid={`item-activity-reversed-${tx.id}`}
                          className="text-xs text-muted-foreground"
                          title="Already reversed"
                        >
                          Reversed
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
