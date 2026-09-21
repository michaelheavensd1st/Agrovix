import type { SessionState } from './auth-context';

export type SessionDestination = '/dashboard' | '/login' | null;

export function startupDestination(status: SessionState['status']): SessionDestination {
  if (status === 'authenticated') return '/dashboard';
  if (status === 'unauthenticated') return '/login';
  return null;
}

export function routeForSession(
  status: SessionState['status'],
  route: string | undefined,
): SessionDestination {
  if (status === 'initializing' || status === 'recoverable-error' || route === 'index') return null;
  if (status === 'unauthenticated' && route === 'dashboard') return '/login';
  if (status === 'authenticated' && (route === 'login' || route === 'register')) {
    return '/dashboard';
  }
  return null;
}

export function shouldHoldSessionRoute(
  status: SessionState['status'],
  route: string | undefined,
): boolean {
  if (route === 'index') return false;
  return (
    status === 'initializing' ||
    status === 'recoverable-error' ||
    routeForSession(status, route) !== null
  );
}
