/// <reference types="jest" />

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));
jest.mock('react', () => {
  const React = jest.requireActual('react');
  return {
    ...React,
    useRef: jest.fn(),
    useState: jest.fn(),
  };
});
const mockPlatformOs = 'android';
jest.mock('react-native', () => {
  const React = jest.requireActual('react');
  const nativeComponent = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(name, props, props.children);

  return {
    Platform: {
      get OS() {
        return mockPlatformOs;
      },
    },
    Pressable: nativeComponent('Pressable'),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text: nativeComponent('Text'),
    TextInput: nativeComponent('TextInput'),
    View: nativeComponent('View'),
  };
});
jest.mock('../../lib/secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
}));
jest.mock('../../lib/production-api', () => ({
  createBatchEvent: jest.fn(),
  getBatchProjections: jest.fn(),
  getProductionBatch: jest.fn(),
  listBatchEvents: jest.fn(),
}));

import React from 'react';
import { Pressable } from 'react-native';
import { WaterQualityForm } from '../../components/production/water-quality-form';
import { ApiFailure } from '../../lib/api';
import * as productionApi from '../../lib/production-api';
import {
  buildWaterQualityPayload,
  createWaterQualityDraftSignature,
  createWaterQualitySubmission,
  hasActualWaterQualityMeasurement,
  isSameLogicalSubmission,
  reconcileWaterQualityWrite,
  resolveWriteOutcome,
  type WaterQualityWriteContext,
} from './production-write';

