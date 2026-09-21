import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  AuthOperation,
  beginAuthOperation,
  clearCredentialPair,
  currentAuthOperation,
  ownsAuthOperation,
  readCredentialPair,
  replaceCredentialPair,
} from './auth-operations';
import { getAccessToken } from './secure-storage';

export function resolveApiUrl(publicUrl?: string, configuredUrl?: string): string {
  return publicUrl || configuredUrl || 'http://localhost:8000/api';
}

const CONFIGURED_API_URL = resolveApiUrl(
  process.env.EXPO_PUBLIC_API_URL,
  Constants.expoConfig?.extra?.apiUrl as string | undefined,
);
const NATIVE_AUTH_HEADERS = { 'X-Agrovix-Auth-Transport': 'bearer' } as const;
const refreshFlights = new Map<number, Promise<void>>();

export function usesNativeBearerAuth(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

export interface RegisterPayload {
  email: string;
  password: string;
  full_name: string | null;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
}

export interface PermissionScope {
  organization_id: string | null;
  farm_id: string | null;
  permissions: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_verified: boolean;
  is_superuser: boolean;
  created_at: string;
  updated_at: string;
  permissions: string[];
  permission_scopes: PermissionScope[];
}

function isTokenPair(body: unknown): body is TokenPair {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const candidate = body as Partial<Record<keyof TokenPair, unknown>>;
  return (
    typeof candidate.access_token === 'string' &&
    candidate.access_token.trim().length > 0 &&
    typeof candidate.refresh_token === 'string' &&
    candidate.refresh_token.trim().length > 0 &&
    candidate.token_type === 'bearer' &&
    typeof candidate.expires_in === 'number' &&
    Number.isFinite(candidate.expires_in) &&
    candidate.expires_in > 0
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPermissionScope(body: unknown): body is PermissionScope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const candidate = body as Partial<Record<keyof PermissionScope, unknown>>;
  return (
    (candidate.organization_id === null || isUuid(candidate.organization_id)) &&
    (candidate.farm_id === null || isUuid(candidate.farm_id)) &&
    isStringArray(candidate.permissions)
  );
}

function isCurrentUser(body: unknown): body is CurrentUser {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const candidate = body as Partial<Record<keyof CurrentUser, unknown>>;
  return (
    isUuid(candidate.id) &&
    typeof candidate.email === 'string' &&
    EMAIL_PATTERN.test(candidate.email) &&
    (candidate.full_name === null || typeof candidate.full_name === 'string') &&
    typeof candidate.is_active === 'boolean' &&
    typeof candidate.is_verified === 'boolean' &&
    typeof candidate.is_superuser === 'boolean' &&
    isDateTime(candidate.created_at) &&
    isDateTime(candidate.updated_at) &&
    isStringArray(candidate.permissions) &&
    Array.isArray(candidate.permission_scopes) &&
    candidate.permission_scopes.every(isPermissionScope)
  );
}

interface MessageResponse {
  message: string;
}

export type ApiFailurePhase = 'configuration' | 'network' | 'http' | 'parse' | 'application';

export interface ApiFailureMetadata {
  phase: ApiFailurePhase;
  apiBase: string;
  path: string;
  status?: number;
  errorName: string;
  safeMessage: string;
}

export class ApiFailure extends Error implements ApiFailureMetadata {
  constructor(
    public readonly phase: ApiFailurePhase,
    public readonly apiBase: string,
    public readonly path: string,
    public readonly status: number | undefined,
    public readonly errorName: string,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = errorName;
  }
}

export class ApiError extends ApiFailure {
  constructor(
    status: number,
    public readonly detail: string,
    apiBase = '[unavailable]',
    path = '[unavailable]',
  ) {
    super('http', apiBase, path, status, 'ApiError', detail);
  }
}

export class CredentialStorageError extends Error {
  constructor(public readonly failure: unknown) {
    super('Credentials could not be stored securely.');
    this.name = 'CredentialStorageError';
  }
}

export class StaleAuthOperationError extends Error {
  constructor() {
    super('Authentication operation was superseded.');
    this.name = 'StaleAuthOperationError';
  }
}

interface ApiLocation {
  base: string;
  diagnosticPath: string;
  requestUrl: string;
}

interface RequestContract<T> {
  expectedStatus?: number;
  validate?: (body: unknown) => body is T;
}

const REDACTED = '[redacted]';

function sanitizeMessage(message: string, fallback: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return fallback;
  return compact
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(access_token|refresh_token|password|authorization|cookie)\b\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 200);
}

function errorName(error: unknown): string {
  if (!(error instanceof Error) || !error.name) return 'Error';
  const name = error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  return name || 'Error';
}

export function describeUnknownApiError(
  error: unknown,
): Pick<ApiFailureMetadata, 'errorName' | 'safeMessage'> {
  const namedError = new Error();
  namedError.name = sanitizeMessage(error instanceof Error ? error.name : '', 'Error');
  return {
    errorName: errorName(namedError),
    safeMessage: sanitizeMessage(
      error instanceof Error ? error.message : '',
      'An unclassified error occurred.',
    ),
  };
}

function diagnosticPath(path: string): string {
  const withoutQueryOrFragment = path.split(/[?#]/, 1)[0];
  return sanitizeMessage(withoutQueryOrFragment, '[unavailable]');
}

function resolveApiLocation(path: string): ApiLocation {
  const safePath = diagnosticPath(path);
  let parsed: URL;
  try {
    parsed = new URL(CONFIGURED_API_URL);
  } catch {
    throw new ApiFailure(
      'configuration',
      '[invalid]',
      safePath,
      undefined,
      'ApiConfigurationError',
      'The API base URL is invalid.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiFailure(
      'configuration',
      '[invalid]',
      safePath,
      undefined,
      'ApiConfigurationError',
      'The API base URL contains unsupported components.',
    );
  }
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ApiFailure(
      'configuration',
      base,
      safePath,
      undefined,
      'ApiConfigurationError',
      'The API base URL contains unsupported components.',
    );
  }
  return { base, diagnosticPath: safePath, requestUrl: `${base}${path}` };
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
  return (
    mediaType === 'application/json' || Boolean(mediaType?.match(/^application\/[^/]+\+json$/))
  );
}

function normalizeApiDetail(body: unknown): string {
  if (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { detail?: unknown }).detail === 'string'
  ) {
    return sanitizeMessage((body as { detail: string }).detail, 'Request failed');
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { detail?: unknown }).detail !== undefined
  ) {
    return 'Request validation failed.';
  }
  return 'Request failed';
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  auth = false,
  mayRefresh = true,
  contract: RequestContract<T> = {},
  operation: AuthOperation = currentAuthOperation(),
): Promise<T> {
  const location = resolveApiLocation(path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth && usesNativeBearerAuth()) {
    if (!ownsAuthOperation(operation)) throw new StaleAuthOperationError();
    const token = await getAccessToken();
    if (!ownsAuthOperation(operation)) throw new StaleAuthOperationError();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(location.requestUrl, {
      ...init,
      ...(Platform.OS === 'web' ? { credentials: 'include' as const } : {}),
      headers,
    });
  } catch (error) {
    throw new ApiFailure(
      'network',
      location.base,
      location.diagnosticPath,
      undefined,
      errorName(error),
      sanitizeMessage(error instanceof Error ? error.message : '', 'Network request failed'),
    );
  }
  const status = res.status;
  if (res.status === 401 && auth && mayRefresh && usesNativeBearerAuth()) {
    await refreshTokens(operation);
    return request<T>(path, init, true, false, contract, operation);
  }
  const isJson = isJsonContentType(res.headers.get('content-type'));
  let responseText: string;
  try {
    responseText = await res.text();
  } catch (error) {
    throw new ApiFailure(
      'parse',
      location.base,
      location.diagnosticPath,
      status,
      errorName(error),
      'Unable to read the API response.',
    );
  }
  let body: unknown;
  if (isJson) {
    try {
      body = JSON.parse(responseText);
    } catch (error) {
      throw new ApiFailure(
        'parse',
        location.base,
        location.diagnosticPath,
        status,
        errorName(error),
        'The API response was not valid JSON.',
      );
    }
  }
  if (!res.ok) {
    throw new ApiError(status, normalizeApiDetail(body), location.base, location.diagnosticPath);
  }
  if (contract.expectedStatus !== undefined && status !== contract.expectedStatus) {
    throw new ApiFailure(
      'application',
      location.base,
      location.diagnosticPath,
      status,
      'ApiContractError',
      `The API returned unexpected status ${status}.`,
    );
  }
  if (contract.validate && !contract.validate(body)) {
    throw new ApiFailure(
      'application',
      location.base,
      location.diagnosticPath,
      status,
      'ApiContractError',
      'The API response did not match the expected contract.',
    );
  }
  return body as T;
}

