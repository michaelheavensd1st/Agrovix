import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import {
  ApiError,
  ApiFailure,
  ApiFailureMetadata,
  CredentialStorageError,
  CurrentUser,
  describeUnknownApiError,
  getCurrentUser,
  login,
  LogoutError,
  logout,
  register,
  resendVerification as requestVerificationEmail,
  RegisterPayload,
  StaleAuthOperationError,
  usesNativeBearerAuth,
} from './api';
import {
  AuthOperation,
  AuthOperationOwner,
  beginAuthOperation,
  clearCredentialPair,
  ownsAuthOperation,
  readCredentialPair,
  SingleFlight,
} from './auth-operations';

const EMAIL_UNVERIFIED_DETAIL = 'Please verify your email before signing in.';
const RESEND_SUCCESS_MESSAGE = 'If the account is eligible, a verification email has been sent.';

export type SessionState =
  | { status: 'initializing' }
  | { status: 'authenticated'; user: CurrentUser }
  | { status: 'unauthenticated' }
  | { status: 'recoverable-error'; message: string };

interface AuthContextValue {
  session: SessionState;
  retrySessionBootstrap: () => Promise<void>;
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

function sessionErrorMessage(error: unknown): string {
  return authErrorMessage(error, undefined, '/v1/auth/me');
}

async function sessionAfterLoginFailure(error: unknown): Promise<SessionState> {
  if (error instanceof CredentialStorageError) {
    return { status: 'recoverable-error', message: sessionErrorMessage(error.failure) };
  }
  try {
    const existingPair = await readCredentialPair();
    return existingPair
      ? { status: 'recoverable-error', message: authErrorMessage(error) }
      : { status: 'unauthenticated' };
  } catch (storageError) {
    return { status: 'recoverable-error', message: sessionErrorMessage(storageError) };
  }
}

async function validateCurrentSession(
  operation: AuthOperation,
  expectedRefreshToken?: string,
): Promise<SessionState> {
  try {
    return { status: 'authenticated', user: await getCurrentUser(operation) };
  } catch (error) {
    if (error instanceof StaleAuthOperationError) {
      return { status: 'recoverable-error', message: sessionErrorMessage(error) };
    }
    if (!(error instanceof ApiError) || error.status !== 401) {
      return { status: 'recoverable-error', message: sessionErrorMessage(error) };
    }
    try {
      const cleared = await clearCredentialPair(operation, expectedRefreshToken);
      return cleared
        ? { status: 'unauthenticated' }
        : { status: 'recoverable-error', message: 'Authentication state changed. Please retry.' };
    } catch (clearError) {
      return { status: 'recoverable-error', message: sessionErrorMessage(clearError) };
    }
  }
}

export async function restoreStoredSession(
  operation: AuthOperation = beginAuthOperation(),
): Promise<SessionState> {
  try {
    if (!usesNativeBearerAuth()) return validateCurrentSession(operation);
    const pair = await readCredentialPair();
    if (!pair) return { status: 'unauthenticated' };
    return validateCurrentSession(operation, pair.refreshToken);
  } catch (error) {
    return { status: 'recoverable-error', message: sessionErrorMessage(error) };
  }
}

export async function establishLoginSession(
  email: string,
  password: string,
  operation: AuthOperation = beginAuthOperation(),
): Promise<SessionState> {
  try {
    const refreshToken = await login(email, password, operation);
    return validateCurrentSession(operation, refreshToken ?? undefined);
  } catch (error) {
    if (error instanceof CredentialStorageError) {
      return { status: 'recoverable-error', message: sessionErrorMessage(error.failure) };
    }
    throw error;
  }
}

export interface LogoutSessionResult {
  session: SessionState;
  failure?: unknown;
}

export async function endSession(
  operation: AuthOperation = beginAuthOperation(),
): Promise<LogoutSessionResult> {
  try {
    await logout(operation);
    return { session: { status: 'unauthenticated' } };
  } catch (error) {
    if (error instanceof LogoutError && error.localCredentialsCleared) {
      return { session: { status: 'unauthenticated' } };
    }
    const failure = error instanceof LogoutError ? error.failure : error;
    return {
      session: { status: 'recoverable-error', message: authErrorMessage(failure) },
      failure,
    };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'initializing' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const signInPendingRef = useRef(false);
  const resendPendingRef = useRef(false);
  const signOutFlightRef = useRef(new SingleFlight());
  const eligibleVerificationEmailRef = useRef<string | null>(null);
  const resendRequestVersionRef = useRef(0);
  const bootstrapPendingRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const operationOwnerRef = useRef<AuthOperationOwner | null>(null);
  if (!operationOwnerRef.current) operationOwnerRef.current = new AuthOperationOwner();

  const commitSession = useCallback((operation: AuthOperation, next: SessionState): boolean => {
    if (!mountedRef.current || !ownsAuthOperation(operation)) return false;
    setSession(next);
    return true;
  }, []);

  const commitUi = useCallback((operation: AuthOperation, update: () => void): boolean => {
    if (!mountedRef.current || !ownsAuthOperation(operation)) return false;
    update();
    return true;
  }, []);

  const retrySessionBootstrap = useCallback((): Promise<void> => {
    if (bootstrapPendingRef.current) return bootstrapPendingRef.current;
    const operation = operationOwnerRef.current!.begin();
    setSession({ status: 'initializing' });
    const pending = restoreStoredSession(operation)
      .then((next) => {
        commitSession(operation, next);
      })
      .finally(() => {
        if (bootstrapPendingRef.current === pending) bootstrapPendingRef.current = null;
      });
    bootstrapPendingRef.current = pending;
    return pending;
  }, [commitSession]);

  useEffect(() => {
    mountedRef.current = true;
    void retrySessionBootstrap();
    return () => {
      mountedRef.current = false;
      operationOwnerRef.current?.invalidate();
    };
  }, [retrySessionBootstrap]);

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
    session,
    retrySessionBootstrap,
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
      const operation = operationOwnerRef.current!.begin();
      try {
        const nextSession = await establishLoginSession(email, password, operation);
        if (!commitSession(operation, nextSession)) return false;
        if (nextSession.status !== 'authenticated') {
          commitUi(operation, () => {
            setError(
              nextSession.status === 'recoverable-error'
                ? nextSession.message
                : 'Could not validate credentials.',
            );
          });
          return false;
        }
        commitUi(operation, () => setEmailUnverified(false));
        return true;
      } catch (err) {
        const nextSession = await sessionAfterLoginFailure(err);
        if (!commitSession(operation, nextSession)) return false;
        const unverified = isEmailUnverifiedError(err);
        const verificationStateIsCurrent =
          resendRequestVersionRef.current === verificationStateVersion;
        commitUi(operation, () => {
          eligibleVerificationEmailRef.current =
            unverified && verificationStateIsCurrent ? email.trim().toLowerCase() : null;
          setEmailUnverified(unverified && verificationStateIsCurrent);
          setError(authErrorMessage(err));
        });
        return false;
      } finally {
        signInPendingRef.current = false;
        commitUi(operation, () => setSubmitting(false));
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
    signOut: () =>
      signOutFlightRef.current.run(async () => {
        const operation = operationOwnerRef.current!.begin();
        setSubmitting(true);
        setError(null);
        try {
          const result = await endSession(operation);
          commitSession(operation, result.session);
          if (result.failure !== undefined) {
            commitUi(operation, () => setError(authErrorMessage(result.failure)));
          }
        } finally {
          commitUi(operation, () => setSubmitting(false));
        }
      }),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
