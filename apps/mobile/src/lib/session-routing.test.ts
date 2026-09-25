/// <reference types="jest" />

import { routeForSession, shouldHoldSessionRoute, startupDestination } from './session-routing';

describe('session route boundary', () => {
  test('only settled startup states have destinations', () => {
    expect(startupDestination('initializing')).toBeNull();
    expect(startupDestination('recoverable-error')).toBeNull();
    expect(startupDestination('authenticated')).toBe('/dashboard');
    expect(startupDestination('unauthenticated')).toBe('/login');
  });

  test.each([
    ['initializing', 'dashboard'],
    ['initializing', 'login'],
    ['recoverable-error', 'dashboard'],
    ['recoverable-error', 'login'],
  ] as const)('%s does not redirect %s prematurely', (status, route) => {
    expect(routeForSession(status, route)).toBeNull();
  });

  test('authenticated auth-only routes redirect to Dashboard', () => {
    expect(routeForSession('authenticated', 'login')).toBe('/dashboard');
    expect(routeForSession('authenticated', 'register')).toBe('/dashboard');
    expect(routeForSession('authenticated', 'dashboard')).toBeNull();
  });

  test('settled unauthenticated direct Dashboard route is blocked', () => {
    expect(routeForSession('unauthenticated', 'dashboard')).toBe('/login');
    expect(routeForSession('unauthenticated', 'login')).toBeNull();
  });

  test('index owns startup settlement without competing layout navigation', () => {
    expect(routeForSession('authenticated', 'index')).toBeNull();
    expect(routeForSession('unauthenticated', 'index')).toBeNull();
  });

  test('slash-prefixed and empty route names normalize to the same auth guard decisions', () => {
    expect(routeForSession('authenticated', '/login')).toBe('/dashboard');
    expect(routeForSession('authenticated', '/register')).toBe('/dashboard');
    expect(routeForSession('unauthenticated', '/dashboard')).toBe('/login');
    expect(routeForSession('unauthenticated', 'production')).toBe('/login');
    expect(routeForSession('unauthenticated', '/production')).toBe('/login');
    expect(routeForSession('authenticated', '/dashboard')).toBeNull();
    expect(routeForSession('authenticated', '/production')).toBeNull();
    expect(routeForSession('authenticated', '/')).toBeNull();
    expect(routeForSession('authenticated', undefined)).toBeNull();
  });

  test('unresolved and redirecting direct routes withhold their screen content', () => {
    expect(shouldHoldSessionRoute('initializing', 'dashboard')).toBe(true);
    expect(shouldHoldSessionRoute('recoverable-error', 'dashboard')).toBe(true);
    expect(shouldHoldSessionRoute('unauthenticated', 'dashboard')).toBe(true);
    expect(shouldHoldSessionRoute('unauthenticated', 'production')).toBe(true);
    expect(shouldHoldSessionRoute('unauthenticated', '/production')).toBe(true);
    expect(shouldHoldSessionRoute('authenticated', 'login')).toBe(true);
    expect(shouldHoldSessionRoute('authenticated', 'dashboard')).toBe(false);
    expect(shouldHoldSessionRoute('authenticated', 'production')).toBe(false);
    expect(shouldHoldSessionRoute('unauthenticated', 'login')).toBe(false);
    expect(shouldHoldSessionRoute('initializing', 'index')).toBe(false);
    expect(shouldHoldSessionRoute('authenticated', '/login')).toBe(true);
    expect(shouldHoldSessionRoute('authenticated', undefined)).toBe(false);
  });
});
