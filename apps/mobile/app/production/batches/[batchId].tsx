import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
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
  const [batch, setBatch] = useState<any>(null);
  const [projections, setProjections] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
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
        setProjections(Array.isArray(projectionData) ? projectionData : []);
        setEvents(Array.isArray(eventData) ? eventData : []);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to load batch details.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [batchId]);

  const summary = useMemo(() => {
    if (!batch) return [];
    return [
      { label: 'Batch', value: batch.code ?? batchName },
      { label: 'State', value: batch.state ?? 'unknown' },
      { label: 'Unit', value: batch.unit_name ?? '—' },
      { label: 'Farm', value: batch.farm_name ?? '—' },
      { label: 'Timezone', value: batch.timezone || '—' },
    ];
  }, [batch, batchName]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>Production</Text>
      <Text style={styles.title}>{batchName}</Text>
      {loading ? (
        <Text style={styles.meta}>Loading batch details…</Text>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <>
          <View style={styles.card}>
            {summary.map((row) => (
              <View key={row.label} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowValue}>{row.value}</Text>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Projections</Text>
            {projections.length === 0 ? (
              <Text style={styles.meta}>No projections available.</Text>
            ) : (
              projections.map((projection, index) => (
                <View key={`${projection.id ?? 'projection'}-${index}`} style={styles.listItem}>
                  <Text style={styles.listItemTitle}>{projection.name ?? 'Projection'}</Text>
                  <Text style={styles.listItemMeta}>
                    {projection.period ?? '—'} • {projection.value ?? '—'}
                  </Text>
                </View>
              ))
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Events</Text>
            {events.length === 0 ? (
              <Text style={styles.meta}>No events for this batch.</Text>
            ) : (
              events.map((event, index) => (
                <View key={`${event.id ?? 'event'}-${index}`} style={styles.listItem}>
                  <Text style={styles.listItemTitle}>{event.type ?? 'Event'}</Text>
                  <Text style={styles.listItemMeta}>{event.description ?? '—'}</Text>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fbfaf5' },
  content: { padding: 24 },
  eyebrow: { color: '#4a5c50', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '600', color: '#0f2e1e', marginTop: 4 },
  meta: { color: '#4a5c50', marginTop: 12 },
  error: { color: '#8b1d1d', marginTop: 12, fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d6d1c1',
    marginTop: 20,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#efe9db',
  },
  rowLabel: { color: '#4a5c50', fontSize: 14 },
  rowValue: { color: '#0f2e1e', fontWeight: '600', maxWidth: '60%' },
  section: { marginTop: 28 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#0f2e1e', marginBottom: 12 },
  listItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d6d1c1',
    padding: 14,
    marginBottom: 10,
  },
  listItemTitle: { color: '#0f2e1e', fontWeight: '600' },
  listItemMeta: { marginTop: 4, color: '#4a5c50' },
});
