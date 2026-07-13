import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { Link, router } from 'expo-router';
import { useAuth } from '../src/lib/auth-context';

export default function Login() {
  const { signIn, submitting, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit() {
    const ok = await signIn(email, password);
    if (ok) router.replace('/dashboard');
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="login-screen"
    >
      <Text style={styles.title}>Welcome back</Text>
      <Text style={styles.subtitle}>Sign in to your Agrovix AgOS account.</Text>

      <Field label="Email" value={email} onChange={setEmail} keyboardType="email-address" testID="login-email-input" />
      <Field label="Password" value={password} onChange={setPassword} secureTextEntry testID="login-password-input" />

      {error && (
        <Text style={styles.error} testID="login-error">
          {error}
        </Text>
      )}

      <Pressable
        disabled={submitting}
        testID="login-submit-button"
        style={[styles.primaryButton, submitting && { opacity: 0.6 }]}
        onPress={handleSubmit}
      >
        <Text style={styles.primaryButtonLabel}>{submitting ? 'Signing in…' : 'Sign in'}</Text>
      </Pressable>

      <Link href="/register" asChild>
        <Pressable testID="login-to-register-link">
          <Text style={styles.linkText}>New to Agrovix? Create an account</Text>
        </Pressable>
      </Link>
    </KeyboardAvoidingView>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testID: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
}

function Field({ label, value, onChange, testID, secureTextEntry, keyboardType = 'default' }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'sentences'}
        style={styles.input}
      />
    </View>
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
  error: { color: '#b23a1f', marginTop: 4, marginBottom: 8 },
});
