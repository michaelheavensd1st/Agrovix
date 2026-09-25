import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export default function ProductionHomeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>Production</Text>
      <Text style={styles.title}>Operations overview</Text>
      <Text style={styles.subtitle}>
        Read-only production foundation across organization, farm, site, unit, and batch hierarchy.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Start with your scope</Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push('/production/organizations')}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Open production scope</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: '#fbfaf5', padding: 24 },
  eyebrow: { color: '#4a5c50', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '600', color: '#0f2e1e', marginTop: 4 },
  subtitle: { color: '#4a5c50', marginTop: 8, marginBottom: 24 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 20,
  },
  cardTitle: { color: '#0f2e1e', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  primaryButton: {
    backgroundColor: '#0f2e1e',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#f5f2e8', fontWeight: '700' },
});
