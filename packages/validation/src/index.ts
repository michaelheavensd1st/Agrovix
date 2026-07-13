/**
 * @agrovix/validation
 * -----------------------------------------------------------------------
 * Zod schemas shared between the API contracts (typed reflection of the
 * FastAPI Pydantic models) and the clients (form validation, guards).
 */

import { z } from 'zod';

export const emailSchema = z.string().email('Please provide a valid email.');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.');

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  full_name: z.string().max(255).optional().nullable(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.').max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refresh_token: z.string().min(10),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const tokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('bearer'),
  expires_in: z.number().int().nonnegative(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;
