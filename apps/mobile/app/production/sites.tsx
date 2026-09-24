import React, { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ResourceListScreen, ResourceItem } from '../../src/components/production/resource-list';
import { listProductionSites } from '../../src/lib/production-api';

export default function ProductionSitesScreen() {
  const params = useLocalSearchParams<{
    organizationId?: string;
    organizationName?: string;
    farmId?: string;
    farmName?: string;
  }>();
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;
  const organizationName =
    typeof params.organizationName === 'string' ? params.organizationName : 'Organization';
  const farmId = typeof params.farmId === 'string' ? params.farmId : null;
  const farmName = typeof params.farmName === 'string' ? params.farmName : 'Farm';

  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!farmId) {
      setError('No farm is selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const sites = await listProductionSites(farmId);
      setItems(
        sites.map((site) => ({
          id: String(site.id),
          label: String(site.name),
          sublabel: String(site.code),
          status: typeof site.status === 'string' ? site.status : undefined,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load sites.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [farmId]);

  const resourceError = useMemo(
    () => (error ? 'Unable to load production sites for this farm. Please retry.' : null),
    [error],
  );

  return (
    <ResourceListScreen
      title="Production Sites"
      subtitle={`Farm: ${farmName}`}
      items={items}
      loading={loading}
      emptyText="No production sites are available for this farm."
      error={resourceError}
      onRetry={() => void load()}
      breadcrumb={[organizationName, farmName]}
      onSelect={(item) =>
        router.push({
          pathname: '/production/units',
          params: {
            organizationId,
            organizationName,
            farmId,
            farmName,
            siteId: item.id,
            siteName: item.label,
          },
        })
      }
    />
  );
}
