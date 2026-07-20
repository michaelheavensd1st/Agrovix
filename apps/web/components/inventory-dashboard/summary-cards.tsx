'use client';

/**
 * Inventory Dashboard — summary metric cards.
 *
 * Every metric here is derived on the frontend from data returned by
 * the existing Sprint 4 inventory endpoints. No fabricated values.
 */

import type { DashboardSummary } from '@/lib/inventory-dashboard';

interface Metric {
  key: keyof DashboardSummary | 'inactive_warehouses';
  label: string;
  value: number;
  hint?: string;
  emphasis?: 'attention' | 'critical';
}

export function InventoryDashboardSummaryCards({ summary }: { summary: DashboardSummary }) {
  const metrics: Metric[] = [
    {
      key: 'total_active_items',
      label: 'Active items',
      value: summary.total_active_items,
      hint: 'Items marked active in the catalog',
    },
    {
      key: 'total_warehouses',
      label: 'Warehouses',
      value: summary.total_warehouses,
      hint: `${summary.total_active_warehouses} active`,
    },
    {
      key: 'total_lots',
      label: 'Tracked lots',
      value: summary.total_lots,
      hint: 'Across all warehouses in this organization',
    },
    {
      key: 'out_of_stock_lots',
      label: 'Out of stock',
      value: summary.out_of_stock_lots,
      hint: 'Lots with balance ≤ 0',
      emphasis: summary.out_of_stock_lots > 0 ? 'critical' : undefined,
    },
    {
      key: 'expiring_soon_lots',
      label: 'Expiring soon',
      value: summary.expiring_soon_lots,
      hint: 'Within the next 30 days',
      emphasis: summary.expiring_soon_lots > 0 ? 'attention' : undefined,
    },
    {
      key: 'expired_lots',
      label: 'Already expired',
      value: summary.expired_lots,
      hint: 'Expiry date is in the past',
      emphasis: summary.expired_lots > 0 ? 'critical' : undefined,
    },
  ];

  return (
    <section
      data-testid="inventory-dashboard-summary"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      aria-label="Inventory summary"
    >
      {metrics.map((m) => (
        <SummaryCard key={m.key} metric={m} />
      ))}
    </section>
  );
}

function SummaryCard({ metric }: { metric: Metric }) {
  const emphasisRing =
    metric.emphasis === 'critical'
      ? 'border-destructive/40 bg-destructive/5'
      : metric.emphasis === 'attention'
        ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-border bg-card/40';

  return (
    <article
      data-testid={`inventory-dashboard-metric-${metric.key}`}
      className={`rounded-2xl border p-4 ${emphasisRing}`}
    >
      <p className="text-xs uppercase tracking-widest text-muted-foreground">{metric.label}</p>
      <p
        className="mt-1 font-display text-3xl"
        data-testid={`inventory-dashboard-metric-${metric.key}-value`}
      >
        {metric.value}
      </p>
      {metric.hint && <p className="mt-1 text-xs text-muted-foreground">{metric.hint}</p>}
    </article>
  );
}
