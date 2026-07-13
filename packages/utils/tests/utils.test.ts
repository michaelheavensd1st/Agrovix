import { describe, it, expect } from 'vitest';
import { assertDefined, formatDate, toErrorMessage } from '../src/index';

describe('utils', () => {
  it('assertDefined throws on null/undefined', () => {
    expect(() => assertDefined(null)).toThrow();
    expect(() => assertDefined(undefined)).toThrow();
    expect(assertDefined('x')).toBe('x');
  });

  it('formatDate handles bad inputs gracefully', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('toErrorMessage stringifies common shapes', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('nope')).toBe('nope');
    expect(toErrorMessage({ code: 42 })).toContain('42');
  });
});
