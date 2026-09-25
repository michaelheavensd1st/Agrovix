import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../src/lib/auth-context';

export default function Dashboard() {
  const { error, signOut, submitting } = useAuth();

  async function handleSignOut() {
    await signOut();
  }

  return (
    <ScrollView contentContainerStyle={styles.container} testID="dashboard-screen">
      <Text style={styles.eyebrow}>Production</Text>
      <Text style={styles.title}>Dashboard</Text>

      <View style={styles.card} testID="dashboard-empty-state">
        <Text style={styles.cardTitle}>Production foundation</Text>
        <Text style={styles.cardBody}>
          Read-only production navigation is now available from organization to batch detail.
        </Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => router.push('/production')}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>Open production scope</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={styles.error} testID="dashboard-auth-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        disabled={submitting}
        testID="dashboard-signout-button"
        style={[styles.signOutButton, submitting && { opacity: 0.6 }]}
        onPress={handleSignOut}
      >
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
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
  primaryButton: {
    marginTop: 20,
    borderRadius: 10,
    backgroundColor: '#0f2e1e',
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#f5f2e8', fontWeight: '700' },
  error: { color: '#b23a1f', marginTop: 16, textAlign: 'center' },
  signOutButton: {
    marginTop: 32,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#0f2e1e',
    alignItems: 'center',
  },
  signOutLabel: { color: '#0f2e1e', fontWeight: '600' },
});
