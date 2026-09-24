import React, { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { ResourceListScreen, ResourceItem } from '../../src/components/production/resource-list';
import { listOrganizations } from '../../src/lib/production-api';

export default function ProductionOrganizationsScreen() {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const orgs = await listOrganizations();
      setItems(
        orgs.map((org) => ({
          id: String(org.id),
          label: org.name,
          sublabel: org.slug,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load organizations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resourceError = useMemo(
    () => (error ? 'Unable to load organizations. Please retry.' : null),
    [error],
  );

  return (
    <ResourceListScreen
      title="Organizations"
      subtitle="Choose the operating organization for the read-only production journey."
      items={items}
      loading={loading}
      emptyText="No organizations are available for this account."
      error={resourceError}
      onRetry={() => void load()}
      onSelect={(item) =>
        router.push({
          pathname: '/production/farms',
          params: { organizationId: item.id, organizationName: item.label },
        })
      }
    />
  );
}
