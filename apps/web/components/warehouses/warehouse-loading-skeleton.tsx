import { SkeletonRows } from '@/components/ui-polish';

/**
 * Sprint 5.2 — dedicated loading skeleton for the warehouse list
 * and detail views. Distinct testid so tests can assert loading
 * state without falling back to querying generic skeleton rows.
 */
export function WarehouseLoadingSkeleton({
  rows = 6,
  testId = 'warehouse-loading-skeleton',
}: {
  rows?: number;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <SkeletonRows rows={rows} />
    </div>
  );
}
