import { createContext, useContext, useRef, useState, ReactNode } from 'react';
import {
  ApiError,
  ApiFailure,
  ApiFailureMetadata,
  describeUnknownApiError,
  login,
  logout,
  register,
  resendVerification as requestVerificationEmail,
  RegisterPayload,
} from './api';

const EMAIL_UNVERIFIED_DETAIL = 'Please verify your email before signing in.';
const RESEND_SUCCESS_MESSAGE = 'If the account is eligible, a verification email has been sent.';

interface AuthContextValue {
  submitting: boolean;
  error: string | null;
  emailUnverified: boolean;
  resendPending: boolean;
  resendError: string | null;
  resendSuccess: string | null;
  signIn: (email: string, password: string) => Promise<boolean>;
  resendVerification: (email: string) => Promise<boolean>;
  clearVerificationState: () => void;
  register: (payload: RegisterPayload) => Promise<boolean>;
  signOut: () => Promise<void>;
}

export function isEmailUnverifiedError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 403 && error.detail === EMAIL_UNVERIFIED_DETAIL
  );
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_FAILURE_PHASES = new Set<ApiFailureMetadata['phase']>([
  'configuration',
  'network',
  'http',
  'parse',
  'application',
]);

function hasApiFailureMetadata(error: unknown): error is ApiFailureMetadata {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as Partial<ApiFailureMetadata>;
  return (
    API_FAILURE_PHASES.has(failure.phase as ApiFailureMetadata['phase']) &&
    typeof failure.apiBase === 'string' &&
    typeof failure.path === 'string' &&
    (failure.status === undefined || typeof failure.status === 'number') &&
    typeof failure.errorName === 'string' &&
    typeof failure.safeMessage === 'string'
  );
}

type DiagnosticMetadata = Omit<ApiFailureMetadata, 'phase'> & {
  phase: ApiFailureMetadata['phase'] | 'unclassified';
};

function diagnosticMessage(error: DiagnosticMetadata): string {
  return [
    `phase=${error.phase}`,
    `base=${error.apiBase}`,
    `path=${error.path}`,
    ...(error.status === undefined ? [] : [`status=${error.status}`]),
    `error=${error.errorName}`,
    `message=${error.safeMessage}`,
  ].join(' ');
}

function structuralDiagnosticMessage(error: ApiFailureMetadata): string {
  const candidate = new Error(error.safeMessage);
  candidate.name = error.errorName;
  const sanitized = describeUnknownApiError(candidate);
  const path = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,200}$/.test(error.path)
    ? error.path
    : '[unavailable]';
  return diagnosticMessage({
    phase: error.phase,
    apiBase: '[unavailable]',
    path,
    status: error.status,
    errorName: sanitized.errorName,
    safeMessage: sanitized.safeMessage,
  });
}

export function authErrorMessage(
  error: unknown,
  diagnosticsEnabled = process.env.EXPO_PUBLIC_API_DIAGNOSTICS === 'true',
  knownPath = '[unavailable]',
): string {
  if (!diagnosticsEnabled) {
    if (!(error instanceof ApiFailure)) return 'Unable to reach the API.';
    if (error instanceof ApiError) return error.detail;
    if (error.phase === 'configuration') return 'The API configuration is invalid.';
    if (error.phase === 'network') return 'Unable to reach the API.';
    return 'The API returned an invalid response.';
  }
  if (error instanceof ApiFailure) return diagnosticMessage(error);
  if (hasApiFailureMetadata(error)) return structuralDiagnosticMessage(error);
  const unknown = describeUnknownApiError(error);
  return diagnosticMessage({
    phase: 'unclassified',
    apiBase: '[unavailable]',
    path: knownPath,
    status: undefined,
    errorName: `Unclassified.${unknown.errorName}`,
    safeMessage: unknown.safeMessage,
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const signInPendingRef = useRef(false);
  const resendPendingRef = useRef(false);
  const eligibleVerificationEmailRef = useRef<string | null>(null);
  const resendRequestVersionRef = useRef(0);

  function clearVerificationState() {
    resendRequestVersionRef.current += 1;
    eligibleVerificationEmailRef.current = null;
    setEmailUnverified(false);
    setResendError(null);
    setResendSuccess(null);
  }

  async function run<T>(op: () => Promise<T>, knownPath?: string): Promise<T | null> {
    setSubmitting(true);
    setError(null);
    try {
      return await op();
    } catch (err) {
      setError(authErrorMessage(err, undefined, knownPath));
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  const value: AuthContextValue = {
    submitting,
    error,
    emailUnverified,
    resendPending,
    resendError,
    resendSuccess,
    signIn: async (email, password) => {
      if (signInPendingRef.current || resendPendingRef.current) return false;
      signInPendingRef.current = true;
      clearVerificationState();
      const verificationStateVersion = resendRequestVersionRef.current;
      setSubmitting(true);
      setError(null);
      try {
        await login(email, password);
        setEmailUnverified(false);
        return true;
      } catch (err) {
        const unverified = isEmailUnverifiedError(err);
        const verificationStateIsCurrent =
          resendRequestVersionRef.current === verificationStateVersion;
        eligibleVerificationEmailRef.current =
          unverified && verificationStateIsCurrent ? email.trim().toLowerCase() : null;
        setEmailUnverified(unverified && verificationStateIsCurrent);
        setError(authErrorMessage(err));
        return false;
      } finally {
        signInPendingRef.current = false;
        setSubmitting(false);
      }
    },
    resendVerification: async (email) => {
      const emailIdentity = email.trim().toLowerCase();
      if (
        resendPendingRef.current ||
        signInPendingRef.current ||
        eligibleVerificationEmailRef.current !== emailIdentity
      ) {
        return false;
      }
      resendPendingRef.current = true;
      const requestVersion = ++resendRequestVersionRef.current;
      setResendPending(true);
      setResendError(null);
      setResendSuccess(null);
      try {
        await requestVerificationEmail(email);
        if (
          resendRequestVersionRef.current === requestVersion &&
          eligibleVerificationEmailRef.current === emailIdentity
        ) {
          setResendSuccess(RESEND_SUCCESS_MESSAGE);
        }
        return true;
      } catch (err) {
        if (
          resendRequestVersionRef.current === requestVersion &&
          eligibleVerificationEmailRef.current === emailIdentity
        ) {
          setResendError(authErrorMessage(err, undefined, '/v1/auth/resend-verification'));
        }
        return false;
      } finally {
        resendPendingRef.current = false;
        setResendPending(false);
      }
    },
    clearVerificationState,
    register: async (payload) => (await run(() => register(payload), '/v1/auth/register')) !== null,
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
