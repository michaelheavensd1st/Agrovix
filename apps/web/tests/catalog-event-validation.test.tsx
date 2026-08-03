import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockedApiFetchResult } = vi.hoisted(() => ({ mockedApiFetchResult: vi.fn() }));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetchResult: mockedApiFetchResult };
});

import { CatalogEventForm } from '@/components/event-forms';
import { ApiError } from '@/lib/api';
import type { EventCatalogEntry } from '@/lib/types';

const SAMPLING: EventCatalogEntry = {
  code: 'SAMPLING',
  display_name: 'Sampling',
  category: 'operations',
  version: 2,
  triggers_transition_to: null,
  metadata: {},
  schema: {
    type: 'object',
    required: ['sample_size', 'average_weight'],
    properties: {
      sample_size: { type: 'integer', minimum: 1 },
      average_weight: { type: 'number', minimum: 0 },
      minimum_weight: { type: 'number', minimum: 0 },
      maximum_weight: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
    },
  },
  openapi_example: {
    sample_size: 30,
    average_weight: 4.8,
    minimum_weight: 3.9,
    maximum_weight: 5.7,
  },
};

describe('CatalogEventForm structured validation', () => {
  beforeEach(() => mockedApiFetchResult.mockReset());

  it('shows a Sampling relationship error inline and retains entered values', async () => {
    mockedApiFetchResult.mockImplementationOnce(async () => {
      throw new ApiError(422, {
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
    });
    render(
      <CatalogEventForm batchId="batch-1" entry={SAMPLING} onCreated={() => {}} onCancel={() => {}} />,
    );
    const minimum = screen.getByTestId('catalog-field-minimum_weight');
    fireEvent.change(minimum, { target: { value: '9.2' } });
    fireEvent.click(screen.getByTestId('catalog-submit-SAMPLING'));

    expect(await screen.findByText('minimum_weight cannot exceed average_weight.')).toBeInTheDocument();
    expect(minimum).toHaveValue(9.2);
    expect(minimum).toHaveAttribute(
      'aria-describedby',
      'catalog-field-SAMPLING-minimum_weight-error',
    );
  });

  it('shows unmapped structured validation as a general error', async () => {
    mockedApiFetchResult.mockImplementationOnce(async () => {
      throw new ApiError(422, {
        detail: { errors: [{ field: 'server_only', message: 'Batch rule failed.' }] },
      } as never);
    });
    render(
      <CatalogEventForm batchId="batch-1" entry={SAMPLING} onCreated={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('catalog-submit-SAMPLING'));
    expect(await screen.findByText('Batch rule failed.')).toBeInTheDocument();
  });

  it('invokes login handling when refresh recovery ultimately returns 401', async () => {
    const onUnauthenticated = vi.fn();
    mockedApiFetchResult.mockImplementationOnce(async () => {
      throw new ApiError(401, { detail: 'Could not validate credentials.' });
    });
    render(
      <CatalogEventForm
        batchId="batch-1"
        entry={SAMPLING}
        onCreated={() => {}}
        onCancel={() => {}}
        onUnauthenticated={onUnauthenticated}
      />,
    );
    fireEvent.click(screen.getByTestId('catalog-submit-SAMPLING'));
    await waitFor(() => expect(onUnauthenticated).toHaveBeenCalledTimes(1));
  });
});
