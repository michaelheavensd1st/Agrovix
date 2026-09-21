import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../src/lib/auth-context';
import { startupDestination } from '../src/lib/session-routing';

export default function Splash() {
  const { session, retrySessionBootstrap } = useAuth();
  const lastRedirectRef = useRef<string | null>(null);

  useEffect(() => {
    const destination = startupDestination(session.status);
    if (!destination) {
      lastRedirectRef.current = null;
      return;
    }
    const redirectKey = `${session.status}:${destination}`;
    if (lastRedirectRef.current === redirectKey) return;
    lastRedirectRef.current = redirectKey;
    router.replace(destination);
  }, [session.status]);

  return (
    <View style={styles.container} testID="splash-screen">
      <Text style={styles.brand}>Agrovix</Text>
      <Text style={styles.tagline}>AgOS</Text>
      {session.status === 'recoverable-error' ? (
        <View style={styles.recovery} testID="session-recovery">
          <Text style={styles.recoveryText}>{session.message}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void retrySessionBootstrap()}
            style={styles.retryButton}
            testID="session-retry-button"
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ActivityIndicator style={styles.spinner} color="#c9dfae" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f2e1e',
    padding: 24,
  },
  brand: { color: '#f5f2e8', fontSize: 40, fontWeight: '600', letterSpacing: 1 },
  tagline: { color: '#c9dfae', marginTop: 4, fontSize: 18, letterSpacing: 4 },
  spinner: { marginTop: 32 },
  recovery: { marginTop: 28, alignItems: 'center', width: '100%' },
  recoveryText: { color: '#f5f2e8', textAlign: 'center' },
  retryButton: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: '#c9dfae',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryLabel: { color: '#c9dfae', fontWeight: '600' },
});