export async function register(payload: RegisterPayload): Promise<void> {
  await request<Record<string, unknown>>(
    '/v1/auth/register',
    { method: 'POST', body: JSON.stringify(payload) },
    false,
    true,
    {
      expectedStatus: 201,
      validate: (body): body is Record<string, unknown> =>
        typeof body === 'object' && body !== null && !Array.isArray(body),
    },
  );
}

export async function resendVerification(email: string): Promise<string> {
  const response = await request<MessageResponse>(
    '/v1/auth/resend-verification',
    { method: 'POST', body: JSON.stringify({ email }) },
    false,
    true,
    {
      expectedStatus: 200,
      validate: (body): body is MessageResponse =>
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        typeof (body as { message?: unknown }).message === 'string',
    },
  );
  return response.message;
}

export async function login(
  email: string,
  password: string,
  operation: AuthOperation = beginAuthOperation(),
): Promise<string | null> {
  const native = usesNativeBearerAuth();
  const init: RequestInit = {
    method: 'POST',
    ...(native ? { headers: NATIVE_AUTH_HEADERS } : {}),
    body: JSON.stringify({ email, password }),
  };
  if (!native) {
    await request('/v1/auth/login', init);
    return null;
  }
  const response = await request<TokenPair>('/v1/auth/login', init, false, true, {
    validate: isTokenPair,
  });
  try {
    const replaced = await replaceCredentialPair(operation, {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
    });
    if (!replaced) throw new StaleAuthOperationError();
  } catch (error) {
    if (error instanceof StaleAuthOperationError) throw error;
    throw new CredentialStorageError(error);
  }
  return response.refresh_token;
}

