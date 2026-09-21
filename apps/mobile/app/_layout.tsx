import { useEffect, useRef } from 'react';
import { router, Stack, useSegments } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/lib/auth-context';
import { routeForSession, shouldHoldSessionRoute } from '../src/lib/session-routing';

function SessionStack() {
  const { retrySessionBootstrap, session } = useAuth();
  const segments = useSegments();
  const lastRedirectRef = useRef<string | null>(null);
  const route = segments[0];

  useEffect(() => {
    const destination = routeForSession(session.status, route);
    if (!destination) {
      lastRedirectRef.current = null;
      return;
    }
    const redirectKey = `${route}:${session.status}:${destination}`;
    if (lastRedirectRef.current === redirectKey) return;
    lastRedirectRef.current = redirectKey;
    router.replace(destination);
  }, [route, session.status]);

  if (shouldHoldSessionRoute(session.status, route)) {
    return (
      <View style={styles.sessionBoundary} testID="session-route-boundary">
        {session.status === 'recoverable-error' ? (
          <>
            <Text style={styles.sessionError}>{session.message}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void retrySessionBootstrap()}
              style={styles.retryButton}
              testID="session-boundary-retry-button"
            >
              <Text style={styles.retryLabel}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color="#0f2e1e" />
        )}
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f2e1e' },
        headerTintColor: '#f5f2e8',
        contentStyle: { backgroundColor: '#fbfaf5' },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: 'Sign in' }} />
      <Stack.Screen name="register" options={{ title: 'Create account' }} />
      <Stack.Screen name="dashboard" options={{ title: 'AgOS' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  sessionBoundary: {
    alignItems: 'center',
    backgroundColor: '#fbfaf5',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  sessionError: { color: '#4a5c50', textAlign: 'center' },
  retryButton: {
    borderColor: '#0f2e1e',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 18,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryLabel: { color: '#0f2e1e', fontWeight: '600' },
});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <SessionStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
