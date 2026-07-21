import Link from 'next/link';
import type { InventoryItem } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — right-rail quick actions on the item detail page.
 *
 * Every href carries the current `organization_id` so the
 * workspace lands on the same tenant, and the `item_id` /
 * warehouse_id / lot_id where relevant. Inactive items still
 * expose "View lots" and "View history" (read-only) but hide
 * write actions to avoid a 400 from the backend guards.
 */
export function InventoryItemQuickActions({
  item,
  organizationId,
}: {
  item: InventoryItem;
  organizationId: string | null;
}) {
  const inactive = !item.is_active;
  const orgQuery = organizationId ? `organization_id=${encodeURIComponent(organizationId)}&` : '';
  const itemQuery = `item_id=${encodeURIComponent(item.id)}`;
  const actions: {
    label: string;
    href: string;
    key: 'receive' | 'issue' | 'transfer' | 'lots' | 'history';
    disable: boolean;
  }[] = [
    {
      label: 'Receive',
      href: `/inventory?${orgQuery}tab=receive&${itemQuery}`,
      key: 'receive',
      disable: inactive,
    },
    {
      label: 'Issue',
      href: `/inventory?${orgQuery}tab=issue&${itemQuery}`,
      key: 'issue',
      disable: inactive,
    },
    {
      label: 'Transfer',
      href: `/inventory?${orgQuery}tab=transfer&${itemQuery}`,
      key: 'transfer',
      disable: inactive,
    },
    {
      label: 'View lots',
      href: `/inventory?${orgQuery}tab=lots&${itemQuery}`,
      key: 'lots',
      disable: false,
    },
    {
      label: 'View history',
      href: `/inventory?${orgQuery}tab=history&${itemQuery}`,
      key: 'history',
      disable: false,
    },
  ];
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="item-quick-actions">
      <h2 className="mb-3 font-display text-lg">Quick actions</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map(({ label, href, key, disable }) =>
          disable ? (
            <div
              key={key}
              data-testid={`item-quick-action-${key}`}
              aria-disabled="true"
              title="This item is inactive. Reactivate it before posting inventory movements."
              className="cursor-not-allowed rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
            >
              {label}
            </div>
          ) : (
            <Link
              key={key}
              href={href}
              data-testid={`item-quick-action-${key}`}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary"
            >
              {label}
            </Link>
          ),
        )}
      </div>
    </section>
  );
}
