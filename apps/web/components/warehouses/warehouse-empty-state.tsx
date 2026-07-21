import { EmptyStateCard } from '@/components/ui-polish';

/**
 * Sprint 5.2 — empty state for a fresh organization with no
 * warehouses yet. Also used as a "no results" state under an
 * active search / filter combination when appropriate.
 */
export function WarehouseEmptyState({
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
        testId="warehouse-empty-no-match"
        title="No warehouses match your filters"
        description="Adjust the search box or status / scope filters, or clear them to see every warehouse."
        action={
          onClearFilters ? (
            <button
              type="button"
              data-testid="warehouse-empty-clear-filters"
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
      testId="warehouse-empty-state"
      title="No warehouses yet"
      description="Create your first warehouse to start tracking inventory in this organization."
      action={
        onCreate ? (
          <button
            type="button"
            data-testid="warehouse-empty-create"
            onClick={onCreate}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            + New warehouse
          </button>
        ) : undefined
      }
    />
  );
}
