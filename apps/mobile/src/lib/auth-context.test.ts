/// <reference types="jest" />

jest.mock('expo-constants', () => ({ expoConfig: { extra: { apiUrl: 'http://localhost/api' } } }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./api', () => {
  const actual = jest.requireActual('./api');
  return {
    ...actual,
    getCurrentUser: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    register: jest.fn(),
    resendVerification: jest.fn(),
  };
});
jest.mock('./secure-storage', () => ({
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
}));

import {
  ApiError,
  ApiFailure,
  CredentialStorageError,
  CurrentUser,
  getCurrentUser,
  login,
  LogoutError,
  logout,
} from './api';
import { endSession, establishLoginSession, restoreStoredSession } from './auth-context';
import { clearTokens, getAccessToken, getRefreshToken } from './secure-storage';

const mockGetCurrentUser = jest.mocked(getCurrentUser);
const mockLogin = jest.mocked(login);
const mockLogout = jest.mocked(logout);
const mockClearTokens = jest.mocked(clearTokens);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockGetRefreshToken = jest.mocked(getRefreshToken);

const user: CurrentUser = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  email: 'native@example.com',
  full_name: 'Native User',
  is_active: true,
  is_verified: true,
  is_superuser: false,
  created_at: '2026-09-21T12:00:00Z',
  updated_at: '2026-09-21T12:00:00Z',
  permissions: [],
  permission_scopes: [],
};

describe('authenticated session policy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetRefreshToken.mockResolvedValue('stored-refresh');
  });

  test('no stored pair becomes unauthenticated without /me', async () => {
    mockGetAccessToken.mockResolvedValue(null);

    await expect(restoreStoredSession()).resolves.toEqual({ status: 'unauthenticated' });

    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('incomplete stored pair becomes unauthenticated without /me', async () => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetRefreshToken.mockResolvedValue(null);

    await expect(restoreStoredSession()).resolves.toEqual({ status: 'unauthenticated' });

    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('valid stored session becomes authenticated', async () => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetCurrentUser.mockResolvedValue(user);

    await expect(restoreStoredSession()).resolves.toEqual({ status: 'authenticated', user });

    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('expired access recovered by the API refresh path becomes authenticated', async () => {
    mockGetAccessToken.mockResolvedValue('expired-access');
    mockGetCurrentUser.mockResolvedValue(user);

    await expect(restoreStoredSession()).resolves.toEqual({ status: 'authenticated', user });
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
  });

  test('definitive authentication 401 clears once and becomes unauthenticated', async () => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetCurrentUser.mockRejectedValue(new ApiError(401, 'Could not validate credentials.'));

    await expect(restoreStoredSession()).resolves.toEqual({ status: 'unauthenticated' });

    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      'network',
      new ApiFailure(
        'network',
        '[unavailable]',
        '/v1/auth/me',
        undefined,
        'TypeError',
        'Network request failed',
      ),
    ],
    ['server 5xx', new ApiError(503, 'Request failed')],
    [
      'malformed /me',
      new ApiFailure(
        'application',
        '[unavailable]',
        '/v1/auth/me',
        200,
        'ApiContractError',
        'Invalid response',
      ),
    ],
    [
      'malformed refresh',
      new ApiFailure(
        'application',
        '[unavailable]',
        '/v1/auth/refresh',
        200,
        'ApiContractError',
        'Invalid response',
      ),
    ],
  ])('%s preserves credentials and becomes recoverable', async (_label, failure) => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetCurrentUser.mockRejectedValue(failure);

    await expect(restoreStoredSession()).resolves.toMatchObject({ status: 'recoverable-error' });

    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('storage read failure is recoverable and does not clear credentials', async () => {
    mockGetAccessToken.mockRejectedValue(new Error('secure read failed'));

    await expect(restoreStoredSession()).resolves.toMatchObject({ status: 'recoverable-error' });

    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('clear failure cannot produce a clean unauthenticated state', async () => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetCurrentUser.mockRejectedValue(new ApiError(401, 'Could not validate credentials.'));
    mockClearTokens.mockRejectedValue(new Error('secure clear failed'));

    await expect(restoreStoredSession()).resolves.toMatchObject({ status: 'recoverable-error' });
  });

  test('a retry can recover a transient bootstrap failure', async () => {
    mockGetAccessToken.mockResolvedValue('stored-access');
    mockGetCurrentUser
      .mockRejectedValueOnce(
        new ApiFailure(
          'network',
          '[unavailable]',
          '/v1/auth/me',
          undefined,
          'TypeError',
          'Offline',
        ),
      )
      .mockResolvedValueOnce(user);

    await expect(restoreStoredSession()).resolves.toMatchObject({ status: 'recoverable-error' });
    await expect(restoreStoredSession()).resolves.toEqual({ status: 'authenticated', user });
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('login establishes a server-validated authenticated session', async () => {
    mockLogin.mockResolvedValue('login-refresh');
    mockGetCurrentUser.mockResolvedValue(user);

    await expect(establishLoginSession('native@example.com', 'password')).resolves.toEqual({
      status: 'authenticated',
      user,
    });

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
  });

  test('login token persistence failure is recoverable and does not clear credentials', async () => {
    const storageFailure = new Error('secure write failed');
    mockLogin.mockRejectedValue(new CredentialStorageError(storageFailure));

    await expect(establishLoginSession('native@example.com', 'password')).resolves.toMatchObject({
      status: 'recoverable-error',
    });

    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test.each([
    [
      'network',
      new ApiFailure('network', '[unavailable]', '/v1/auth/me', undefined, 'TypeError', 'Offline'),
    ],
    ['server 5xx', new ApiError(503, 'Request failed')],
    [
      'malformed /me',
      new ApiFailure(
        'application',
        '[unavailable]',
        '/v1/auth/me',
        200,
        'ApiContractError',
        'Invalid response',
      ),
    ],
  ])('persisted login followed by %s remains recoverable', async (_label, failure) => {
    mockLogin.mockResolvedValue('login-refresh');
    mockGetCurrentUser.mockRejectedValue(failure);

    await expect(establishLoginSession('native@example.com', 'password')).resolves.toMatchObject({
      status: 'recoverable-error',
    });

    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('persisted login followed by definitive 401 clears that login pair', async () => {
    mockLogin.mockResolvedValue('login-refresh');
    mockGetCurrentUser.mockRejectedValue(new ApiError(401, 'Could not validate credentials.'));
    mockGetAccessToken.mockResolvedValue('login-access');
    mockGetRefreshToken.mockResolvedValue('login-refresh');

    await expect(establishLoginSession('native@example.com', 'password')).resolves.toEqual({
      status: 'unauthenticated',
    });

    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  test('logout with local clear success becomes unauthenticated despite server failure', async () => {
    const serverFailure = new ApiError(503, 'Request failed');
    mockLogout.mockRejectedValue(new LogoutError(serverFailure, true));

    await expect(endSession()).resolves.toEqual({
      session: { status: 'unauthenticated' },
    });
  });

  test('logout local clear failure becomes recoverable', async () => {
    const clearFailure = new Error('secure clear failed');
    mockLogout.mockRejectedValue(new LogoutError(clearFailure, false));

    await expect(endSession()).resolves.toMatchObject({
      session: { status: 'recoverable-error' },
      failure: clearFailure,
    });
  });
});
