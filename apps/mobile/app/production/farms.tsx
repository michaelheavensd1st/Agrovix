import React, { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ResourceListScreen, ResourceItem } from '../../src/components/production/resource-list';
import { listFarms } from '../../src/lib/production-api';

export default function ProductionFarmsScreen() {
  const params = useLocalSearchParams<{ organizationId?: string; organizationName?: string }>();
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : null;
  const organizationName =
    typeof params.organizationName === 'string' ? params.organizationName : 'Organization';
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!organizationId) {
      setError('No organization is selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const farms = await listFarms(organizationId);
      setItems(
        farms.map((farm) => ({
          id: String(farm.id),
          label: String(farm.name),
          sublabel: String(farm.code),
          status:
            typeof farm.is_active === 'boolean'
              ? farm.is_active
                ? 'active'
                : 'closed'
              : undefined,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load farms.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [organizationId]);

  const resourceError = useMemo(
    () => (error ? 'Unable to load farms for this organization. Please retry.' : null),
    [error],
  );

  return (
    <ResourceListScreen
      title="Farms"
      subtitle={`Organization: ${organizationName}`}
      items={items}
      loading={loading}
      emptyText="No farms are available for this organization."
      error={resourceError}
      onRetry={() => void load()}
      breadcrumb={[organizationName]}
      onSelect={(item) =>
        router.push({
          pathname: '/production/sites',
          params: {
            organizationId,
            organizationName,
            farmId: item.id,
            farmName: item.label,
          },
        })
      }
    />
  );
}
