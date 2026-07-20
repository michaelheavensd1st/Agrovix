'use client';

/**
 * Inventory Dashboard — quick actions.
 *
 * Every action links to an existing route in the Sprint 4 inventory
 * workspace, with the currently selected organization propagated via
 * the `organization_id` query parameter so the workspace can rehydrate
 * the tenant context on landing. Actions that do not yet have a
 * destination screen are NOT rendered as functional buttons — they
 * are marked "Coming later in Sprint 5" and are non-interactive, so
 * the dashboard never creates broken navigation.
 */

import Link from 'next/link';

interface ActionSpec {
  key: string;
  label: string;
  description: string;
  /** Sub-tab in `/inventory`, or `null` when the destination is deferred. */
  tab: string | null;
  deferredNote?: string;
}

const ACTIONS: ActionSpec[] = [
  {
    key: 'view-items',
    label: 'View inventory items',
    description: 'Browse the catalog of feed, medicine, chemical and supply items.',
    tab: 'items',
  },
  {
    key: 'view-warehouses',
    label: 'View warehouses',
    description: 'See warehouses and their lots + balances for this organization.',
    tab: 'warehouses',
  },
  {
    key: 'receive-stock',
    label: 'Receive stock',
    description: 'Record a new receipt against a lot in a warehouse.',
    tab: 'receive',
  },
  {
    key: 'issue-stock',
    label: 'Issue stock',
    description: 'Consume stock from an existing lot.',
    tab: 'issue',
  },
  {
    key: 'transfer-stock',
    label: 'Transfer stock',
    description: 'Immediate transfer between two warehouses. No draft or in-transit state.',
    tab: 'transfer',
  },
  {
    key: 'transaction-history',
    label: 'Transaction history',
    description: 'Per-lot ledger with cursor pagination.',
    tab: 'history',
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    description: 'Supplier directory and purchase relationships.',
    tab: null,
    deferredNote: 'Coming later in Sprint 5',
  },
  {
    key: 'purchases',
    label: 'Purchases',
    description: 'Purchase orders and inbound receipts.',
    tab: null,
    deferredNote: 'Coming later in Sprint 5',
  },
];

/** Build a workspace URL that preserves the organization context. */
export function buildWorkspaceHref(organizationId: string | null, tab: string | null): string {
  const params = new URLSearchParams();
  if (organizationId) params.set('organization_id', organizationId);
  if (tab) params.set('tab', tab);
  const qs = params.toString();
  return qs ? `/inventory?${qs}` : '/inventory';
}

export function InventoryDashboardQuickActions({
  organizationId,
}: {
  organizationId: string | null;
}) {
  return (
    <section
      data-testid="inventory-dashboard-quick-actions"
      aria-labelledby="inventory-dashboard-quick-actions-heading"
      className="rounded-2xl border border-border bg-card/40 p-4"
    >
      <h2 id="inventory-dashboard-quick-actions-heading" className="mb-3 font-display text-lg">
        Quick actions
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ACTIONS.map((a) =>
          a.tab ? (
            <li key={a.key}>
              <Link
                href={buildWorkspaceHref(organizationId, a.tab)}
                data-testid={`inventory-dashboard-action-${a.key}`}
                className="block rounded-md border border-border bg-background px-3 py-2 transition hover:border-primary/40 hover:bg-secondary"
              >
                <p className="text-sm font-medium">{a.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
              </Link>
            </li>
          ) : (
            <li key={a.key}>
              <div
                data-testid={`inventory-dashboard-action-${a.key}`}
                aria-disabled="true"
                className="block cursor-not-allowed rounded-md border border-dashed border-border/60 bg-muted/40 px-3 py-2 opacity-70"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{a.label}</p>
                  {a.deferredNote && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                      {a.deferredNote}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
