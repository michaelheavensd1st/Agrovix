import { EmptyStateCard } from '@/components/ui-polish';

export function InventoryItemEmptyState({
  variant = 'empty',
  onCreate,
  onClearFilters,
}: {
  variant?: 'empty' | 'no-match';
  onCreate?: () => void;
  onClearFilters?: () => void;
}) {
  if (variant === 'no-match') {
    return (
      <EmptyStateCard
        testId="item-empty-no-match"
        title="No items match your filters"
        description="Try clearing the search box or category / unit / status filters."
        action={
          onClearFilters ? (
            <button
              type="button"
              data-testid="item-empty-clear-filters"
              onClick={onClearFilters}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
            >
              Clear filters
            </button>
          ) : undefined
        }
      />
    );
  }
  return (
    <EmptyStateCard
      testId="item-empty-state"
      title="No inventory items yet"
      description="Create your first inventory item to start tracking stock in this organization."
      action={
        onCreate ? (
          <button
            type="button"
            data-testid="item-empty-create"
            onClick={onCreate}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            + New item
          </button>
        ) : undefined
      }
    />
  );
}
