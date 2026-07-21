import type { InventoryItem } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — status badge for an inventory item. Backed by the
 * boolean `is_active` field only; there is no closed/archived
 * concept in the backend so we do not fabricate one.
 */
export function InventoryItemStatusBadge({ item }: { item: Pick<InventoryItem, 'is_active'> }) {
  const active = item.is_active;
  return (
    <span
      data-testid={`item-status-badge-${active ? 'active' : 'inactive'}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        active
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}
