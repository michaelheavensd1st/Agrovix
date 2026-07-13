import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

export function LoginScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="login-screen"
    >
      <Text style={styles.title}>Welcome back</Text>
      <Text style={styles.subtitle}>Sign in to your Agrovix AgOS account.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          testID="login-email-input"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          style={styles.input}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Password</Text>
        <TextInput
          testID="login-password-input"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          style={styles.input}
        />
      </View>

      <Pressable
        testID="login-submit-button"
        style={styles.primaryButton}
        onPress={() => navigation.replace('Dashboard')}
      >
        <Text style={styles.primaryButtonLabel}>Sign in</Text>
      </Pressable>

      <Pressable
        testID="login-to-register-link"
        onPress={() => navigation.navigate('Register')}
      >
        <Text style={styles.linkText}>New to Agrovix? Create an account</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#fbfaf5' },
  title: { fontSize: 28, fontWeight: '600', color: '#0f2e1e', marginTop: 16 },
  subtitle: { fontSize: 14, color: '#4a5c50', marginTop: 6, marginBottom: 24 },
  field: { marginBottom: 16 },
  label: { fontSize: 12, color: '#4a5c50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    borderWidth: 1,
    borderColor: '#d6d1c1',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
    color: '#0f2e1e',
  },
  primaryButton: {
    backgroundColor: '#0f2e1e',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonLabel: { color: '#f5f2e8', fontWeight: '600' },
  linkText: { color: '#0f2e1e', marginTop: 24, textAlign: 'center' },
});
