import React, { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ResourceListScreen, ResourceItem } from '../../src/components/production/resource-list';
import { listProductionUnits } from '../../src/lib/production-api';

export default function ProductionUnitsScreen() {
  const params = useLocalSearchParams<{
    organizationId?: string;
    organizationName?: string;
    farmId?: string;
    farmName?: string;
    siteId?: string;
    siteName?: string;
  }>();
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;
  const organizationName =
    typeof params.organizationName === 'string' ? params.organizationName : 'Organization';
  const farmId = typeof params.farmId === 'string' ? params.farmId : null;
  const farmName = typeof params.farmName === 'string' ? params.farmName : 'Farm';
  const siteId = typeof params.siteId === 'string' ? params.siteId : null;
  const siteName = typeof params.siteName === 'string' ? params.siteName : 'Site';

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!siteId) {
      setError('No site is selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const units = await listProductionUnits(siteId);
      setItems(
        units.map((unit) => ({
          id: String(unit.id),
          label: String(unit.name),
          sublabel: String(unit.code),
          status: typeof unit.status === 'string' ? unit.status : undefined,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load production units.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [siteId]);

  const resourceError = useMemo(
    () => (error ? 'Unable to load production units for this site. Please retry.' : null),
    [error],
  );

  return (
    <ResourceListScreen
      title="Production Units"
      subtitle={`Site: ${siteName}`}
      items={items}
      loading={loading}
      emptyText="No production units are available for this site."
      error={resourceError}
      onRetry={() => void load()}
      breadcrumb={[organizationName, farmName, siteName]}
      onSelect={(item) =>
        router.push({
          pathname: '/production/batches',
          params: {
            organizationId,
            organizationName,
            farmId,
            farmName,
            siteId,
            siteName,
            unitId: item.id,
            unitName: item.label,
          },
        })
      }
    />
  );
}
