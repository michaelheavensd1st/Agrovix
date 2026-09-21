/// <reference types="jest" />

jest.mock('./secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
}));

import {
  AuthOperationOwner,
  beginAuthOperation,
  clearCredentialPair,
  readCredentialPair,
  replaceCredentialPair,
  SingleFlight,
} from './auth-operations';
import * as secureStorage from './secure-storage';

const mockSetTokens = jest.mocked(secureStorage.setTokens);
const mockClearTokens = jest.mocked(secureStorage.clearTokens);
const mockGetAccessToken = jest.mocked(secureStorage.getAccessToken);
const mockGetRefreshToken = jest.mocked(secureStorage.getRefreshToken);

describe('auth operation credential ownership', () => {
  let storedAccess: string | null;
  let storedRefresh: string | null;

  beforeEach(() => {
    jest.resetAllMocks();
    storedAccess = 'old-access';
    storedRefresh = 'old-refresh';
    mockGetAccessToken.mockImplementation(async () => storedAccess);
    mockGetRefreshToken.mockImplementation(async () => storedRefresh);
    mockSetTokens.mockImplementation(async (access, refresh) => {
      storedAccess = access;
      storedRefresh = refresh;
    });
    mockClearTokens.mockImplementation(async () => {
      storedAccess = null;
      storedRefresh = null;
    });
  });

  test('stale bootstrap rejection cannot clear a pair written by a newer login', async () => {
    const staleBootstrap = beginAuthOperation();
    const newerLogin = beginAuthOperation();
    await replaceCredentialPair(newerLogin, {
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
    });

    await expect(clearCredentialPair(staleBootstrap, 'old-refresh')).resolves.toBe(false);

    await expect(readCredentialPair()).resolves.toEqual({
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
    });
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('stale refresh cannot replace a pair written by a newer login', async () => {
    const staleRefresh = beginAuthOperation();
    const newerLogin = beginAuthOperation();
    await replaceCredentialPair(newerLogin, {
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
    });

    await expect(
      replaceCredentialPair(
        staleRefresh,
        { accessToken: 'refresh-access', refreshToken: 'refresh-refresh' },
        'old-refresh',
      ),
    ).resolves.toBe(false);

    await expect(readCredentialPair()).resolves.toEqual({
      accessToken: 'login-access',
      refreshToken: 'login-refresh',
    });
    expect(mockSetTokens).toHaveBeenCalledTimes(1);
  });

  test('stale refresh cannot recreate credentials after a newer logout', async () => {
    const staleRefresh = beginAuthOperation();
    const newerLogout = beginAuthOperation();
    await clearCredentialPair(newerLogout, 'old-refresh');

    await expect(
      replaceCredentialPair(
        staleRefresh,
        { accessToken: 'refresh-access', refreshToken: 'refresh-refresh' },
        'old-refresh',
      ),
    ).resolves.toBe(false);

    await expect(readCredentialPair()).resolves.toBeNull();
    expect(mockSetTokens).not.toHaveBeenCalled();
  });

  test('a new coordinator consumer invalidates ownership created before remount', async () => {
    const previousProvider = new AuthOperationOwner();
    const beforeRemount = previousProvider.begin();
    new AuthOperationOwner();

    await expect(clearCredentialPair(beforeRemount, 'old-refresh')).resolves.toBe(false);
    await expect(readCredentialPair()).resolves.toEqual({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });
  });

  test('provider unmount invalidation revokes its pending credential ownership', async () => {
    const provider = new AuthOperationOwner();
    const pending = provider.begin();
    provider.invalidate();

    await expect(clearCredentialPair(pending, 'old-refresh')).resolves.toBe(false);
    expect(mockClearTokens).not.toHaveBeenCalled();
  });

  test('the current credential owner can clear definitively invalid credentials once', async () => {
    const owner = beginAuthOperation();

    await expect(clearCredentialPair(owner, 'old-refresh')).resolves.toBe(true);

    await expect(readCredentialPair()).resolves.toBeNull();
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
  });

  test('single-flight returns one controlled logout operation for immediate repeated calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = jest.fn(() => gate);
    const flight = new SingleFlight();

    const first = flight.run(operation);
    const second = flight.run(operation);

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await flight.run(async () => undefined);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
