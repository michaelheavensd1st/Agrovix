import { View, Text, StyleSheet, ScrollView } from 'react-native';

export function DashboardScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container} testID="dashboard-screen">
      <Text style={styles.eyebrow}>Placeholder</Text>
      <Text style={styles.title}>Dashboard</Text>

      <View style={styles.card} testID="dashboard-empty-state">
        <Text style={styles.cardTitle}>Nothing here yet.</Text>
        <Text style={styles.cardBody}>
          Sprint 0 ships only the foundation. Farm dashboards, telemetry, and
          field operations will land in the next milestone.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fbfaf5', flexGrow: 1 },
  eyebrow: { color: '#4a5c50', textTransform: 'uppercase', letterSpacing: 2, fontSize: 11 },
  title: { fontSize: 28, fontWeight: '600', color: '#0f2e1e', marginTop: 4, marginBottom: 24 },
  card: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#d6d1c1',
    borderRadius: 16,
    padding: 24,
    backgroundColor: '#fff',
  },
  cardTitle: { fontSize: 18, fontWeight: '600', color: '#0f2e1e', textAlign: 'center' },
  cardBody: { fontSize: 14, color: '#4a5c50', textAlign: 'center', marginTop: 8 },
});
