import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './secure-storage';

export function resolveApiUrl(publicUrl?: string, configuredUrl?: string): string {
  return publicUrl || configuredUrl || 'http://localhost:8000/api';
}

const CONFIGURED_API_URL = resolveApiUrl(
  process.env.EXPO_PUBLIC_API_URL,
  Constants.expoConfig?.extra?.apiUrl as string | undefined,
);
const NATIVE_AUTH_HEADERS = { 'X-Agrovix-Auth-Transport': 'bearer' } as const;
let refreshPromise: Promise<void> | null = null;

function isNativePlatform(): boolean {
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
): Promise<T> {
  const location = resolveApiLocation(path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth && isNativePlatform()) {
    const token = await getAccessToken();
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
  if (res.status === 401 && auth && mayRefresh && isNativePlatform()) {
    await refreshTokens();
    return request<T>(path, init, true, false, contract);
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

export async function login(email: string, password: string): Promise<void> {
  const native = isNativePlatform();
  const init: RequestInit = {
    method: 'POST',
    ...(native ? { headers: NATIVE_AUTH_HEADERS } : {}),
    body: JSON.stringify({ email, password }),
  };
  if (!native) {
    await request('/v1/auth/login', init);
    return;
  }
  const response = await request<TokenPair>('/v1/auth/login', init, false, true, {
    validate: isTokenPair,
  });
  await setTokens(response.access_token, response.refresh_token);
}

async function performRefresh(): Promise<void> {
  if (!isNativePlatform()) {
    await request('/v1/auth/refresh', { method: 'POST', body: '{}' });
    return;
  }
  const refreshToken = await getRefreshToken();
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
  await setTokens(tokens.access_token, tokens.refresh_token);
}

export async function refreshTokens(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  const pending = performRefresh();
  refreshPromise = pending;
  try {
    await pending;
  } finally {
    if (refreshPromise === pending) refreshPromise = null;
  }
}

export async function authenticatedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}

export async function logout(): Promise<void> {
  let originalError: unknown;
  try {
    const refreshToken = isNativePlatform() ? await getRefreshToken() : null;
    await request('/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
    });
  } catch (error) {
    originalError = error;
  }
  try {
    await clearTokens();
  } catch (error) {
    if (originalError === undefined) originalError = error;
  }
  if (originalError !== undefined) throw originalError;
}
