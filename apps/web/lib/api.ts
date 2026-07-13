/**
 * Minimal fetch-based API client.
 *
 * Sprint 0 intentionally keeps this thin — a full HTTP layer with
 * interceptors, retries, and typed endpoints will land alongside real
 * business features.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api';

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

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const isJson = res.headers
    .get('content-type')
    ?.includes('application/json');
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorPayload) ?? {});
  }
  return body as T;
}
