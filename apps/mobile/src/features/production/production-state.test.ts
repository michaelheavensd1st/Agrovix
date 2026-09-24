import {
  buildProductionBreadcrumbs,
  describeLifecycleState,
  getStatusTone,
  sortBatchEvents,
} from './production-state';

describe('production state helpers', () => {
  test('builds breadcrumb paths for the read-only production journey', () => {
    expect(
      buildProductionBreadcrumbs({
        organizationName: 'North Farm Holdings',
        farmName: 'North Farm',
        siteName: 'Pond 01',
        unitName: 'Tank A1',
        batchName: 'B-001',
      }),
    ).toEqual(['North Farm Holdings', 'North Farm', 'Pond 01', 'Tank A1', 'B-001']);
  });

  test('normalizes lifecycle labels and status tones', () => {
    expect(describeLifecycleState('planned')).toBe('Planned');
    expect(describeLifecycleState('stocked')).toBe('Stocked');
    expect(getStatusTone('active')).toBe('success');
    expect(getStatusTone('failed')).toBe('danger');
  });

  test('sorts batch events by the server timestamp', () => {
    const events = [
      { performed_at: '2026-09-21T12:00:00Z', event_type: 'STOCKING' },
      { performed_at: '2026-09-20T12:00:00Z', event_type: 'TASK' },
    ];
    expect(sortBatchEvents(events).map((item) => item.event_type)).toEqual(['TASK', 'STOCKING']);
  });
});
