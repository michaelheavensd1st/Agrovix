import { describe, it, expect } from 'vitest';
import { emailSchema, passwordSchema, registerRequestSchema } from '../src/index';

describe('validation schemas', () => {
  it('accepts a valid email', () => {
    expect(emailSchema.safeParse('user@example.com').success).toBe(true);
  });

  it('rejects an invalid email', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('enforces password length', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('longenoughpwd').success).toBe(true);
  });

  it('validates a full register payload', () => {
    const parsed = registerRequestSchema.safeParse({
      email: 'alice@farm.co',
      password: 'longenoughpwd',
      full_name: 'Alice',
    });
    expect(parsed.success).toBe(true);
  });
});
