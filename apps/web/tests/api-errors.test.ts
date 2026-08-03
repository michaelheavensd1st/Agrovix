import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { parseApiErrors } from '@/lib/api-errors';

describe('parseApiErrors', () => {
  it('extracts structured event errors and maps relationship messages to known fields', () => {
    const error = new ApiError(422, {
      detail: {
        event_type: 'SAMPLING',
        errors: [
          {
            field: '',
            message: 'minimum_weight cannot exceed average_weight.',
            type: 'value_error',
          },
        ],
      },
    } as never);
    expect(parseApiErrors(error, new Set(['minimum_weight', 'average_weight']))).toEqual({
      fieldErrors: { minimum_weight: 'minimum_weight cannot exceed average_weight.' },
      generalErrors: [],
    });
  });

  it('uses a clear fallback for unmapped structured fields', () => {
    const error = new ApiError(422, {
      detail: {
        errors: [{ field: 'server_only', message: 'Server-only rule failed.' }],
      },
    } as never);
    expect(parseApiErrors(error, new Set(['sample_size']))).toEqual({
      fieldErrors: {},
      generalErrors: ['Server-only rule failed.'],
    });
  });

  it('retains both mapped and general errors from a mixed response', () => {
    const error = new ApiError(422, {
      detail: {
        errors: [
          { field: 'sample_size', message: 'Must be positive.' },
          { field: 'batch', message: 'Batch rule failed.' },
        ],
      },
    } as never);
    expect(parseApiErrors(error, new Set(['sample_size']))).toEqual({
      fieldErrors: { sample_size: 'Must be positive.' },
      generalErrors: ['Batch rule failed.'],
    });
  });

  it('continues supporting string details, message/code objects, and FastAPI arrays', () => {
    expect(parseApiErrors(new ApiError(409, { detail: 'Duplicate.' })).generalErrors).toEqual([
      'Duplicate.',
    ]);
    expect(
      parseApiErrors(new ApiError(409, { detail: { message: 'Lifecycle blocked.' } } as never)).generalErrors,
    ).toEqual(['Lifecycle blocked.']);
    expect(
      parseApiErrors(
        new ApiError(422, {
          detail: [{ loc: ['body', 'sample_size'], msg: 'Input should be at least 1' }],
        } as never),
        new Set(['sample_size']),
      ).fieldErrors,
    ).toEqual({ sample_size: 'Input should be at least 1' });
  });
});