describe('water-quality write workflow', () => {
  const nowIso = '2026-09-25T14:30:00Z';

  test('requires at least one actual measurement and keeps canonical units', () => {
    expect(
      hasActualWaterQualityMeasurement({
        temperature: null,
        ph: null,
        dissolved_oxygen: null,
        ammonia: null,
        nitrite: null,
        turbidity: null,
      }),
    ).toBe(false);

    const payload = buildWaterQualityPayload(
      {
        temperature: '29.4',
        ph: '7.9',
        dissolved_oxygen: '5.6',
        ammonia: '0.15',
        nitrite: '0.02',
        turbidity: '42',
        measured_at: nowIso,
      },
      { batchId: 'batch-42' },
    );

    expect(payload.measured_at).toBe('2026-09-25T14:30:00.000Z');
    expect(payload.measurement_units.temperature).toBe('C');
    expect(payload.measurement_units.dissolved_oxygen).toBe('mg_l');
    expect(payload.measurement_units.ammonia).toBe('mg_l');
    expect(payload.temperature).toBe(29.4);
    expect(payload.ph).toBe(7.9);
  });

  test('two distinct identical submissions receive different generated keys', () => {
    const first = createWaterQualitySubmission('batch-42', {
      temperature: 29.4,
      measured_at: nowIso,
    });
    const second = createWaterQualitySubmission('batch-42', {
      temperature: 29.4,
      measured_at: nowIso,
    });

    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.payload).toEqual(second.payload);
  });

  test('reuses the same logical submission for same payload and idempotency key', () => {
    const base = createWaterQualitySubmission(
      'batch-42',
      {
        temperature: 29.4,
        ph: 7.9,
        dissolved_oxygen: 5.6,
        ammonia: 0.15,
        nitrite: 0.02,
        turbidity: 42,
        measured_at: nowIso,
      },
      'water-quality-key-1',
      {
        batchName: 'B-001',
        farmName: 'North Farm',
        unitName: 'Tank 2',
      },
    );

    const retry = createWaterQualitySubmission(
      'batch-42',
      {
        temperature: 29.4,
        ph: 7.9,
        dissolved_oxygen: 5.6,
        ammonia: 0.15,
        nitrite: 0.02,
        turbidity: 42,
        measured_at: nowIso,
      },
      'water-quality-key-1',
      {
        batchName: 'B-001',
        farmName: 'North Farm',
        unitName: 'Tank 2',
      },
    );

    expect(isSameLogicalSubmission(base, retry)).toBe(true);
    expect(base.idempotencyKey).toBe('water-quality-key-1');
  });

  test('network ambiguity preserves the immutable submission and same retry key', () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-key-ambiguous',
      { batchName: 'B-001', farmName: 'North Farm', unitName: 'Tank 2' },
    );

    const outcome = resolveWriteOutcome({
      submission,
      status: 'network',
      accepted: false,
      response: null,
    });

    expect(outcome.outcome).toBe('outcome_unknown');
    expect(outcome.retrySubmission).toEqual(submission);
    expect(outcome.retrySubmission).not.toBeNull();
    if (outcome.retrySubmission) {
      expect(outcome.retrySubmission.idempotencyKey).toBe('water-quality-key-ambiguous');
    }
  });

  test('thrown real-shape 409 and 422 failures become rejected', async () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-key-conflict',
    );

    const post = jest
      .fn()
      .mockRejectedValue(
        new ApiFailure(
          'http',
          'http://localhost:8000/api',
          '/v1/batches/batch-42/events',
          409,
          'ApiError',
          'Conflict',
        ),
      );
    const readAll = jest.fn();

    const result = await reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      post,
      readAll,
    });

    expect(result.outcome).toBe('rejected');
    expect(readAll).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
  });

  test('genuine network failure becomes outcome_unknown and retries with the same key', async () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-key-network',
    );

    const post = jest
      .fn()
      .mockRejectedValue(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-42/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      );

    const result = await reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      post,
      readAll: jest.fn(),
    });

    expect(result.outcome).toBe('outcome_unknown');
    expect(result.retrySubmission).not.toBeNull();
    expect(result.retrySubmission?.idempotencyKey).toBe(submission.idempotencyKey);
  });

  test('conflicting display context cannot change the authoritative batch target', () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-key-context',
      {
        batchId: 'batch-999',
        batchName: 'Batch-999',
        farmName: 'North Farm',
        unitName: 'Tank 2',
      },
    );

    expect(submission.batchId).toBe('batch-42');
    expect(submission.context.batchId).toBe('batch-42');
  });

  test('two synchronous submit attempts cause exactly one POST and same key', async () => {
    const payload = { temperature: 29.4, measured_at: nowIso };
    const post = jest.fn().mockResolvedValue({ status: 201, accepted: true });
    const readAll = jest.fn().mockResolvedValue({ ok: true });

    const first = reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload,
      idempotencyKey: 'water-quality-key-dedupe',
      post,
      readAll,
    });

    const second = reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload,
      idempotencyKey: 'water-quality-key-dedupe',
      post,
      readAll,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(firstResult.submission.idempotencyKey).toBe('water-quality-key-dedupe');
    expect(secondResult).toBe(firstResult);
    expect(secondResult.submission.idempotencyKey).toBe('water-quality-key-dedupe');
  });

  test('two immediate form submits create one logical write with one key', async () => {
    const values = {
      temperature: '29.4',
      ph: '',
      dissolved_oxygen: '',
      ammonia: '',
      nitrite: '',
      turbidity: '',
      measured_at: nowIso,
    };
    const stateSpy = React.useState as unknown as jest.Mock;
    stateSpy.mockReset();
    const setError = jest.fn();
    const states: unknown[] = [
      [values, jest.fn()],
      [true, jest.fn()],
      [createWaterQualityDraftSignature('batch-ui', values), jest.fn()],
      [false, jest.fn()],
      [null, setError],
      [null, jest.fn()],
    ];
    states.forEach((state) => stateSpy.mockImplementationOnce(() => state));
    const guard = { current: false };
    const refSpy = React.useRef as unknown as jest.Mock;
    refSpy.mockReset().mockReturnValue(guard);

    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockResolvedValue({ status: 201, accepted: true } as never);
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({} as never);
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({} as never);
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({} as never);

    try {
      const tree = WaterQualityForm({ batchId: 'batch-ui' });
      const pressables: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(visit);
        } else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          if (element.type === Pressable) pressables.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);

      expect(pressables).toHaveLength(2);
      const submit = pressables[1].props as { onPress: () => void };
      submit.onPress();
      submit.onPress();
      expect(guard.current).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(guard.current).toBe(false);
      expect(setError).toHaveBeenCalledTimes(1);
      expect(setError).toHaveBeenCalledWith(null);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][2]).toEqual(expect.stringMatching(/^water-quality:/));
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('lost-response first attempt plus same-key replay succeeds upon read-only refresh', async () => {
    const payload = { temperature: 29.4, measured_at: nowIso };
    const post = jest.fn().mockResolvedValue({ status: 201, accepted: true });
    const readAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('first read failed'))
      .mockResolvedValueOnce({ ok: true });

    const first = await reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload,
      idempotencyKey: 'water-quality-key-replay',
      post,
      readAll,
    });

    expect(first.outcome).toBe('reconciliation_failed');

    const second = await reconcileWaterQualityWrite({
      context: { batchId: 'batch-42' },
      payload,
      idempotencyKey: 'water-quality-key-replay',
      post,
      readAll,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(second.outcome).toBe('accepted');
    expect(second.reconciled).toBe(true);
  });

  test('definitive rejection creates a fresh logical submission after material edit', () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-key-2',
      { batchName: 'B-001', farmName: 'North Farm', unitName: 'Tank 2' },
    );

    const rejected = resolveWriteOutcome({
      submission,
      status: 'http',
      accepted: false,
      response: { status: 422, detail: { code: 'validation_error' } },
    });

    expect(rejected.outcome).toBe('rejected');
    expect(rejected.retrySubmission).toBeNull();

    const edited = createWaterQualitySubmission(
      'batch-42',
      { temperature: 30.1, dissolved_oxygen: 6.4, measured_at: nowIso },
      'water-quality-key-3',
      { batchName: 'B-001', farmName: 'North Farm', unitName: 'Tank 2' },
    );

    expect(edited.idempotencyKey).not.toBe(submission.idempotencyKey);
    expect(edited.payload.temperature).toBe(30.1);
  });

  test('successful write performs the authoritative reads and exposes the correct batch target', async () => {
    const context: WaterQualityWriteContext = {
      batchId: 'batch-42',
      farmName: 'North Farm',
      unitName: 'Tank 2',
      batchName: 'B-001',
    };

    const post = jest.fn().mockResolvedValue({ status: 201, accepted: true });
    const readAll = jest.fn().mockResolvedValue({
      batch: { id: 'batch-42', code: 'B-001', state: 'active' },
      projection: { batch_id: 'batch-42', initial_stocked_quantity: 100 },
      events: [{ event_type: 'WATER_QUALITY', performed_at: nowIso }],
    });

    const result = await reconcileWaterQualityWrite({
      context,
      payload: { temperature: 29.4, measured_at: nowIso },
      idempotencyKey: 'water-quality-key-4',
      post,
      readAll,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('accepted');
    expect(result.reconciled).toBe(true);
    expect(result.posted).toBe(true);
    expect(result.submission.batchId).toBe('batch-42');
  });

  test('edits after confirmation invalidate the prior confirmation snapshot', () => {
    const initial = createWaterQualityDraftSignature('batch-42', {
      temperature: '29.4',
      measured_at: nowIso,
    });
    const edited = createWaterQualityDraftSignature('batch-42', {
      temperature: '30.1',
      measured_at: nowIso,
    });

    expect(initial).not.toBe(edited);
  });

  test('invalid timestamp input does not escape the controlled validation path', () => {
    expect(() =>
      buildWaterQualityPayload(
        { temperature: '29.4', measured_at: 'not-a-timestamp' },
        { batchId: 'batch-42' },
      ),
    ).toThrow('A measured_at timestamp is required for a water-quality record.');
  });

  test('canonical numeric bounds are enforced by the payload boundary', () => {
    expect(() =>
      buildWaterQualityPayload({ temperature: 1000, measured_at: nowIso }, { batchId: 'batch-42' }),
    ).toThrow(/temperature.*between/);

    expect(() =>
      buildWaterQualityPayload({ ph: 18, measured_at: nowIso }, { batchId: 'batch-42' }),
    ).toThrow(/ph.*between/);
  });
});
