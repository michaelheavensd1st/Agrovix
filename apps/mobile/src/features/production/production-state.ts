export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export function buildProductionBreadcrumbs(scope: {
  organizationName?: string | null;
  farmName?: string | null;
  siteName?: string | null;
  unitName?: string | null;
  batchName?: string | null;
}): string[] {
  return [
    scope.organizationName,
    scope.farmName,
    scope.siteName,
    scope.unitName,
    scope.batchName,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

const lifecycleLabels: Record<string, string> = {
  planned: 'Planned',
  stocked: 'Stocked',
  active: 'Active',
  harvested: 'Harvested',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
  failed: 'Failed',
  maintenance: 'Maintenance',
  closed: 'Closed',
};

export function describeLifecycleState(value?: string | null): string {
  if (!value) return 'Unknown';
  return (
    lifecycleLabels[value] ??
    value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  );
}

export function getStatusTone(value?: string | null): StatusTone {
  switch ((value ?? '').toLowerCase()) {
    case 'active':
    case 'success':
    case 'stocked':
      return 'success';
    case 'planned':
    case 'maintenance':
      return 'warning';
    case 'failed':
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function sortBatchEvents<
  T extends { performed_at?: string | null; event_type?: string | null },
>(events: T[]): T[] {
  return [...events].sort((left, right) => {
    const leftTime = left.performed_at ? Date.parse(left.performed_at) : Number.NEGATIVE_INFINITY;
    const rightTime = right.performed_at
      ? Date.parse(right.performed_at)
      : Number.NEGATIVE_INFINITY;
    return leftTime - rightTime;
  });
}
