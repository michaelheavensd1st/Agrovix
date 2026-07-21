import type { InventoryItem, ItemSort, ItemSortKey } from '@/lib/inventory-items';
import { categoryLabel } from '@/lib/inventory-items';
import { InventoryItemStatusBadge } from './inventory-item-status-badge';

/**
 * Sprint 5.3 — one item row. The "Warehouse availability" column
 * is intentionally NOT populated at the list level (would require
 * per-row fan-out). We show `—` truthfully and defer the number
 * to the detail page's availability table.
 */
export function InventoryItemRow({
  item,
  onOpen,
}: {
  item: InventoryItem;
  onOpen: (id: string) => void;
}) {
  return (
    <tr
      className="border-t border-border hover:bg-secondary/40"
      data-testid={`item-row-${item.code}`}
    >
      <td className="px-3 py-2 font-medium">{item.name}</td>
      <td className="px-3 py-2 font-mono text-xs">{item.code}</td>
      <td className="px-3 py-2 text-xs font-mono">{item.sku ?? '—'}</td>
      <td className="px-3 py-2 text-sm">{categoryLabel(item.category)}</td>
      <td className="px-3 py-2 text-sm">{item.canonical_unit}</td>
      <td className="px-3 py-2">
        <InventoryItemStatusBadge item={item} />
      </td>
      <td className="px-3 py-2 text-right text-xs font-mono text-muted-foreground">
        {item.updated_at.slice(0, 10)}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          data-testid={`item-row-${item.code}-open`}
          onClick={() => onOpen(item.id)}
          className="text-xs font-medium text-primary hover:underline"
        >
          Open →
        </button>
      </td>
    </tr>
  );
}

const SORT_HEADERS: { key: ItemSortKey; label: string; align?: 'left' | 'right' }[] = [
  { key: 'name', label: 'Name' },
  { key: 'code', label: 'Code' },
  { key: 'category', label: 'Category' },
  { key: 'canonical_unit', label: 'Unit' },
  { key: 'updated_at', label: 'Updated', align: 'right' },
];

export function InventoryItemTable({
  items,
  sort,
  onSortChange,
  onOpen,
}: {
  items: readonly InventoryItem[];
  sort: ItemSort;
  onSortChange: (next: ItemSort) => void;
  onOpen: (id: string) => void;
}) {
  function cycleSort(key: ItemSortKey) {
    if (sort.key !== key) return onSortChange({ key, direction: 'asc' });
    onSortChange({ key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border" data-testid="item-table">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
          <tr>
            <SortableTh
              columnKey="name"
              label="Name"
              sort={sort}
              onClick={() => cycleSort('name')}
            />
            <SortableTh
              columnKey="code"
              label="Code"
              sort={sort}
              onClick={() => cycleSort('code')}
            />
            <th className="px-3 py-2 text-left">SKU</th>
            <SortableTh
              columnKey="category"
              label="Category"
              sort={sort}
              onClick={() => cycleSort('category')}
            />
            <SortableTh
              columnKey="canonical_unit"
              label="Unit"
              sort={sort}
              onClick={() => cycleSort('canonical_unit')}
            />
            <th className="px-3 py-2 text-left">Status</th>
            <SortableTh
              columnKey="updated_at"
              label="Updated"
              sort={sort}
              onClick={() => cycleSort('updated_at')}
              align="right"
            />
            <th className="px-3 py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <InventoryItemRow key={i.id} item={i} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableTh({
  columnKey,
  label,
  sort,
  onClick,
  align = 'left',
}: {
  columnKey: ItemSortKey;
  label: string;
  sort: ItemSort;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === columnKey;
  const arrow = active ? (sort.direction === 'asc' ? '↑' : '↓') : '';
  return (
    <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        data-testid={`item-table-sort-${columnKey}`}
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        <span>{label}</span>
        {arrow && <span className="text-[10px]">{arrow}</span>}
      </button>
    </th>
  );
}

// SORT_HEADERS is re-exported so consumers wanting a schema-level
// list of visible sortable columns can pick it up without redoing
// the enum work.
export { SORT_HEADERS as INVENTORY_ITEM_TABLE_SORTABLE };
