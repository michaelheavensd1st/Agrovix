/// <reference types="jest" />

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));
let mockPlatformOs = 'android';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOs;
    },
  },
}));
jest.mock('./secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
}));

import easConfig from '../../eas.json';
import {
  ApiError,
  ApiFailure,
  authenticatedRequest,
  login,
  logout,
  refreshTokens,
  register,
  resolveApiUrl,
} from './api';
import { authErrorMessage } from './auth-context';
import * as secureStorage from './secure-storage';

const mockSetTokens = jest.mocked(secureStorage.setTokens);
const mockClearTokens = jest.mocked(secureStorage.clearTokens);
const mockGetAccessToken = jest.mocked(secureStorage.getAccessToken);
const mockGetRefreshToken = jest.mocked(secureStorage.getRefreshToken);

const tokenPair = (access: string, refresh: string) => ({
  access_token: access,
  refresh_token: refresh,
  token_type: 'bearer',
  expires_in: 900,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status: number, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

describe('mobile API configuration and native auth transport', () => {
  let fetchMock: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPlatformOs = 'android';
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  test('validation env overrides checked-in localhost while local development keeps localhost', () => {
    const validationUrl = easConfig.build['sdk56-validation'].env.EXPO_PUBLIC_API_URL;
    expect(resolveApiUrl(validationUrl, 'http://localhost:8000/api')).toBe(validationUrl);
    expect(resolveApiUrl(undefined, 'http://localhost:8000/api')).toBe('http://localhost:8000/api');
  });

  test('fetch rejection is classified as a sanitized network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed') as never);

    await expect(
      register({ email: 'private@example.com', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({
      phase: 'network',
      path: '/v1/auth/register',
      status: undefined,
      errorName: 'TypeError',
      safeMessage: 'Network request failed',
    });
  });

  test('201 valid JSON registration succeeds', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'user-id' }, 201) as never);

    await expect(
      register({ email: 'new@example.com', password: 'Secret123!', full_name: 'New User' }),
    ).resolves.toBeUndefined();
  });

  test.each([
    ['', 'empty'],
    ['{"id":', 'malformed'],
  ])('201 %s application/json registration is a parse failure', async (body) => {
    fetchMock.mockResolvedValue(textResponse(body, 201, 'application/json') as never);

    await expect(
      register({ email: 'new@example.com', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({ phase: 'parse', status: 201, path: '/v1/auth/register' });
  });

  test.each(['Application/JSON; Charset=UTF-8', 'application/problem+json'])(
    'registration parses JSON content type %s',
    async (contentType) => {
      fetchMock.mockResolvedValue(textResponse('{"id":"user-id"}', 201, contentType) as never);

      await expect(
        register({ email: 'new@example.com', password: 'Secret123!', full_name: null }),
      ).resolves.toBeUndefined();
    },
  );

  test('non-JSON 2xx registration is an application contract failure', async () => {
    fetchMock.mockResolvedValue(textResponse('created', 201) as never);

    await expect(
      register({ email: 'new@example.com', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({ phase: 'application', status: 201 });
  });

  test('non-JSON HTTP error is a safe HTTP failure', async () => {
    fetchMock.mockResolvedValue(
      textResponse('<html>proxy error</html>', 502, 'text/html') as never,
    );

    await expect(
      register({ email: 'new@example.com', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({ phase: 'http', status: 502, detail: 'Request failed' });
  });

  test('string API detail remains usable and sensitive values are redacted', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'Account private@example.com password: Secret123!' }, 409) as never,
    );

    await expect(
      register({ email: 'private@example.com', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({
      detail: 'Account [redacted-email] password=[redacted]',
    });
  });

  test('FastAPI structured validation detail is normalized without rendering objects', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: [{ loc: ['body', 'email'], msg: 'invalid' }] }, 422) as never,
    );

    await expect(
      register({ email: 'invalid', password: 'Secret123!', full_name: null }),
    ).rejects.toMatchObject({ detail: 'Request validation failed.' });
  });

  test.each([null, [], 'created'])(
    'unexpected successful registration shape %p is an application failure',
    async (body) => {
      fetchMock.mockResolvedValue(jsonResponse(body, 201) as never);

      await expect(
        register({ email: 'new@example.com', password: 'Secret123!', full_name: null }),
      ).rejects.toMatchObject({ phase: 'application', status: 201 });
    },
  );

  test('diagnostics disabled retain concise safe UI errors', () => {
    const failure = new ApiFailure(
      'network',
      'https://api.example.test/api',
      '/v1/auth/register',
      undefined,
      'TypeError',
      'Network request failed',
    );
    expect(authErrorMessage(failure, false)).toBe('Unable to reach the API.');
    expect(
      authErrorMessage(
        new ApiError(
          409,
          'An account with that email already exists.',
          'https://api.test/api',
          '/v1',
        ),
        false,
      ),
    ).toBe('An account with that email already exists.');
  });

  test('diagnostics enabled show only sanitized classification metadata', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'Account private@example.com password: Secret123!' }, 409) as never,
    );
    let failure: unknown;
    try {
      await register({ email: 'private@example.com', password: 'Secret123!', full_name: null });
    } catch (error) {
      failure = error;
    }

    const message = authErrorMessage(failure, true);
    expect(message).toContain('phase=http');
    expect(message).toContain('base=http://localhost:8000/api');
    expect(message).toContain('path=/v1/auth/register');
    expect(message).toContain('status=409');
    expect(message).toContain('error=ApiError');
    expect(message).not.toContain('private@example.com');
    expect(message).not.toContain('Secret123!');
    expect(message).not.toMatch(/access_token|refresh_token|authorization|cookie/i);
  });

  test('diagnostics enabled sanitize unclassified errors without using the generic fallback', () => {
    const failure = new Error(
      'Bearer access-secret password=private cookie=session authorization=credential',
    );
    failure.name = 'Unsafe Error\nBearer name-secret password=name-password';
    failure.stack = 'SECRET STACK TRACE';

    const message = authErrorMessage(failure, true, '/v1/auth/register');

    expect(message).toContain('phase=unclassified');
    expect(message).toContain('base=[unavailable]');
    expect(message).toContain('path=/v1/auth/register');
    expect(message).toContain('error=Unclassified.UnsafeErrorBearerredactedpasswordredacted');
    expect(message).not.toBe('Unable to reach the API.');
    expect(message).not.toContain('access-secret');
    expect(message).not.toContain('private');
    expect(message).not.toContain('session');
    expect(message).not.toContain('credential');
    expect(message).not.toContain('name-secret');
    expect(message).not.toContain('name-password');
    expect(message).not.toContain('SECRET STACK TRACE');
  });

  test('diagnostics disabled retain the generic fallback for unclassified errors', () => {
    expect(authErrorMessage(new Error('unexpected failure'), false)).toBe(
      'Unable to reach the API.',
    );
  });

  test.each(['android', 'ios'])(
    '%s login selects bearer transport and stores tokens',
    async (os) => {
      mockPlatformOs = os;
      fetchMock.mockResolvedValue(jsonResponse(tokenPair('access-1', 'refresh-1')) as never);

      await login('native@example.com', 'password');

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ 'X-Agrovix-Auth-Transport': 'bearer' });
      expect(mockSetTokens).toHaveBeenCalledWith('access-1', 'refresh-1');
    },
  );

  test.each(['android', 'ios'])(
    '%s refresh selects bearer transport and atomically replaces the pair',
    async (os) => {
      mockPlatformOs = os;
      mockGetRefreshToken.mockResolvedValue('refresh-1');
      fetchMock.mockResolvedValue(jsonResponse(tokenPair('access-2', 'refresh-2')) as never);

      await refreshTokens();

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ 'X-Agrovix-Auth-Transport': 'bearer' });
      expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'refresh-1' });
      expect(mockSetTokens).toHaveBeenCalledWith('access-2', 'refresh-2');
    },
  );

  test('Expo web login and refresh use cookies without entering bearer storage', async () => {
    mockPlatformOs = 'web';
    fetchMock.mockImplementation(
      async () => jsonResponse({ token_type: 'bearer', expires_in: 900 }) as never,
    );

    await login('browser@example.com', 'password');
    await refreshTokens();
    await authenticatedRequest('/v1/protected');

    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: 'include' });
      expect(init.headers).not.toHaveProperty('X-Agrovix-Auth-Transport');
    }
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    expect(mockSetTokens).not.toHaveBeenCalled();
  });

  test('concurrent authenticated failures share one refresh and retry with replacement access', async () => {
    let accessToken = 'access-1';
    let refreshRequests = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    mockGetAccessToken.mockImplementation(async () => accessToken);
    mockGetRefreshToken.mockResolvedValue('refresh-1');
    mockSetTokens.mockImplementation(async (access) => {
      accessToken = access;
    });
    fetchMock.mockImplementation(async (url, init) => {
      if ((url as string).endsWith('/v1/auth/refresh')) {
        refreshRequests += 1;
        await refreshGate;
        return jsonResponse(tokenPair('access-2', 'refresh-2')) as never;
      }
      const authorization = (init as RequestInit).headers as Record<string, string>;
      return authorization.Authorization === 'Bearer access-1'
        ? (jsonResponse({ detail: 'Access token has expired.' }, 401) as never)
        : (jsonResponse({ ok: true }) as never);
    });

    const first = authenticatedRequest<{ ok: boolean }>('/v1/protected');
    const second = authenticatedRequest<{ ok: boolean }>('/v1/protected');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshRequests).toBe(1);
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshRequests).toBe(1);
    const protectedCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith('/v1/protected'),
    );
    expect(protectedCalls).toHaveLength(4);
    expect(
      protectedCalls
        .slice(2)
        .map(([, init]) => (init.headers as Record<string, string>).Authorization),
    ).toEqual(['Bearer access-2', 'Bearer access-2']);
  });

  test('logout uses the refresh-token body contract and always clears local tokens', async () => {
    mockGetRefreshToken.mockResolvedValue('refresh-2');
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Logged out' }) as never);

    await logout();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'refresh-2' });
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  test('logout clears tokens and preserves a refresh-token read failure', async () => {
    const readFailure = new Error('secure read failed');
    mockGetRefreshToken.mockRejectedValue(readFailure);

    await expect(logout()).rejects.toBe(readFailure);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  test('logout clears tokens and reports the original server failure', async () => {
    mockGetRefreshToken.mockResolvedValue('refresh-2');
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'server failed' }, 500) as never);
    mockClearTokens.mockRejectedValue(new Error('secure clear failed'));

    await expect(logout()).rejects.toMatchObject({ status: 500, detail: 'server failed' });

    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });
});
