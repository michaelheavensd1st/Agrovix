import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { describeLifecycleState, getStatusTone } from '../../features/production/production-state';

export interface ResourceItem {
  id: string;
  label: string;
  sublabel?: string;
  status?: string | null;
}

interface ResourceListProps {
  title: string;
  subtitle?: string;
  items: ResourceItem[];
  loading: boolean;
  emptyText: string;
  error: string | null;
  onRetry?: () => void;
  onSelect: (item: ResourceItem) => void;
  breadcrumb?: string[];
}

export function ResourceListScreen({
  title,
  subtitle,
  items,
  loading,
  emptyText,
  error,
  onRetry,
  onSelect,
  breadcrumb,
}: ResourceListProps) {
  const crumbs = breadcrumb ?? [];

  if (loading) {
    return (
      <View style={styles.shell}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle ?? 'Loading production data…'}</Text>
        <View style={styles.loadingCard}>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.shell}>
      {crumbs.length > 0 ? (
        <View style={styles.breadcrumbRow}>
          {crumbs.map((crumb, index) => (
            <Text key={`${crumb}-${index}`} style={styles.breadcrumb}>
              {crumb}
              {index < crumbs.length - 1 ? ' / ' : ''}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          {onRetry ? (
            <Pressable onPress={onRetry} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {!error && items.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>{emptyText}</Text>
        </View>
      ) : null}

      {!error && items.length > 0
        ? items.map((item) => {
            const tone = getStatusTone(item.status);
            const toneStyle =
              tone === 'success'
                ? styles.badgeSuccess
                : tone === 'warning'
                  ? styles.badgeWarning
                  : tone === 'danger'
                    ? styles.badgeDanger
                    : styles.badgeNeutral;

            return (
              <Pressable
                key={item.id}
                style={styles.card}
                onPress={() => onSelect(item)}
                accessibilityRole="button"
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.label}</Text>
                  {item.status ? (
                    <View style={[styles.badge, toneStyle]}>
                      <Text style={styles.badgeText}>{describeLifecycleState(item.status)}</Text>
                    </View>
                  ) : null}
                </View>
                {item.sublabel ? <Text style={styles.cardMeta}>{item.sublabel}</Text> : null}
              </Pressable>
            );
          })
        : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexGrow: 1,
    backgroundColor: '#fbfaf5',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 32,
  },
  breadcrumbRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  breadcrumb: { color: '#4a5c50', fontSize: 12, letterSpacing: 0.4 },
  title: { fontSize: 28, fontWeight: '600', color: '#0f2e1e', marginBottom: 4 },
  subtitle: { color: '#4a5c50', fontSize: 14, marginBottom: 20 },
  loadingCard: {
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 20,
    backgroundColor: '#fff',
  },
  loadingText: { color: '#0f2e1e', fontWeight: '600' },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: '#0f2e1e', fontSize: 18, fontWeight: '600', flex: 1 },
  cardMeta: { color: '#4a5c50', marginTop: 8, fontSize: 13 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, marginLeft: 12 },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#0f2e1e', textTransform: 'uppercase' },
  badgeNeutral: { backgroundColor: '#ece7dc' },
  badgeSuccess: { backgroundColor: '#dfeecf' },
  badgeWarning: { backgroundColor: '#f7ebbf' },
  badgeDanger: { backgroundColor: '#f4d0c7' },
  errorCard: {
    backgroundColor: '#f9ebe8',
    borderColor: '#d98d79',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginTop: 12,
  },
  errorText: { color: '#7d2e21', fontWeight: '600' },
  retryButton: {
    marginTop: 12,
    borderRadius: 10,
    paddingVertical: 10,
    backgroundColor: '#0f2e1e',
    alignItems: 'center',
  },
  retryText: { color: '#f5f2e8', fontWeight: '700' },
  emptyCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 20,
    marginTop: 12,
  },
  emptyText: { color: '#4a5c50', textAlign: 'center' },
});
