import Constants from 'expo-constants';
import { clearTokens, getAccessToken, setTokens } from './secure-storage';

const API_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:8000/api';

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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail);
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) {
    const detail = (body as { detail?: string } | undefined)?.detail ?? 'Request failed';
    throw new ApiError(res.status, detail);
  }
  return body as T;
}

export async function register(payload: RegisterPayload): Promise<void> {
  await request('/v1/auth/register', { method: 'POST', body: JSON.stringify(payload) });
}

export async function login(email: string, password: string): Promise<void> {
  const tokens = await request<TokenPair>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  await setTokens(tokens.access_token, tokens.refresh_token);
}

export async function logout(): Promise<void> {
  try {
    await request('/v1/auth/logout', { method: 'POST' }, true);
  } finally {
    await clearTokens();
  }
}
