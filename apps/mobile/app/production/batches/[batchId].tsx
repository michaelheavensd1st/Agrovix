import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { BatchDetailPanel } from '../../../src/components/production/batch-detail';
import {
  getProductionBatch,
  getBatchProjections,
  listBatchEvents,
} from '../../../src/lib/production-api';

export default function ProductionBatchDetailScreen() {
  const params = useLocalSearchParams<{
    organizationId?: string;
    organizationName?: string;
    farmId?: string;
    farmName?: string;
    siteId?: string;
    siteName?: string;
    unitId?: string;
    unitName?: string;
    batchId?: string;
    batchName?: string;
  }>();

  const batchId = typeof params.batchId === 'string' ? params.batchId : null;
  const batchName = typeof params.batchName === 'string' ? params.batchName : 'Batch';
  const farmName = typeof params.farmName === 'string' ? params.farmName : null;
  const unitName = typeof params.unitName === 'string' ? params.unitName : null;
  const [batch, setBatch] = useState<Record<string, unknown> | null>(null);
  const [projection, setProjection] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!batchId) {
        setError('No batch selected.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [batchData, projectionData, eventData] = await Promise.all([
          getProductionBatch(batchId),
          getBatchProjections(batchId),
          listBatchEvents(batchId),
        ]);
        setBatch(batchData);
        setProjection(projectionData && typeof projectionData === 'object' ? projectionData : null);
        setEvents(Array.isArray(eventData.items) ? eventData.items : []);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to load batch details.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [batchId]);

  const detailBatch = useMemo(() => {
    if (!batch) return null;
    return {
      ...batch,
      ...(farmName ? { farm_name: farmName } : {}),
      ...(unitName ? { unit_name: unitName } : {}),
    };
  }, [batch, farmName, unitName]);

  if (loading) {
    return <View />;
  }

  if (error) {
    return (
      <BatchDetailPanel
        batch={{ code: batchName, state: 'unknown' }}
        projection={null}
        events={[]}
      />
    );
  }

  return (
    <BatchDetailPanel
      batch={
        detailBatch ?? {
          code: batchName,
          state: 'unknown',
          ...(farmName ? { farm_name: farmName } : {}),
          ...(unitName ? { unit_name: unitName } : {}),
        }
      }
      projection={projection}
      events={events}
      waterQualityContext={
        batchId
          ? {
              batchId,
              batchName,
              farmName: farmName ?? undefined,
              unitName: unitName ?? undefined,
            }
          : undefined
      }
    />
  );
}
