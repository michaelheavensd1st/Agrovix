import { createContext, useContext, useState, ReactNode } from 'react';
import { ApiError, login, logout, register, RegisterPayload } from './api';

interface AuthContextValue {
  submitting: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<boolean>;
  register: (payload: RegisterPayload) => Promise<boolean>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(op: () => Promise<T>): Promise<T | null> {
    setSubmitting(true);
    setError(null);
    try {
      return await op();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Unable to reach the API.');
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  const value: AuthContextValue = {
    submitting,
    error,
    signIn: async (email, password) => (await run(() => login(email, password))) !== null,
    register: async (payload) => (await run(() => register(payload))) !== null,
    signOut: async () => {
      await run(() => logout());
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
