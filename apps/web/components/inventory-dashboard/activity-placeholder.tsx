'use client';

/**
 * Inventory Dashboard — activity placeholder.
 *
 * Sprint 5.1 review finding: the previous "Recent lot activity" list
 * used `InventoryLot.updated_at` as a supposed proxy for inventory
 * ledger movements. Backend tracing confirmed that receipts, issues,
 * transfers, adjustments and reversals write `InventoryTransaction`
 * rows without touching the parent lot's timestamp, so that ordering
 * was misleading.
 *
 * Because Sprint 5.1 must remain frontend-only, we intentionally do
 * NOT synthesise a global activity feed here. Instead this panel is
 * an explicit, honest deferral pointing users at the existing
 * per-lot ledger in the inventory workspace.
 *
 * When a cross-warehouse transaction endpoint ships in a later
 * sprint, this component will be replaced with a real feed.
 */

import Link from 'next/link';

interface Props {
  /** The organization id must be preserved when linking into the
   * workspace so the user does not lose their org context. */
  organizationId: string | null;
}

export function InventoryDashboardActivityPlaceholder({ organizationId }: Props) {
  const historyHref = organizationId
    ? `/inventory?organization_id=${encodeURIComponent(organizationId)}&tab=history`
    : '/inventory?tab=history';

  return (
    <section
      data-testid="inventory-dashboard-activity-placeholder"
      aria-labelledby="inventory-dashboard-activity-heading"
      className="rounded-2xl border border-dashed border-border bg-card/40 p-6"
    >
      <h2 id="inventory-dashboard-activity-heading" className="font-display text-lg">
        Recent inventory activity
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        A cross-warehouse transaction feed is not yet available.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Open transaction history in the inventory workspace to review lot-level records.
      </p>
      <div className="mt-4">
        <Link
          href={historyHref}
          data-testid="inventory-dashboard-activity-history-link"
          className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:border-primary/40 hover:bg-secondary"
        >
          Open transaction history →
        </Link>
      </div>
    </section>
  );
}
