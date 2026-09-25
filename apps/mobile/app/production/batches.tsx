import React, { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ResourceListScreen, ResourceItem } from '../../src/components/production/resource-list';
import { listProductionBatches } from '../../src/lib/production-api';

export default function ProductionBatchesScreen() {
  const params = useLocalSearchParams<{
    organizationId?: string;
    organizationName?: string;
    farmId?: string;
    farmName?: string;
    siteId?: string;
    siteName?: string;
    unitId?: string;
    unitName?: string;
  }>();
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;
  const organizationName =
    typeof params.organizationName === 'string' ? params.organizationName : 'Organization';
  const farmId = typeof params.farmId === 'string' ? params.farmId : null;
  const farmName = typeof params.farmName === 'string' ? params.farmName : 'Farm';
  const siteId = typeof params.siteId === 'string' ? params.siteId : null;
  const siteName = typeof params.siteName === 'string' ? params.siteName : 'Site';
  const unitId = typeof params.unitId === 'string' ? params.unitId : null;
  const unitName = typeof params.unitName === 'string' ? params.unitName : 'Unit';

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!unitId) {
      setError('No unit is selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const batches = await listProductionBatches(unitId);
      setItems(
        batches.map((batch) => ({
          id: String(batch.id),
          label: String(batch.code),
          sublabel: String(batch.state),
          status: typeof batch.state === 'string' ? batch.state : undefined,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load production batches.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [unitId]);

  const resourceError = useMemo(
    () => (error ? 'Unable to load production batches for this unit. Please retry.' : null),
    [error],
  );

  return (
    <ResourceListScreen
      title="Production Batches"
      subtitle={`Unit: ${unitName}`}
      items={items}
      loading={loading}
      emptyText="No production batches are available for this unit."
      error={resourceError}
      onRetry={() => void load()}
      breadcrumb={[organizationName, farmName, siteName, unitName]}
      onSelect={(item) =>
        router.push({
          pathname: '/production/batches/[batchId]',
          params: {
            organizationId,
            organizationName,
            farmId,
            farmName,
            siteId,
            siteName,
            unitId,
            unitName,
            batchId: item.id,
            batchName: item.label,
          },
        })
      }
    />
  );
}