async function performRefresh(operation: AuthOperation): Promise<void> {
  if (!usesNativeBearerAuth()) {
    await request('/v1/auth/refresh', { method: 'POST', body: '{}' });
    return;
  }
  if (!ownsAuthOperation(operation)) throw new StaleAuthOperationError();
  const pair = await readCredentialPair();
  const refreshToken = pair?.refreshToken;
  if (!refreshToken) throw new ApiError(401, 'Missing refresh token.');
  const tokens = await request<TokenPair>(
    '/v1/auth/refresh',
    {
      method: 'POST',
      headers: NATIVE_AUTH_HEADERS,
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    false,
    true,
    { validate: isTokenPair },
  );
  const replaced = await replaceCredentialPair(
    operation,
    { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
    refreshToken,
  );
  if (!replaced) throw new StaleAuthOperationError();
}

export async function refreshTokens(
  operation: AuthOperation = currentAuthOperation(),
): Promise<void> {
  const existing = refreshFlights.get(operation.epoch);
  if (existing) return existing;
  const pending = performRefresh(operation);
  refreshFlights.set(operation.epoch, pending);
  try {
    await pending;
  } finally {
    if (refreshFlights.get(operation.epoch) === pending) {
      refreshFlights.delete(operation.epoch);
    }
  }
}

export async function authenticatedRequest<T>(
  path: string,
  init: RequestInit = {},
  operation: AuthOperation = currentAuthOperation(),
): Promise<T> {
  return request<T>(path, init, true, true, {}, operation);
}

export async function getCurrentUser(
  operation: AuthOperation = currentAuthOperation(),
): Promise<CurrentUser> {
  return request<CurrentUser>(
    '/v1/auth/me',
    { method: 'GET' },
    true,
    true,
    {
      expectedStatus: 200,
      validate: isCurrentUser,
    },
    operation,
  );
}

export class LogoutError extends Error {
  constructor(
    public readonly failure: unknown,
    public readonly localCredentialsCleared: boolean,
  ) {
    super('Sign out could not be completed.');
    this.name = 'LogoutError';
  }
}

export async function logout(operation: AuthOperation = beginAuthOperation()): Promise<void> {
  let originalError: unknown;
  let expectedRefreshToken: string | undefined;
  try {
    const refreshToken = usesNativeBearerAuth() ? (await readCredentialPair())?.refreshToken : null;
    expectedRefreshToken = refreshToken ?? undefined;
    await request('/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
    });
  } catch (error) {
    originalError = error;
  }
  try {
    const cleared = await clearCredentialPair(operation, expectedRefreshToken);
    if (!cleared) throw new StaleAuthOperationError();
  } catch (error) {
    throw new LogoutError(originalError ?? error, false);
  }
  if (originalError !== undefined) throw new LogoutError(originalError, true);
}
