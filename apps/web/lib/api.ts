/**
 * Cookie-first API client for the Next.js web app.
 *
 * All auth cookies are httpOnly + Secure — the browser attaches them
 * automatically once ``credentials: 'include'`` is set. We never touch
 * localStorage/sessionStorage for tokens.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api';

export type ApiErrorPayload = { detail?: string; [key: string]: unknown };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ApiErrorPayload,
  ) {
    super(payload.detail ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorPayload) ?? {});
  }
  return body as T;
}
