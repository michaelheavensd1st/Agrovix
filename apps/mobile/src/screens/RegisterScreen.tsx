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

type Props = NativeStackScreenProps<RootStackParamList, 'Register'>;

export function RegisterScreen({ navigation }: Props) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="register-screen"
    >
      <Text style={styles.title}>Create your account</Text>
      <Text style={styles.subtitle}>
        Get started with Agrovix AgOS in seconds.
      </Text>

      <Field label="Full name" testID="register-fullname-input" value={fullName} onChange={setFullName} />
      <Field
        label="Email"
        testID="register-email-input"
        value={email}
        onChange={setEmail}
        keyboardType="email-address"
      />
      <Field
        label="Password"
        testID="register-password-input"
        value={password}
        onChange={setPassword}
        secureTextEntry
      />

      <Pressable
        testID="register-submit-button"
        style={styles.primaryButton}
        onPress={() => navigation.replace('Dashboard')}
      >
        <Text style={styles.primaryButtonLabel}>Create account</Text>
      </Pressable>

      <Pressable
        testID="register-to-login-link"
        onPress={() => navigation.navigate('Login')}
      >
        <Text style={styles.linkText}>Already have an account? Sign in</Text>
      </Pressable>
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

function Field(props: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChange}
        secureTextEntry={props.secureTextEntry}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.keyboardType === 'email-address' ? 'none' : 'sentences'}
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
});
