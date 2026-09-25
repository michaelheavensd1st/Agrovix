import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  describeLifecycleState,
  getStatusTone,
  sortBatchEvents,
} from '../../features/production/production-state';

export interface BatchDetailData {
  batch: Record<string, unknown>;
  projection: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
}

export function BatchDetailPanel({ batch, projection, events }: BatchDetailData) {
  const state = typeof batch.state === 'string' ? batch.state : 'unknown';
  const tone = getStatusTone(state);
  const toneStyle =
    tone === 'success'
      ? styles.badgeSuccess
      : tone === 'warning'
        ? styles.badgeWarning
        : tone === 'danger'
          ? styles.badgeDanger
          : styles.badgeNeutral;

  const sortedEvents = sortBatchEvents(
    events.map((event) => ({
      ...event,
      performed_at: typeof event.performed_at === 'string' ? event.performed_at : null,
      event_type: typeof event.event_type === 'string' ? event.event_type : 'UNKNOWN',
    })),
  );

  return (
    <ScrollView contentContainerStyle={styles.shell}>
      <View style={styles.summaryCard}>
        <Text style={styles.kicker}>Batch</Text>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{String(batch.code ?? 'Batch')}</Text>
          <View style={[styles.badge, toneStyle]}>
            <Text style={styles.badgeText}>{describeLifecycleState(state)}</Text>
          </View>
        </View>
        <Text style={styles.meta}>Species: {String(batch.species ?? 'Unknown')}</Text>
        <Text style={styles.meta}>Farm: {String(batch.farm_name ?? '-')}</Text>
        <Text style={styles.meta}>Unit: {String(batch.unit_name ?? batch.unit_id ?? '-')}</Text>
      </View>

      {projection ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Projection</Text>
          <Text style={styles.meta}>
            Initial stocked: {String(projection.initial_stocked_quantity ?? '-')}
          </Text>
          <Text style={styles.meta}>
            Estimated remaining: {String(projection.estimated_remaining_population ?? '-')}
          </Text>
          <Text style={styles.meta}>Survival rate: {String(projection.survival_rate ?? '-')}</Text>
          <Text style={styles.meta}>Computed at: {String(projection.computed_at ?? '-')}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Projection</Text>
          <Text style={styles.meta}>No projection is available for this batch.</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Timeline</Text>
        {sortedEvents.length === 0 ? (
          <Text style={styles.meta}>No batch events recorded.</Text>
        ) : (
          sortedEvents.map((event, index) => (
            <View
              key={`${String(event.event_type ?? 'event')}-${String(event.performed_at ?? index)}`}
              style={styles.timelineRow}
            >
              <Text style={styles.timelineTitle}>{String(event.event_type ?? 'Unknown')}</Text>
              <Text style={styles.meta}>{String(event.performed_at ?? 'unknown timestamp')}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  shell: { flexGrow: 1, backgroundColor: '#fbfaf5', padding: 24 },
  summaryCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 20,
  },
  kicker: { color: '#4a5c50', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
  },
  title: { color: '#0f2e1e', fontSize: 28, fontWeight: '600', flex: 1 },
  meta: { color: '#4a5c50', fontSize: 14, marginTop: 8 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 20,
    marginTop: 16,
  },
  cardTitle: { color: '#0f2e1e', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, marginLeft: 12 },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#0f2e1e', textTransform: 'uppercase' },
  badgeNeutral: { backgroundColor: '#ece7dc' },
  badgeSuccess: { backgroundColor: '#dfeecf' },
  badgeWarning: { backgroundColor: '#f7ebbf' },
  badgeDanger: { backgroundColor: '#f4d0c7' },
  timelineRow: { borderTopWidth: 1, borderTopColor: '#efe9dd', paddingTop: 10, marginTop: 10 },
  timelineTitle: { fontSize: 14, fontWeight: '600', color: '#0f2e1e' },
});
