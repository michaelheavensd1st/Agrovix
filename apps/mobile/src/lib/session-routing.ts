import type { SessionState } from './auth-context';

export type SessionDestination = '/dashboard' | '/login' | null;

function normalizeRoute(route: string | undefined): string | null {
  if (!route) return null;
  const trimmed = route.trim();
  if (!trimmed || trimmed === '/') return null;
  return trimmed.replace(/^\/+/, '');
}

export function startupDestination(status: SessionState['status']): SessionDestination {
  if (status === 'authenticated') return '/dashboard';
  if (status === 'unauthenticated') return '/login';
  return null;
}

export function routeForSession(
  status: SessionState['status'],
  route: string | undefined,
): SessionDestination {
  const normalizedRoute = normalizeRoute(route);

  if (status === 'initializing' || status === 'recoverable-error' || normalizedRoute === 'index') {
    return null;
  }

  if (status === 'unauthenticated') {
    if (normalizedRoute === null || normalizedRoute === 'login' || normalizedRoute === 'register') {
      return null;
    }
    return '/login';
  }

  if (
    status === 'authenticated' &&
    (normalizedRoute === 'login' || normalizedRoute === 'register')
  ) {
    return '/dashboard';
  }

  return null;
}

export function shouldHoldSessionRoute(
  status: SessionState['status'],
  route: string | undefined,
): boolean {
  const normalizedRoute = normalizeRoute(route);

  if (normalizedRoute === 'index') return false;
  return (
    status === 'initializing' ||
    status === 'recoverable-error' ||
    routeForSession(status, normalizedRoute ?? undefined) !== null
  );
}
