import type { InventoryItem, ItemOrganization } from '@/lib/inventory-items';
import { categoryLabel } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — read-only summary card for the item detail view.
 * Every row maps to a real backend field. `metadata_json` and
 * `deleted_at` are technical-only and not surfaced here.
 */
export function InventoryItemSummary({
  item,
  organization,
}: {
  item: InventoryItem;
  organization: ItemOrganization | null;
}) {
  const rows: [string, React.ReactNode, string][] = [
    ['Name', item.name, 'name'],
    [
      'Code',
      <span key="code" className="font-mono">
        {item.code}
      </span>,
      'code',
    ],
    ['SKU', item.sku ?? '—', 'sku'],
    ['Category', categoryLabel(item.category), 'category'],
    ['Canonical unit', item.canonical_unit, 'unit'],
    ['Status', item.is_active ? 'Active' : 'Inactive', 'status'],
    ['Organization', organization?.name ?? '—', 'organization'],
    [
      'Created',
      <span key="created" className="font-mono text-xs">
        {item.created_at}
      </span>,
      'created',
    ],
    [
      'Updated',
      <span key="updated" className="font-mono text-xs">
        {item.updated_at}
      </span>,
      'updated',
    ],
    ['Description', item.description ?? 'Not set', 'description'],
  ];
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="item-summary">
      <h2 className="mb-3 font-display text-lg">Summary</h2>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value, key]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs uppercase tracking-widest text-muted-foreground">{label}</dt>
            <dd className="text-sm" data-testid={`item-summary-${key}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
