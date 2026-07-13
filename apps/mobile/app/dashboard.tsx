import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../src/lib/auth-context';

export default function Dashboard() {
  const { signOut } = useAuth();

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  return (
    <ScrollView contentContainerStyle={styles.container} testID="dashboard-screen">
      <Text style={styles.eyebrow}>Sprint 1</Text>
      <Text style={styles.title}>Dashboard</Text>

      <View style={styles.card} testID="dashboard-empty-state">
        <Text style={styles.cardTitle}>Shell only</Text>
        <Text style={styles.cardBody}>
          Mobile remains a shell during Sprint 1. Full aquaculture-first
          workflows land in Sprint 2.
        </Text>
      </View>

      <Pressable testID="dashboard-signout-button" style={styles.signOutButton} onPress={handleSignOut}>
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
