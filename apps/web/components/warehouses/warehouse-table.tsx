import type { Warehouse, WarehouseSort, WarehouseSortKey } from '@/lib/inventory-warehouses';
import { WarehouseRow } from './warehouse-row';

/**
 * Sprint 5.2 — warehouse list table. Renders one row per
 * warehouse plus a sortable header. The header buttons cycle
 * asc → desc → asc for the currently-active sort key, and
 * default to ascending when switching to a new key. Sort state
 * lives in the parent list page so filters + sort + pagination
 * compose cleanly.
 */
const COLUMNS: {
  key: WarehouseSortKey | 'items' | 'last_activity' | 'actions';
  label: string;
  sortable: boolean;
  align?: 'right';
}[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'code', label: 'Code', sortable: true },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'items', label: 'Total items', sortable: false, align: 'right' },
  { key: 'last_activity', label: 'Last activity', sortable: false, align: 'right' },
  { key: 'updated_at', label: 'Updated', sortable: true, align: 'right' },
  { key: 'actions', label: '', sortable: false, align: 'right' },
];

export function WarehouseTable({
  warehouses,
  sort,
  onSortChange,
  onOpen,
}: {
  warehouses: readonly Warehouse[];
  sort: WarehouseSort;
  onSortChange: (next: WarehouseSort) => void;
  onOpen: (id: string) => void;
}) {
  function cycleSort(key: WarehouseSortKey) {
    if (sort.key !== key) {
      onSortChange({ key, direction: 'asc' });
      return;
    }
    onSortChange({ key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border" data-testid="warehouse-table">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
          <tr>
            {/* We render 7 headers but the row renders 7 columns too:
                name / code / scope / status / items / last-activity /
                updated / actions. The 'scope' column doesn't sort. */}
            <th className="px-3 py-2 text-left">
              <SortableHeader
                label="Name"
                columnKey="name"
                sort={sort}
                onClick={() => cycleSort('name')}
              />
            </th>
            <th className="px-3 py-2 text-left">
              <SortableHeader
                label="Code"
                columnKey="code"
                sort={sort}
                onClick={() => cycleSort('code')}
              />
            </th>
            <th className="px-3 py-2 text-left">Scope</th>
            <th className="px-3 py-2 text-left">
              <SortableHeader
                label="Status"
                columnKey="status"
                sort={sort}
                onClick={() => cycleSort('status')}
              />
            </th>
            <th className="px-3 py-2 text-right">Total items</th>
            <th className="px-3 py-2 text-right">Last activity</th>
            <th className="px-3 py-2 text-right">
              <SortableHeader
                label="Updated"
                columnKey="updated_at"
                sort={sort}
                onClick={() => cycleSort('updated_at')}
              />
            </th>
            <th className="px-3 py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          {warehouses.map((w) => (
            <WarehouseRow key={w.id} warehouse={w} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  columnKey,
  sort,
  onClick,
}: {
  label: string;
  columnKey: WarehouseSortKey;
  sort: WarehouseSort;
  onClick: () => void;
}) {
  const active = sort.key === columnKey;
  const arrow = active ? (sort.direction === 'asc' ? '↑' : '↓') : '';
  return (
    <button
      type="button"
      data-testid={`warehouse-table-sort-${columnKey}`}
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
    >
      <span>{label}</span>
      {arrow && <span className="text-[10px]">{arrow}</span>}
    </button>
  );
}

// Kept for external type inference where consumers want the same
// enum of visible-but-not-sortable columns.
export const WAREHOUSE_TABLE_COLUMNS = COLUMNS;
