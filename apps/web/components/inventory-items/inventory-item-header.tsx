import Link from 'next/link';
import type { InventoryItem, ItemOrganization } from '@/lib/inventory-items';
import { categoryLabel } from '@/lib/inventory-items';
import { InventoryItemStatusBadge } from './inventory-item-status-badge';

/**
 * Sprint 5.3 — item-detail header. The action buttons on the
 * right map 1:1 to backend PATCH transitions:
 *   - Edit → open the edit form (mutates name / description /
 *     sku).
 *   - Deactivate / Activate → PATCH is_active=false / true. No
 *     "Archive" or "Close" — the backend has no such state.
 */
export function InventoryItemHeader({
  item,
  organization,
  onEdit,
  onToggleActive,
  editDisabled,
}: {
  item: InventoryItem;
  organization: ItemOrganization | null;
  onEdit: () => void;
  onToggleActive: (next: boolean) => void;
  editDisabled?: boolean;
}) {
  const backHref = organization
    ? `/inventory/items?organization_id=${encodeURIComponent(organization.id)}`
    : '/inventory/items';
  return (
    <header
      className="mb-6 flex flex-wrap items-start justify-between gap-3"
      data-testid="item-header"
    >
      <div>
        <Link
          href={backHref}
          data-testid="item-header-back"
          className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          ← All items
        </Link>
        <h1 className="mt-1 font-display text-3xl" data-testid="item-header-name">
          {item.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-mono">{item.code}</span>
          {organization && <span> · {organization.name}</span>}
          <span> · {categoryLabel(item.category)}</span>
          <span> · {item.canonical_unit}</span>
        </p>
        <div className="mt-2">
          <InventoryItemStatusBadge item={item} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          data-testid="item-header-edit"
          onClick={onEdit}
          disabled={editDisabled}
          className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary disabled:opacity-60"
        >
          Edit
        </button>
        {item.is_active ? (
          <button
            type="button"
            data-testid="item-header-deactivate"
            onClick={() => onToggleActive(false)}
            className="rounded-md border border-destructive/50 px-3 py-1.5 text-destructive hover:bg-destructive/10"
          >
            Deactivate
          </button>
        ) : (
          <button
            type="button"
            data-testid="item-header-activate"
            onClick={() => onToggleActive(true)}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary"
          >
            Activate
          </button>
        )}
      </div>
    </header>
  );
}
