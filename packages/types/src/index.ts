/**
 * @agrovix/types
 * -----------------------------------------------------------------------
 * Shared, framework-agnostic TypeScript types used across `apps/web`,
 * `apps/mobile`, and any future clients. Keep this package free of
 * runtime dependencies — types only.
 */

export type UUID = string;
export type ISODateTimeString = string;

export interface PublicUser {
  id: UUID;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_verified: boolean;
  is_superuser: boolean;
  roles: string[];
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
}

export interface ApiErrorBody {
  detail: string;
}

/** Standard health-endpoint response contract. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
}

/** Extensible auth-provider tag — enables future SSO integrations. */
export type AuthProvider = 'password' | 'google' | 'microsoft' | 'apple' | 'phone_otp';
