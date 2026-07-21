import Link from 'next/link';
import type { Warehouse } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — right-rail quick actions on the warehouse detail
 * page. Every href carries `organization_id` + `warehouse` (via
 * `selectedWh` on the workspace) so the Sprint 5.1 workspace
 * lands on the correct tab already selected.
 *
 * Closed warehouses cannot receive / issue / transfer; the
 * buttons are disabled and carry an explanatory tooltip via the
 * `title` attribute.
 */
export function WarehouseQuickActions({
  warehouse,
  organizationId,
}: {
  warehouse: Warehouse;
  organizationId: string | null;
}) {
  const closed = warehouse.status === 'closed';
  const base = '/inventory';
  const orgQuery = organizationId ? `organization_id=${encodeURIComponent(organizationId)}&` : '';
  const actions: [string, string, string][] = [
    ['Receive', `${base}?${orgQuery}tab=receive`, 'receive'],
    ['Issue', `${base}?${orgQuery}tab=issue`, 'issue'],
    ['Transfer', `${base}?${orgQuery}tab=transfer`, 'transfer'],
    ['View history', `${base}?${orgQuery}tab=history`, 'history'],
  ];
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="warehouse-quick-actions">
      <h2 className="mb-3 font-display text-lg">Quick actions</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map(([label, href, key]) => {
          const disable = closed && key !== 'history';
          if (disable) {
            return (
              <div
                key={key}
                data-testid={`warehouse-quick-action-${key}`}
                aria-disabled="true"
                title="This warehouse is closed. Reopen it before posting inventory movements."
                className="cursor-not-allowed rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
              >
                {label}
              </div>
            );
          }
          return (
            <Link
              key={key}
              href={href}
              data-testid={`warehouse-quick-action-${key}`}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary"
            >
              {label}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
