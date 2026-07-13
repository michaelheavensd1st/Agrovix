import { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'>;

export function SplashScreen({ navigation }: Props) {
  useEffect(() => {
    const t = setTimeout(() => navigation.replace('Login'), 1200);
    return () => clearTimeout(t);
  }, [navigation]);

  return (
    <View style={styles.container} testID="splash-screen">
      <Text style={styles.brand}>Agrovix</Text>
      <Text style={styles.tagline}>AgOS</Text>
      <ActivityIndicator style={styles.spinner} color="#c9dfae" />
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
});
