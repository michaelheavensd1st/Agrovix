/// <reference types="jest" />

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));
jest.mock('react', () => {
  const React = jest.requireActual('react');
  return {
    ...React,
    useEffect: jest.fn(),
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
const mockSecureValues = new Map<string, string>();
const mockSecureLog: string[] = [];
const mockSecureFaults = {
  unavailable: false,
  failSet: false,
  corruptReadBack: false,
  failDelete: false,
};
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: async (key: string, value: string) => {
    mockSecureLog.push(`set:${key}`);
    if (mockSecureFaults.failSet) throw new Error('set failed');
    mockSecureValues.set(key, mockSecureFaults.corruptReadBack ? `${value} ` : value);
  },
  getItemAsync: async (key: string) => {
    if (mockSecureFaults.unavailable) throw new Error('storage unavailable');
    return mockSecureValues.get(key) ?? null;
  },
  deleteItemAsync: async (key: string) => {
    mockSecureLog.push(`delete:${key}`);
    if (mockSecureFaults.failDelete) throw new Error('delete failed');
    mockSecureValues.delete(key);
  },
}));
jest.mock('../../lib/api', () => ({
  ...jest.requireActual('../../lib/api'),
  getCurrentUser: jest.fn(),
}));
jest.mock('../../lib/production-api', () => ({
  createBatchEvent: jest.fn(),
  getBatchProjections: jest.fn(),
  getProductionBatch: jest.fn(),
  listBatchEvents: jest.fn(),
  listTransferDestinations: jest.fn(),
}));

import React from 'react';
import { Pressable, TextInput } from 'react-native';
import { FeedingForm } from '../../components/production/feeding-form';
import { HarvestForm } from '../../components/production/harvest-form';
import { MortalityForm } from '../../components/production/mortality-form';
import { SamplingForm } from '../../components/production/sampling-form';
import { StockingForm } from '../../components/production/stocking-form';
import { TransferForm } from '../../components/production/transfer-form';
import { WaterQualityForm } from '../../components/production/water-quality-form';
import { ApiError, ApiFailure, getCurrentUser } from '../../lib/api';
import * as productionApi from '../../lib/production-api';
import {
  buildWaterQualityPayload,
  buildFeedingPayload,
  buildMortalityPayload,
  buildSamplingPayload,
  buildStockingPayload,
  createFeedingDraftSignature,
  createMortalityDraftSignature,
  createSamplingDraftSignature,
  createWaterQualityDraftSignature,
  createWaterQualityIdempotencyKey,
  createWaterQualitySubmission,
  createMortalitySubmission,
  createSamplingSubmission,
  createStockingSubmission,
  getMortalityWriteRecovery,
  getSamplingWriteRecovery,
  getStockingWriteRecovery,
  clearStockingWriteRecovery,
  buildTransferPayload,
  clearTransferWriteRecovery,
  createTransferSubmission,
  getTransferWriteRecovery,
  TransferReconciliationError,
  type TransferInput,
  type TransferReaders,
  type TransferSubmission,
  clearSamplingWriteRecovery,
  normalizeMortalityObservedAt,
  normalizeProductionEventTime,
  createFeedingSubmission,
  hasActualWaterQualityMeasurement,
  isSameLogicalSubmission,
  reconcileMortalityWrite,
  reconcileSamplingWrite,
  reconcileStockingWrite,
  reconcileTransferWrite,
  reconcileWaterQualityWrite,
  reconcileFeedingWrite,
  resolveWriteOutcome,
  type WaterQualityWriteContext,
  type MortalityInput,
  type MortalitySubmission,
  type SamplingInput,
  type SamplingSubmission,
  type StockingInput,
  type StockingSubmission,
  type WaterQualityReconciliationData,
  type WaterQualitySubmission,
  type FeedingInput,
  type FeedingSubmission,
  buildHarvestPayload,
  clearHarvestWriteRecovery,
  createHarvestDraftSignature,
  createHarvestSubmission,
  getHarvestWriteRecovery,
  reconcileHarvestWrite,
  type HarvestInput,
  restoreHarvestWriteRecovery,
} from './production-write';
import * as productionWrite from './production-write';

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
    expect(first.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(first.payload).toEqual(second.payload);
  });

  test('generated idempotency keys stay within the backend column limit', () => {
    const payload = buildWaterQualityPayload(
      {
        temperature: 29.4,
        ph: 7.9,
        dissolved_oxygen: 5.6,
        ammonia: 0.15,
        nitrite: 0.02,
        turbidity: 42,
        measured_at: nowIso,
      },
      { batchId: '123e4567-e89b-42d3-a456-426614174000' },
    );

    expect(
      createWaterQualityIdempotencyKey('123e4567-e89b-42d3-a456-426614174000', payload).length,
    ).toBeLessThanOrEqual(128);
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

  test('rejects preserved water-quality submission when batch ID or key differs', () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-identity-key',
    );
    const post = jest.fn();
    const readAll = jest.fn();

    expect(() =>
      reconcileWaterQualityWrite({
        context: { batchId: 'batch-other' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(() =>
      reconcileWaterQualityWrite({
        context: { batchId: 'batch-42' },
        payload: submission.payload,
        idempotencyKey: 'water-quality-other-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(post).not.toHaveBeenCalled();
  });

  test('rejects a preserved water-quality submission with mismatched batch or key', () => {
    const submission = createWaterQualitySubmission(
      'batch-42',
      { temperature: 29.4, measured_at: nowIso },
      'water-quality-identity-key',
    );
    const post = jest.fn();
    const readAll = jest.fn();

    expect(() =>
      reconcileWaterQualityWrite({
        context: { batchId: 'batch-other' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(() =>
      reconcileWaterQualityWrite({
        context: { batchId: 'batch-42' },
        payload: submission.payload,
        idempotencyKey: 'water-quality-different-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(post).not.toHaveBeenCalled();
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
    const retryIntent = { current: null as WaterQualitySubmission | null };
    const draftRevision = { current: 0 };
    const refSpy = React.useRef as unknown as jest.Mock;
    refSpy
      .mockReset()
      .mockReturnValueOnce(guard)
      .mockReturnValueOnce(retryIntent)
      .mockReturnValueOnce(draftRevision);

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

  test('form retries the exact ambiguous submission and edits start a fresh intent', async () => {
    let currentValues: Record<string, string> = {
      temperature: '29.4',
      ph: '',
      dissolved_oxygen: '',
      ammonia: '',
      nitrite: '',
      turbidity: '',
      measured_at: nowIso,
    };
    let confirmed = true;
    let confirmedSnapshot: string | null = createWaterQualityDraftSignature(
      'batch-retry',
      currentValues,
    );
    const guard = { current: false };
    const retryIntent = { current: null as WaterQualitySubmission | null };
    const draftRevision = { current: 0 };
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const onSaved = jest.fn();
    const setError = jest.fn();
    const post = jest.mocked(productionApi.createBatchEvent);
    const networkFailure = new ApiFailure(
      'network',
      'http://localhost:8000/api',
      '/v1/batches/batch-retry/events',
      undefined,
      'TypeError',
      'Network request failed',
    );
    const eventRecord = {
      id: 'event-retry',
      event_type: 'WATER_QUALITY',
      batch_id: 'batch-retry',
    };
    post
      .mockReset()
      .mockRejectedValueOnce(networkFailure)
      .mockRejectedValueOnce(networkFailure)
      .mockResolvedValue(eventRecord as never);
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-retry' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({ batch_id: 'batch-retry' });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: [],
      next_cursor: null,
      limit: 25,
    });

    const configureHooks = () => {
      stateSpy.mockReset();
      const hooks = [
        [
          currentValues,
          (update: (current: Record<string, string>) => Record<string, string>) => {
            currentValues = update(currentValues);
          },
        ],
        [confirmed, (value: boolean) => (confirmed = value)],
        [confirmedSnapshot, (value: string | null) => (confirmedSnapshot = value)],
        [false, jest.fn()],
        [null, setError],
        [null, jest.fn()],
      ];
      hooks.forEach((hook) => stateSpy.mockImplementationOnce(() => hook));
      refSpy
        .mockReset()
        .mockReturnValueOnce(guard)
        .mockReturnValueOnce(retryIntent)
        .mockReturnValueOnce(draftRevision);
    };
    const renderForm = () => {
      configureHooks();
      const tree = WaterQualityForm({ batchId: 'batch-retry', onSaved });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(visit);
        } else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const submitForm = (elements: React.ReactElement[]) => {
      const pressables = elements.filter((element) => element.type === Pressable);
      (pressables[1].props as { onPress: () => void }).onPress();
    };
    const reconcileSpy = jest.spyOn(productionWrite, 'reconcileWaterQualityWrite');

    try {
      submitForm(renderForm());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(retryIntent.current).not.toBeNull();
      const preservedSubmission = retryIntent.current;
      const originalKey = post.mock.calls[0][2];

      submitForm(renderForm());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reconcileSpy.mock.calls[1][0].submission).toBe(preservedSubmission);
      expect(post.mock.calls[1][2]).toBe(originalKey);
      expect(retryIntent.current).toBe(preservedSubmission);

      const editedElements = renderForm();
      const textInputs = editedElements.filter((element) => element.type === TextInput);
      (textInputs[1].props as { onChangeText: (value: string) => void }).onChangeText('30.1');
      expect(retryIntent.current).toBeNull();

      const confirmationElements = renderForm();
      const pressables = confirmationElements.filter((element) => element.type === Pressable);
      (pressables[0].props as { onPress: () => void }).onPress();
      submitForm(renderForm());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls[2][2]).not.toBe(originalKey);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onSaved.mock.calls[0][0].idempotencyKey).toBe(post.mock.calls[2][2]);
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
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(second.outcome).toBe('accepted');
    expect(second.reconciled).toBe(true);
    expect(second.submission).toBe(first.retrySubmission);
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

  test('accepts a resolved event record and returns authoritative reconciliation data', async () => {
    const context: WaterQualityWriteContext = {
      batchId: 'batch-42',
      farmName: 'North Farm',
      unitName: 'Tank 2',
      batchName: 'B-001',
    };

    const eventRecord = { id: 'event-42', event_type: 'WATER_QUALITY', batch_id: 'batch-42' };
    const post = jest.fn().mockResolvedValue(eventRecord);
    const reconciliation = {
      batch: { id: 'batch-42', code: 'B-001', state: 'active' },
      projection: { batch_id: 'batch-42', initial_stocked_quantity: 100 },
      events: [{ event_type: 'WATER_QUALITY', performed_at: nowIso }],
    };
    const readAll = jest.fn().mockResolvedValue(reconciliation);

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
    expect(result.reconciliation).toEqual(reconciliation);
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

describe('feeding write workflow', () => {
  const feedContext = { batchId: 'batch-feed', batchName: 'B-FEED' };
  const reconciliation = {
    batch: { id: 'batch-feed', code: 'B-FEED', state: 'active' },
    projection: { batch_id: 'batch-feed', total_feed_kg: 2.5 },
    events: [{ event_type: 'FEEDING', performed_at: '2026-09-26T08:00:00Z' }],
  };

  test('validates feed identity, quantity, units, method, and optional round', () => {
    expect(buildFeedingPayload({ feed_description: 'Grower crumble', quantity: '2.5' })).toEqual({
      feed_description: 'Grower crumble',
      quantity: 2.5,
      unit: 'kg',
      feeding_method: 'broadcast',
    });
    expect(
      buildFeedingPayload({
        feed_item_ref: 'FEED-01',
        quantity: 500,
        unit: 'g',
        feeding_method: 'tray',
        feeding_round: '2',
      }),
    ).toMatchObject({
      feed_item_ref: 'FEED-01',
      quantity: 500,
      unit: 'g',
      feeding_method: 'tray',
      feeding_round: 2,
    });
    expect(() => buildFeedingPayload({ quantity: 0 })).toThrow(/feed item reference|description/);
    expect(() => buildFeedingPayload({ feed_description: 'x', quantity: 0 })).toThrow(
      /greater than zero/,
    );
    expect(() => buildFeedingPayload({ feed_description: 'x', quantity: 1, unit: 'lb' })).toThrow(
      /unit/,
    );
    expect(() =>
      buildFeedingPayload({ feed_description: 'x', quantity: 1, feeding_round: 0 }),
    ).toThrow(/feeding_round/);
  });

  test('accepts a resolved event, reconciles authoritative state, and stays within key limit', async () => {
    const submission = createFeedingSubmission(
      'batch-feed',
      { feed_description: 'Grower crumble', quantity: 2.5 },
      'feeding-key-1',
      feedContext,
    );
    const result = await reconcileFeedingWrite({
      context: feedContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post: jest.fn().mockResolvedValue({ id: 'event-feed', event_type: 'FEEDING' }),
      readAll: jest.fn().mockResolvedValue(reconciliation),
    });
    expect(submission.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(result.outcome).toBe('accepted');
    expect(result.reconciliation).toEqual(reconciliation);
  });

  test('rejects preserved feeding submission when batch ID or key differs', () => {
    const submission = createFeedingSubmission(
      'batch-feed',
      { feed_description: 'Grower crumble', quantity: 2.5 },
      'feeding-identity-key',
      feedContext,
    );
    const post = jest.fn();
    const readAll = jest.fn();

    expect(() =>
      reconcileFeedingWrite({
        context: { batchId: 'batch-other' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(() =>
      reconcileFeedingWrite({
        context: feedContext,
        payload: submission.payload,
        idempotencyKey: 'feeding-other-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(post).not.toHaveBeenCalled();
  });

  test('rejects a preserved feeding submission with mismatched batch or key', () => {
    const submission = createFeedingSubmission(
      'batch-feed',
      { feed_description: 'Grower crumble', quantity: 2.5 },
      'feeding-identity-key',
      feedContext,
    );
    const post = jest.fn();
    const readAll = jest.fn();

    expect(() =>
      reconcileFeedingWrite({
        context: { batchId: 'batch-other' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(() =>
      reconcileFeedingWrite({
        context: feedContext,
        payload: submission.payload,
        idempotencyKey: 'feeding-different-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/does not match the current intent/);
    expect(post).not.toHaveBeenCalled();
  });

  test('generates a compact feeding key and classifies a real 409 as rejected', async () => {
    const generated = createFeedingSubmission('batch-feed', {
      feed_description: 'Grower crumble',
      quantity: 2.5,
    });
    expect(generated.idempotencyKey.length).toBeLessThanOrEqual(128);

    const result = await reconcileFeedingWrite({
      context: feedContext,
      payload: generated.payload,
      idempotencyKey: generated.idempotencyKey,
      submission: generated,
      post: jest
        .fn()
        .mockRejectedValue(
          new ApiFailure(
            'http',
            'http://localhost:8000/api',
            '/v1/batches/batch-feed/events',
            409,
            'ApiError',
            'Conflict',
          ),
        ),
      readAll: jest.fn(),
    });
    expect(result.outcome).toBe('rejected');
    expect(result.retrySubmission).toBeNull();
  });

  test('feeding form preserves submission after a post-response contract failure', async () => {
    const values = {
      feed_description: 'Grower crumble',
      feed_item_ref: '',
      quantity: '2.5',
      unit: 'kg',
      feeding_method: 'broadcast',
      feeding_round: '',
    };
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const retryRef = { current: null as FeedingSubmission | null };
    const errorSetter = jest.fn();
    const post = jest.mocked(productionApi.createBatchEvent);
    post
      .mockReset()
      .mockRejectedValue(
        new ApiFailure(
          'application',
          'http://localhost:8000/api',
          '/v1/batches/batch-feed/events',
          undefined,
          'ApiContractError',
          'Invalid response contract',
        ),
      );
    const setters = [jest.fn(), jest.fn(), jest.fn(), jest.fn(), errorSetter, jest.fn()];
    stateSpy.mockReset();
    [
      [values, setters[0]],
      [true, setters[1]],
      [createFeedingDraftSignature('batch-feed', values as unknown as FeedingInput), setters[2]],
      [false, setters[3]],
      [null, setters[4]],
      [null, setters[5]],
    ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
    refSpy
      .mockReset()
      .mockReturnValueOnce({ current: false })
      .mockReturnValueOnce(retryRef)
      .mockReturnValueOnce({ current: 0 });

    try {
      const tree = FeedingForm({ batchId: 'batch-feed' });
      const pressables: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          if (element.type === Pressable) pressables.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      (pressables[pressables.length - 1].props as { onPress: () => void }).onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(retryRef.current).toMatchObject({
        batchId: 'batch-feed',
        payload: {
          feed_description: 'Grower crumble',
          quantity: 2.5,
          unit: 'kg',
          feeding_method: 'broadcast',
        },
      });
      expect(retryRef.current?.idempotencyKey).toMatch(/^feeding:/);
      expect(errorSetter).toHaveBeenCalledWith(
        'The feeding write outcome is uncertain. The immutable submission has been preserved for retry with the same key.',
      );
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('coalesces concurrent feeding submissions with one POST and one result', async () => {
    const submission = createFeedingSubmission(
      'batch-feed',
      { feed_description: 'Grower crumble', quantity: 2.5 },
      'feeding-key-concurrent',
      feedContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-feed', event_type: 'FEEDING' });
    const first = reconcileFeedingWrite({
      context: feedContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll: jest.fn().mockResolvedValue(reconciliation),
    });
    const second = reconcileFeedingWrite({
      context: feedContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll: jest.fn().mockResolvedValue(reconciliation),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe(firstResult);
  });

  test('feeding form reuses K1 for unchanged retry and creates K2 after edit', async () => {
    let values: Record<string, string> = {
      feed_description: 'Grower crumble',
      feed_item_ref: '',
      quantity: '2.5',
      unit: 'kg',
      feeding_method: 'broadcast',
      feeding_round: '',
    };
    let confirmed = true;
    let confirmedSnapshot = createFeedingDraftSignature(
      'batch-feed',
      values as unknown as FeedingInput,
    );
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const retryRef = { current: null as FeedingSubmission | null };
    const guard = { current: false };
    const revision = { current: 0 };
    const post = jest.mocked(productionApi.createBatchEvent);
    const setError = jest.fn();
    post
      .mockReset()
      .mockRejectedValueOnce(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-feed/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      )
      .mockRejectedValueOnce(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-feed/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      )
      .mockResolvedValue({ id: 'event-feed', event_type: 'FEEDING' } as never);
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-feed' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({ batch_id: 'batch-feed' });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: [],
      next_cursor: null,
      limit: 25,
    });
    const onSaved = jest.fn();

    const renderForm = () => {
      const setters = [
        (update: (current: Record<string, string>) => Record<string, string>) => {
          values = update(values);
        },
        (value: boolean) => {
          confirmed = value;
        },
        (value: string | null) => {
          confirmedSnapshot = value ?? '';
        },
        jest.fn(),
        jest.fn(),
        jest.fn(),
      ];
      stateSpy.mockReset();
      [
        [values, setters[0]],
        [confirmed, setters[1]],
        [confirmedSnapshot, setters[2]],
        [false, setters[3]],
        [null, setError],
        [null, setters[5]],
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy
        .mockReset()
        .mockReturnValueOnce(guard)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision);
      const form = FeedingForm({ batchId: 'batch-feed', onSaved });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(form);
      return elements;
    };
    const pressablesFor = (elements: React.ReactElement[]) =>
      elements.filter((element) => element.type === Pressable);
    const inputsFor = (elements: React.ReactElement[]) =>
      elements.filter((element) => element.type === TextInput);

    const first = pressablesFor(renderForm());
    (first[first.length - 1].props as { onPress: () => void }).onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const key1 = post.mock.calls[0][2];
    expect(key1).toBeTruthy();
    expect(retryRef.current?.idempotencyKey).toBe(key1);

    const second = pressablesFor(renderForm());
    (second[second.length - 1].props as { onPress: () => void }).onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post.mock.calls[1][2]).toBe(key1);
    expect((post.mock.calls[1][1] as { data: Record<string, unknown> }).data).toMatchObject({
      feed_description: 'Grower crumble',
      quantity: 2.5,
    });

    const edited = renderForm();
    const editedInputs = inputsFor(edited);
    (editedInputs[2].props as { onChangeText: (value: string) => void }).onChangeText('3.5');
    expect(retryRef.current).toBeNull();

    const reconfirm = pressablesFor(renderForm());
    (reconfirm[reconfirm.length - 2].props as { onPress: () => void }).onPress();
    const final = pressablesFor(renderForm());
    (final[final.length - 1].props as { onPress: () => void }).onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const key2 = post.mock.calls[2][2];
    expect(key2).not.toBe(key1);
    expect((post.mock.calls[2][1] as { data: Record<string, unknown> }).data).toMatchObject({
      feed_description: 'Grower crumble',
      quantity: 3.5,
    });
    expect(onSaved).toHaveBeenCalledTimes(1);

    const duplicate = pressablesFor(renderForm());
    (duplicate[duplicate.length - 1].props as { onPress: () => void }).onPress();
    expect(post).toHaveBeenCalledTimes(3);
    expect(setError).toHaveBeenLastCalledWith(
      'Please confirm the feeding record before submission.',
    );
  });

  test('feeding form visibly distinguishes selected unit and feeding method', () => {
    const values = {
      feed_description: 'Grower crumble',
      feed_item_ref: '',
      quantity: '2.5',
      unit: 'g',
      feeding_method: 'hand',
      feeding_round: '',
    };
    const stateSpy = React.useState as unknown as jest.Mock;
    stateSpy.mockReset();
    [values, false, null, false, null, null].forEach((value) =>
      stateSpy.mockImplementationOnce(() => [value, jest.fn()]),
    );
    const refSpy = React.useRef as unknown as jest.Mock;
    refSpy
      .mockReset()
      .mockReturnValueOnce({ current: false })
      .mockReturnValueOnce({ current: null })
      .mockReturnValueOnce({ current: 0 });

    const pressables: React.ReactElement[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (React.isValidElement(node)) {
        const element = node as React.ReactElement<{ children?: unknown }>;
        if (element.type === Pressable) pressables.push(element);
        visit(element.props.children);
      }
    };
    visit(FeedingForm({ batchId: 'batch-feed' }));
    const labelsFor = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(labelsFor);
      if (typeof node === 'string' || typeof node === 'number') return [String(node)];
      if (React.isValidElement(node)) {
        return labelsFor((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return [];
    };
    const childrenFor = (element: React.ReactElement) =>
      (element as React.ReactElement<{ children?: unknown }>).props.children;
    const option = (label: string) =>
      pressables.find((element) => labelsFor(childrenFor(element)).includes(label));
    const hasSelectedStyle = (element: React.ReactElement | undefined) => {
      const style = (element as React.ReactElement<{ style?: unknown }> | undefined)?.props.style;
      return (
        Array.isArray(style) &&
        style.some(
          (style: unknown) =>
            typeof style === 'object' &&
            style !== null &&
            'borderWidth' in style &&
            'backgroundColor' in style,
        )
      );
    };

    expect(hasSelectedStyle(option('g'))).toBe(true);
    expect(hasSelectedStyle(option('kg'))).toBe(false);
    expect(hasSelectedStyle(option('hand'))).toBe(true);
    expect(hasSelectedStyle(option('broadcast'))).toBe(false);
  });

  test('coalesces same-key writes and reuses ambiguous submission without reposting after reads fail', async () => {
    const submission = createFeedingSubmission(
      'batch-feed',
      { feed_description: 'Grower crumble', quantity: 2.5 },
      'feeding-key-retry',
      feedContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-feed', event_type: 'FEEDING' });
    const readAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(reconciliation);
    const first = await reconcileFeedingWrite({
      context: feedContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('reconciliation_failed');
    const second = await reconcileFeedingWrite({
      context: feedContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(second.outcome).toBe('accepted');
    expect(second.submission).toBe(first.retrySubmission);
  });
});

describe('mortality write workflow', () => {
  const mortalityContext: WaterQualityWriteContext = {
    batchId: 'batch-mortality',
    batchName: 'B-MORT',
    farmName: 'North Farm',
    unitName: 'Pond 3',
  };
  const mortalityInput: MortalityInput = {
    count: '3',
    observed_at: '2026-09-26T08:30',
    suspected_cause: 'Low dissolved oxygen',
    disposal_method: 'compost',
    evidence: {
      photos: ['photo://evidence-1'],
      lab_report_ref: 'LAB-17',
      veterinarian_id: 'VET-4',
      notes: 'Sample retained for review',
    },
  };
  const mortalityReconciliation = {
    batch: { id: 'batch-mortality', code: 'B-MORT', state: 'active' },
    projection: {
      batch_id: 'batch-mortality',
      initial_stocked_quantity: 100,
      cumulative_mortality: 3,
      estimated_remaining_population: 97,
    },
    events: [{ event_type: 'MORTALITY', performed_at: '2026-09-26T08:30:00.000Z' }],
  };

  test('builds exact canonical MORTALITY data and binds intent to batch and payload', () => {
    const payload = buildMortalityPayload(mortalityInput);
    expect(payload).toEqual({
      count: 3,
      observed_at: normalizeMortalityObservedAt(mortalityInput.observed_at),
      suspected_cause: 'Low dissolved oxygen',
      disposal_method: 'compost',
      evidence: {
        photos: ['photo://evidence-1'],
        lab_report_ref: 'LAB-17',
        veterinarian_id: 'VET-4',
        notes: 'Sample retained for review',
      },
    });
    expect(buildMortalityPayload({ ...mortalityInput, count: '1' }).count).toBe(1);
    expect(buildMortalityPayload({ ...mortalityInput, count: '100' }).count).toBe(100);
    expect(buildMortalityPayload({ ...mortalityInput, count: '101' }).count).toBe(101);
    const signature = createMortalityDraftSignature('batch-mortality', mortalityInput);
    expect(signature).toContain('batch-mortality');
    expect(signature).toContain('Low dissolved oxygen');
    expect(
      createMortalityDraftSignature('batch-mortality', {
        ...mortalityInput,
        count: 4,
      }),
    ).not.toBe(signature);
  });

  test('rejects nonpositive/noninteger counts, invalid timestamps, enum values, and overlong fields', () => {
    for (const count of [0, -1, 1.5, '2.2']) {
      expect(() => buildMortalityPayload({ ...mortalityInput, count })).toThrow(/positive integer/);
    }
    expect(() => buildMortalityPayload({ ...mortalityInput, observed_at: 'not-a-time' })).toThrow(
      /observed_at/,
    );
    expect(() =>
      buildMortalityPayload({ ...mortalityInput, observed_at: '2026-02-30T08:30' }),
    ).toThrow(/observed_at/);
    expect(
      buildMortalityPayload({ ...mortalityInput, observed_at: '2024-02-29T08:30' }).observed_at,
    ).toBe(new Date('2024-02-29T08:30').toISOString());
    expect(() => buildMortalityPayload({ ...mortalityInput, disposal_method: 'dumping' })).toThrow(
      /disposal_method/,
    );
    expect(() =>
      buildMortalityPayload({ ...mortalityInput, suspected_cause: 'x'.repeat(256) }),
    ).toThrow(/suspected_cause/);
    expect(() =>
      buildMortalityPayload({
        ...mortalityInput,
        evidence: { notes: 'x'.repeat(1001) },
      }),
    ).toThrow(/evidence.notes/);
  });

  test('interprets timezone-free observed_at as local time and preserves explicit instants', () => {
    const localObservedAt = new Date('2026-09-26T08:30');
    const localLeapDay = new Date('2024-02-29T08:30');
    expect(normalizeMortalityObservedAt('2026-09-26T08:30')).toBe(localObservedAt.toISOString());
    expect(normalizeMortalityObservedAt('2026-09-26T08:30:45.123')).toBe(
      new Date('2026-09-26T08:30:45.123').toISOString(),
    );
    expect(normalizeMortalityObservedAt('2026-09-26T08:30Z')).toBe('2026-09-26T08:30:00.000Z');
    expect(normalizeMortalityObservedAt('2026-09-26T08:30+02:30')).toBe('2026-09-26T06:00:00.000Z');
    expect(normalizeMortalityObservedAt('2024-02-29T08:30')).toBe(localLeapDay.toISOString());
    if (new Date('2026-03-08T02:30').getHours() !== 2) {
      expect(normalizeMortalityObservedAt('2026-03-08T02:30')).toBeNull();
    }
    expect(normalizeMortalityObservedAt('0000-02-29T08:30')).toBeNull();
  });

  test('keeps a compact immutable submission and rejects batch/key identity mismatches', () => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      undefined,
      mortalityContext,
    );
    expect(submission.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(submission.context.batchId).toBe(mortalityContext.batchId);

    const post = jest.fn();
    const readAll = jest.fn();
    expect(() =>
      reconcileMortalityWrite({
        context: { ...mortalityContext, batchId: 'another-batch' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/current intent/);
    expect(() =>
      reconcileMortalityWrite({
        context: mortalityContext,
        payload: submission.payload,
        idempotencyKey: 'different-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/current intent/);
    expect(post).not.toHaveBeenCalled();
  });

  test('accepts a resolved/replayed event and uses only authoritative reconciliation projections', async () => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      'mortality-accepted-key',
      mortalityContext,
    );
    const eventRecord = {
      id: 'event-mortality',
      event_type: 'MORTALITY',
      batch_id: mortalityContext.batchId,
      performed_by_id: 'server-actor',
      data: submission.payload,
    };
    const post = jest.fn().mockResolvedValue(eventRecord);
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);
    const result = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });

    expect(post).toHaveBeenCalledWith(
      mortalityContext.batchId,
      'MORTALITY',
      submission.payload,
      submission.idempotencyKey,
      submission.performedAt,
    );
    expect(result.outcome).toBe('accepted');
    expect(result.reconciliation).toEqual(mortalityReconciliation);
    expect(result.reconciliation?.projection.estimated_remaining_population).toBe(97);
    expect(result.submission.payload.count).toBe(3);
    expect(result.submission.payload).not.toHaveProperty('performed_by_id');

    const replay = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(replay.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
  });

  test('does not reuse a settled mortality result for a different payload under the same key', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);
    const first = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: mortalityInput,
      idempotencyKey: 'mortality-settled-identity-key',
      post,
      readAll,
    });
    expect(first.outcome).toBe('accepted');

    const differentIntent = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: { ...mortalityInput, count: 4 },
      idempotencyKey: 'mortality-settled-identity-key',
      post,
      readAll,
    });
    expect(differentIntent.outcome).toBe('write_failed');
    expect(differentIntent.posted).toBe(false);
    expect(readAll).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('treats a different normalized observation instant as a different same-key submission', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);
    const first = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: { ...mortalityInput, observed_at: '2026-09-26T08:30Z' },
      idempotencyKey: 'mortality-same-key-different-time',
      post,
      readAll,
    });
    const differentTime = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: { ...mortalityInput, observed_at: '2026-09-26T09:30Z' },
      idempotencyKey: 'mortality-same-key-different-time',
      post,
      readAll,
    });

    expect(first.outcome).toBe('accepted');
    expect(differentTime.outcome).toBe('write_failed');
    expect(differentTime.posted).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('ambiguous retry preserves the exact submission and key', async () => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      'mortality-ambiguous-key',
      mortalityContext,
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      )
      .mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);
    const first = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);

    const retry = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][3]).toBe(submission.idempotencyKey);
    expect(post.mock.calls[1][3]).toBe(submission.idempotencyKey);
    expect(post.mock.calls.map((call) => call[4])).toEqual([
      submission.performedAt,
      submission.performedAt,
    ]);
    expect(retry.submission).toBe(submission);
  });

  test.each([
    [
      'HTTP 503',
      new ApiFailure(
        'http',
        'http://localhost:8000/api',
        '/v1/batches/batch-mortality/events',
        503,
        'ApiError',
        'Service unavailable',
      ),
      'mortality-http-503-key',
    ],
    [
      'post-response contract failure',
      new ApiFailure(
        'application',
        'http://localhost:8000/api',
        '/v1/batches/batch-mortality/events',
        undefined,
        'ApiContractError',
        'Invalid event response contract',
      ),
      'mortality-contract-failure-key',
    ],
  ])('%s preserves the immutable submission for same-key retry', async (_name, failure, key) => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      key,
      mortalityContext,
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);

    const first = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);

    const retry = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(retry.submission).toBe(submission);
    expect(post.mock.calls.map((call) => call[3])).toEqual([key, key]);
    expect(post.mock.calls.map((call) => call[4])).toEqual([
      submission.performedAt,
      submission.performedAt,
    ]);
  });

  test.each([409, 422])('does not retry a definitive HTTP %s rejection', async (status) => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      `mortality-definitive-${status}`,
      mortalityContext,
    );
    const post = jest
      .fn()
      .mockRejectedValue(
        new ApiFailure(
          'http',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          status,
          'ApiError',
          'Rejected',
        ),
      );
    const result = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll: jest.fn(),
    });
    expect(result.outcome).toBe('rejected');
    expect(result.retrySubmission).toBeNull();
  });

  test('coalesces concurrent same-key mortality calls into one POST', async () => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      'mortality-concurrent-key',
      mortalityContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest.fn().mockResolvedValue(mortalityReconciliation);
    const args = {
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    };
    const [first, second] = await Promise.all([
      reconcileMortalityWrite(args),
      reconcileMortalityWrite(args),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  test('reconciliation failure retries reads only and never reposts mortality', async () => {
    const submission = createMortalitySubmission(
      mortalityContext.batchId,
      mortalityInput,
      'mortality-readonly-retry-key',
      mortalityContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-mortality', event_type: 'MORTALITY' });
    const readAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue(mortalityReconciliation);
    const first = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('reconciliation_failed');
    expect(first.posted).toBe(true);
    expect(first.retrySubmission).toBe(submission);

    const retry = await reconcileMortalityWrite({
      context: mortalityContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(retry.reconciled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
  });

  test('mortality form initializes observed_at from the device-local clock', () => {
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-26T15:30:00.000Z'));
    stateSpy
      .mockReset()
      .mockImplementation((initial: unknown) => [
        typeof initial === 'function' ? (initial as () => unknown)() : initial,
        jest.fn(),
      ]);
    refSpy.mockReset().mockImplementation((initial: unknown) => ({ current: initial }));

    try {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const expectedLocalTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      expect(MortalityForm({ batchId: 'batch-mortality' })).toBeTruthy();
      const initializedValues = stateSpy.mock.results[0].value[0];
      expect(initializedValues).toMatchObject({ observed_at: expectedLocalTime });
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  test.each([
    ['UTC Z timestamp', '2026-09-26T08:30Z', 'UTC', '2026-09-26T08:30:00.000Z'],
    [
      'explicit offset timestamp',
      '2026-09-26T08:30+02:30',
      'entered offset +02:30',
      '2026-09-26T06:00:00.000Z',
    ],
  ])(
    'mortality confirmation labels %s accurately',
    (_label, observedAt, expectedZone, expectedUtc) => {
      const stateSpy = React.useState as unknown as jest.Mock;
      const refSpy = React.useRef as unknown as jest.Mock;
      const effectSpy = React.useEffect as unknown as jest.Mock;
      const values: Record<string, string> = {
        count: '3',
        observed_at: observedAt,
        suspected_cause: '',
        disposal_method: '',
        photos: '',
        lab_report_ref: '',
        veterinarian_id: '',
        evidence_notes: '',
      };
      const input: MortalityInput = {
        count: '3',
        observed_at: observedAt,
        evidence: { photos: [], notes: '', lab_report_ref: '', veterinarian_id: '' },
      };
      stateSpy.mockReset();
      [
        [values, jest.fn()],
        [true, jest.fn()],
        [createMortalityDraftSignature('batch-mortality', input), jest.fn()],
        [false, jest.fn()],
        [null, jest.fn()],
        [null, jest.fn()],
        [false, jest.fn()],
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy.mockReset().mockImplementation((initial: unknown) => ({ current: initial }));
      effectSpy.mockReset().mockImplementation(() => undefined);

      const textContent = (node: unknown): string => {
        if (Array.isArray(node)) return node.map(textContent).join(' ');
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (React.isValidElement(node)) {
          return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
        }
        return '';
      };
      try {
        const tree = MortalityForm({ batchId: 'batch-mortality' });
        const preview = textContent(tree).replace(/\s+/g, ' ').trim();
        expect(preview).toContain(`Observation time ( ${expectedZone} ): ${observedAt}`);
        expect(preview).toContain(`Sent as UTC: ${expectedUtc}`);
      } finally {
        jest.restoreAllMocks();
      }
    },
  );

  test('mortality form requires explicit batch-specific confirmation and blocks stale duplicate submit', async () => {
    let values: Record<string, string> = {
      count: '3',
      observed_at: '2026-09-26T08:30Z',
      suspected_cause: 'Low dissolved oxygen',
      disposal_method: 'compost',
      photos: 'photo://evidence-1',
      lab_report_ref: 'LAB-17',
      veterinarian_id: 'VET-4',
      evidence_notes: 'Sample retained',
    };
    let confirmed = false;
    let confirmedSnapshot: string | null = null;
    let busy = false;
    let error: string | null = null;
    let statusMessage: string | null = null;
    let recoveryRequired = false;
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const submissionInFlight = { current: false };
    const retrySubmission = { current: null as MortalitySubmission | null };
    const draftRevision = { current: 0 };
    const setters = [
      (update: (current: Record<string, string>) => Record<string, string>) => {
        values = update(values);
      },
      (next: boolean) => {
        confirmed = next;
      },
      (next: string | null) => {
        confirmedSnapshot = next;
      },
      (next: boolean) => {
        busy = next;
      },
      (next: string | null) => {
        error = next;
      },
      (next: string | null) => {
        statusMessage = next;
      },
      (next: boolean) => {
        recoveryRequired = next;
      },
    ];
    let lastTree: React.ReactElement | null = null;
    const eventRecord = {
      id: 'mortality-event-1',
      event_type: 'MORTALITY',
      batch_id: 'batch-mortality',
      performed_by_id: 'server-actor',
      data: buildMortalityPayload(mortalityInput),
    };
    const post = jest.mocked(productionApi.createBatchEvent);
    post
      .mockReset()
      .mockRejectedValueOnce(
        new ApiFailure(
          'http',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          503,
          'ApiError',
          'Service unavailable',
        ),
      )
      .mockRejectedValueOnce(
        new ApiFailure(
          'application',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          undefined,
          'ApiContractError',
          'Invalid event response contract',
        ),
      )
      .mockResolvedValue(eventRecord);
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-mortality' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({
      ...mortalityReconciliation.projection,
      estimated_remaining_population: 97,
    });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: mortalityReconciliation.events,
      next_cursor: null,
      limit: 25,
    });
    const onSaved = jest.fn();

    const renderForm = () => {
      stateSpy.mockReset();
      [values, confirmed, confirmedSnapshot, busy, error, statusMessage, recoveryRequired].forEach(
        (value, index) => stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retrySubmission)
        .mockReturnValueOnce(draftRevision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      const tree = MortalityForm({
        batchId: 'batch-mortality',
        batchName: 'B-MORT',
        farmName: 'North Farm',
        siteName: 'Site 3',
        unitName: 'Pond 3',
        currentEstimatedRemainingPopulation: 100,
        onSaved,
      });
      lastTree = tree;
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(textContent);
      if (typeof node === 'string' || typeof node === 'number') return [String(node)];
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return [];
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent((element as React.ReactElement<{ children?: unknown }>).props.children)
            .join(' ')
            .includes(text),
      ) as React.ReactElement<{ onPress: () => void }>;

    try {
      const initial = renderForm();
      await buttonWithText(initial, 'Submit mortality').props.onPress();
      expect(post).not.toHaveBeenCalled();
      expect(error).toContain('confirm');

      const observedAtInput = initial.filter((element) => element.type === TextInput)[1];
      (observedAtInput.props as { onChangeText: (value: string) => void }).onChangeText(
        '2026-02-30T08:30',
      );
      const invalidDateElements = renderForm();
      await buttonWithText(invalidDateElements, 'I confirm this mortality record').props.onPress();
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(error).toContain('valid observed-at date');
      expect(post).not.toHaveBeenCalled();

      const correctedDateElements = renderForm();
      (
        correctedDateElements.filter((element) => element.type === TextInput)[1].props as {
          onChangeText: (value: string) => void;
        }
      ).onChangeText('2026-09-26T08:30');

      const confirmation = buttonWithText(renderForm(), 'I confirm this mortality record');
      confirmation.props.onPress();
      expect(confirmed).toBe(true);
      const confirmedElements = renderForm();
      const preview = textContent(lastTree).join('');
      const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const expectedObservedInstant = new Date('2026-09-26T08:30').toISOString();
      expect(preview).toContain('Mortality count: 3');
      expect(preview).toContain('Current authoritative projected population: 100');
      expect(preview).toContain('Preview only:');
      expect(preview).toContain('estimated remaining population would be 97');
      expect(preview).toContain(
        `Observation time (device local time (${localTimeZone})): 2026-09-26T08:30`,
      );
      expect(preview).toContain(`Sent as UTC: ${expectedObservedInstant}`);
      expect(preview).toContain('not editable or reversible');
      expect(preview).toContain('Cause: Low dissolved oxygen');
      expect(preview).toContain('Disposal: compost');

      const signatureSpy = jest.spyOn(productionWrite, 'createMortalityDraftSignature');
      signatureSpy.mockReturnValueOnce('changed-normalized-observed-instant');
      await buttonWithText(confirmedElements, 'Submit mortality').props.onPress();
      signatureSpy.mockRestore();
      expect(post).not.toHaveBeenCalled();
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(retrySubmission.current).toBeNull();
      expect(error).toContain('changed after confirmation');

      buttonWithText(renderForm(), 'I confirm this mortality record').props.onPress();
      const submitAfterReconfirm = buttonWithText(renderForm(), 'Submit mortality');
      submitAfterReconfirm.props.onPress();
      submitAfterReconfirm.props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe('batch-mortality');
      const postedEvent = post.mock.calls[0]?.[1] as
        { performed_at?: string; data?: Record<string, unknown> } | undefined;
      expect(postedEvent?.performed_at).toBe(normalizeMortalityObservedAt('2026-09-26T08:30'));
      expect(postedEvent?.data?.observed_at).toBe(postedEvent?.performed_at);
      const firstKey = retrySubmission.current?.idempotencyKey;
      expect(firstKey).toBeTruthy();
      expect(retrySubmission.current?.payload).toEqual(
        buildMortalityPayload({
          count: '3',
          observed_at: '2026-09-26T08:30',
          suspected_cause: 'Low dissolved oxygen',
          disposal_method: 'compost',
          evidence: {
            photos: ['photo://evidence-1'],
            lab_report_ref: 'LAB-17',
            veterinarian_id: 'VET-4',
            notes: 'Sample retained',
          },
        }),
      );
      expect(error).toContain('outcome is uncertain');

      buttonWithText(renderForm(), 'Retry previous mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map((call) => call[2])).toEqual([firstKey, firstKey]);
      expect(retrySubmission.current?.idempotencyKey).toBe(firstKey);
      expect(error).toContain('outcome is uncertain');

      const recoveryElements = renderForm();
      const recoveryInputs = recoveryElements.filter(
        (element) => element.type === TextInput,
      ) as React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>[];
      expect(recoveryInputs.every((input) => input.props.editable === false)).toBe(true);
      recoveryInputs[0].props.onChangeText('4');
      expect(values.count).toBe('3');
      expect(retrySubmission.current?.idempotencyKey).toBe(firstKey);
      await buttonWithText(recoveryElements, 'Retry previous mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls.map((call) => call[2])).toEqual([firstKey, firstKey, firstKey]);
      expect(retrySubmission.current).toBeNull();
      expect(getMortalityWriteRecovery('batch-mortality')).toBeNull();
      expect(post.mock.calls[2][1]).toMatchObject({
        event_type: 'MORTALITY',
        performed_at: normalizeMortalityObservedAt('2026-09-26T08:30'),
        data: {
          count: 3,
          observed_at: normalizeMortalityObservedAt('2026-09-26T08:30'),
          suspected_cause: 'Low dissolved oxygen',
          disposal_method: 'compost',
        },
      });
      expect(post.mock.calls[0][1].data).not.toHaveProperty('performed_at');
      expect(post.mock.calls[2][1].data).not.toHaveProperty('performed_by_id');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            batchId: 'batch-mortality',
            farmName: 'North Farm',
            siteName: 'Site 3',
            unitName: 'Pond 3',
          }),
        }),
        expect.objectContaining({
          projection: expect.objectContaining({ estimated_remaining_population: 97 }),
        }),
      );
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();

      await buttonWithText(renderForm(), 'Submit mortality').props.onPress();
      expect(post).toHaveBeenCalledTimes(3);
      expect(error).toContain('confirm');
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('mortality form clears confirmation after definitive rejection before a fresh-key attempt', async () => {
    const values: Record<string, string> = {
      count: '3',
      observed_at: '2026-09-26T08:30Z',
      suspected_cause: '',
      disposal_method: '',
      photos: '',
      lab_report_ref: '',
      veterinarian_id: '',
      evidence_notes: '',
    };
    let confirmed = true;
    let confirmedSnapshot: string | null = createMortalityDraftSignature('batch-mortality', {
      count: '3',
      observed_at: '2026-09-26T08:30Z',
      suspected_cause: '',
      disposal_method: null,
      evidence: {
        photos: [],
        lab_report_ref: '',
        veterinarian_id: '',
        notes: '',
      },
    });
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const inFlight = { current: false };
    const retryRef = { current: null as MortalitySubmission | null };
    const revision = { current: 0 };
    const setError = jest.fn();
    const setConfirmed = (value: boolean) => {
      confirmed = value;
    };
    const setSnapshot = (value: string | null) => {
      confirmedSnapshot = value;
    };
    const post = jest.mocked(productionApi.createBatchEvent);
    const refreshedReconciliation = {
      batch: { id: 'batch-mortality', state: 'active' },
      projection: {
        ...mortalityReconciliation.projection,
        estimated_remaining_population: 2,
      },
      events: [{ event_type: 'MORTALITY', performed_at: '2026-09-27T08:30:00Z' }],
    };
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue(refreshedReconciliation.batch);
    jest
      .mocked(productionApi.getBatchProjections)
      .mockResolvedValue(refreshedReconciliation.projection);
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: refreshedReconciliation.events,
      next_cursor: null,
      limit: 25,
    });
    const onConflictRefreshed = jest.fn();
    post
      .mockReset()
      .mockRejectedValue(
        new ApiFailure(
          'http',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          409,
          'ApiError',
          'mortality_exceeds_population',
        ),
      );

    const renderForm = () => {
      stateSpy.mockReset();
      [
        [values, jest.fn()],
        [confirmed, setConfirmed],
        [confirmedSnapshot, setSnapshot],
        [false, jest.fn()],
        [null, setError],
        [null, jest.fn()],
        [false, jest.fn()],
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy
        .mockReset()
        .mockReturnValueOnce(inFlight)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      const tree = MortalityForm({
        batchId: 'batch-mortality',
        batchName: 'B-MORT',
        currentEstimatedRemainingPopulation: 3,
        onConflictRefreshed,
      });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };

    try {
      const initial = renderForm();
      const buttons = initial.filter((element) => element.type === Pressable);
      (buttons[buttons.length - 1].props as { onPress: () => void }).onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][1]).toMatchObject({
        performed_at: normalizeMortalityObservedAt('2026-09-26T08:30Z'),
        data: { observed_at: normalizeMortalityObservedAt('2026-09-26T08:30Z') },
      });
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(retryRef.current).toBeNull();
      expect(onConflictRefreshed).toHaveBeenCalledWith(refreshedReconciliation);
      expect(productionApi.getBatchProjections).toHaveBeenCalledWith('batch-mortality');

      const afterRejection = renderForm();
      expect(setError).toHaveBeenCalledWith(
        'The server rejected this mortality write (409). Current authoritative population and events have been refreshed. Review them and confirm a new record before submitting.',
      );
      const retryButtons = afterRejection.filter((element) => element.type === Pressable);
      (retryButtons[retryButtons.length - 1].props as { onPress: () => void }).onPress();
      expect(post).toHaveBeenCalledTimes(1);
      expect(setError).toHaveBeenLastCalledWith(
        'Please confirm this mortality record before submission.',
      );
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('mortality write recovery across form remount', () => {
  test('reattaches to the retained promise when remounted during a pending mortality write', async () => {
    const batchId = 'batch-mortality-pending-remount';
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    let stateValues: unknown[] = [];
    let refs: Array<{ current: unknown }> = [];
    let effects: Array<() => unknown> = [];
    let stateIndex = 0;
    let refIndex = 0;
    const configureMount = () => {
      stateValues = [];
      refs = [];
      effects = [];
      stateIndex = 0;
      refIndex = 0;
      stateSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = stateIndex++;
        if (stateValues.length <= index) {
          stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        return [
          stateValues[index],
          (next: unknown) => {
            stateValues[index] =
              typeof next === 'function'
                ? (next as (current: unknown) => unknown)(stateValues[index])
                : next;
          },
        ];
      });
      refSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = refIndex++;
        if (refs.length <= index) refs.push({ current: initial });
        return refs[index];
      });
      effectSpy.mockReset().mockImplementation((effect: () => unknown) => {
        effects.push(effect);
      });
    };
    const renderForm = (onSaved: jest.Mock) => {
      stateIndex = 0;
      refIndex = 0;
      const tree = MortalityForm({ batchId, batchName: 'B-PENDING', onSaved });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;
    let resolvePost!: (event: Record<string, unknown>) => void;
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const reconciliation = {
      batch: { id: batchId, state: 'active' },
      projection: { estimated_remaining_population: 96 },
      events: [{ event_type: 'MORTALITY', performed_at: '2026-09-26T08:30:00.000Z' }],
    };
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue(reconciliation.batch);
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue(reconciliation.projection);
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: reconciliation.events,
      next_cursor: null,
      limit: 25,
    });
    const originalOnSaved = jest.fn();
    const remountedOnSaved = jest.fn();

    try {
      configureMount();
      let elements = renderForm(originalOnSaved);
      const originalCleanups = effects.slice().map((effect) => effect());
      const inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText('4');
      inputs[1].props.onChangeText('2026-09-26T08:30Z');
      elements = renderForm(originalOnSaved);
      buttonWithText(elements, 'I confirm this mortality record').props.onPress();
      elements = renderForm(originalOnSaved);
      buttonWithText(elements, 'Submit mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      const originalRecovery = getMortalityWriteRecovery(batchId);
      if (!originalRecovery?.promise) {
        throw new Error('Expected the pending mortality recovery to retain its promise.');
      }
      const originalSubmission = originalRecovery.submission;
      const retainedPromise = originalRecovery.promise;
      expect(originalRecovery.inFlight).toBe(true);
      expect(post.mock.calls[0][0]).toBe(batchId);
      expect(post.mock.calls[0][1]).toMatchObject({
        event_type: 'MORTALITY',
        performed_at: originalSubmission.performedAt,
        data: originalSubmission.payload,
      });
      expect(post.mock.calls[0][2]).toBe(originalSubmission.idempotencyKey);

      originalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
      configureMount();
      elements = renderForm(remountedOnSaved);
      const remountEffects = effects.slice();
      expect(remountEffects).toHaveLength(2);
      remountEffects.forEach((effect) => effect());
      expect(getMortalityWriteRecovery(batchId)?.promise).toBe(retainedPromise);
      expect(stateValues[3]).toBe(true);
      expect(buttonWithText(elements, 'Saving…').props.disabled).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(post).toHaveBeenCalledTimes(1);

      resolvePost({
        id: 'event-mortality-pending-remount',
        event_type: 'MORTALITY',
        batch_id: batchId,
      });
      await retainedPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls.map((call) => call[2])).toEqual([originalSubmission.idempotencyKey]);
      expect(post.mock.calls[0][1].performed_at).toBe(originalSubmission.performedAt);
      expect(post.mock.calls[0][1].data).toEqual(originalSubmission.payload);
      expect(originalOnSaved).not.toHaveBeenCalled();
      expect(remountedOnSaved).toHaveBeenCalledWith(originalSubmission, reconciliation);
      expect(stateValues[5]).toContain('Mortality has been recorded and reconciled');
      expect(getMortalityWriteRecovery(batchId)).toBeNull();
      effects.forEach((effect) => {
        const cleanup = effect();
        if (typeof cleanup === 'function') cleanup();
      });
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('rehydrates unresolved identity after remount and retries the original submission', async () => {
    const batchId = 'batch-mortality-remount';
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    let stateValues: unknown[] = [];
    let refs: Array<{ current: unknown }> = [];
    let effects: Array<() => unknown> = [];
    let stateIndex = 0;
    let refIndex = 0;
    const configureMount = () => {
      stateValues = [];
      refs = [];
      effects = [];
      stateIndex = 0;
      refIndex = 0;
      stateSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = stateIndex++;
        if (stateValues.length <= index) {
          stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        return [
          stateValues[index],
          (next: unknown) => {
            stateValues[index] =
              typeof next === 'function'
                ? (next as (current: unknown) => unknown)(stateValues[index])
                : next;
          },
        ];
      });
      refSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = refIndex++;
        if (refs.length <= index) refs.push({ current: initial });
        return refs[index];
      });
      effectSpy.mockReset().mockImplementation((effect: () => unknown) => {
        effects.push(effect);
      });
    };
    const renderForm = () => {
      stateIndex = 0;
      refIndex = 0;
      const tree = MortalityForm({ batchId, batchName: 'B-REMOUNT' });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;
    let rejectPost!: (error: unknown) => void;
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPost = reject;
        }),
    );
    jest
      .mocked(productionApi.getProductionBatch)
      .mockResolvedValue({ id: batchId, state: 'active' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({
      estimated_remaining_population: 96,
    });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: [],
      next_cursor: null,
      limit: 25,
    });

    try {
      configureMount();
      let elements = renderForm();
      expect(effects).toHaveLength(2);
      const originalCleanups = effects.map((effect) => effect());

      const inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText('4');
      inputs[1].props.onChangeText('2026-09-26T08:30');
      inputs[2].props.onChangeText('Low dissolved oxygen');
      elements = renderForm();
      buttonWithText(elements, 'I confirm this mortality record').props.onPress();
      elements = renderForm();
      buttonWithText(elements, 'Submit mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(1);
      const originalKey = post.mock.calls[0][2];
      const originalPerformedAt = post.mock.calls[0][1].performed_at;
      expect(originalKey).toBeTruthy();
      expect(post.mock.calls[0][1].data).toMatchObject({
        count: 4,
        suspected_cause: 'Low dissolved oxygen',
      });
      originalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });

      rejectPost(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          `/v1/batches/${batchId}/events`,
          undefined,
          'TypeError',
          'Network request failed',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const recovered = getMortalityWriteRecovery(batchId);
      expect(recovered?.inFlight).toBe(false);
      expect(recovered?.retryOutcome).toBe('outcome_unknown');
      expect(recovered?.submission.idempotencyKey).toBe(originalKey);
      expect(getMortalityWriteRecovery('different-mortality-batch')).toBeNull();

      configureMount();
      elements = renderForm();
      const remountCleanups = effects.map((effect) => effect());
      const remountedInputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ editable?: boolean }>
      >;
      expect(stateValues[0]).toMatchObject({
        count: '4',
        observed_at: recovered?.submission.performedAt,
        suspected_cause: 'Low dissolved oxygen',
      });
      expect(remountedInputs.every((input) => input.props.editable === false)).toBe(true);
      const recoveredText = textContent(elements).replace(/\s+/g, ' ');
      expect(recoveredText).toContain('uncertain outcome');
      expect(recoveredText).toContain('Mortality count: 4');
      expect(recoveredText).toContain(`Sent as UTC: ${recovered?.submission.performedAt}`);
      expect(buttonWithText(elements, 'Retry previous mortality').props.disabled).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);

      post.mockResolvedValueOnce({
        id: 'event-mortality-remount',
        event_type: 'MORTALITY',
        batch_id: batchId,
      });
      buttonWithText(elements, 'Retry previous mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map((call) => call[2])).toEqual([originalKey, originalKey]);
      expect(post.mock.calls.map((call) => call[1].performed_at)).toEqual([
        originalPerformedAt,
        originalPerformedAt,
      ]);
      expect(post.mock.calls[1][1].data).toEqual(post.mock.calls[0][1].data);
      expect(getMortalityWriteRecovery(batchId)).toBeNull();
      remountCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('mortality in-flight draft lock', () => {
  test('mortality draft stays locked during an unresolved POST and unlocks with the exact ambiguous retry', async () => {
    let values: Record<string, string> = {
      count: '3',
      observed_at: '2026-09-26T08:30Z',
      suspected_cause: '',
      disposal_method: '',
      photos: '',
      lab_report_ref: '',
      veterinarian_id: '',
      evidence_notes: '',
    };
    let confirmed = false;
    let confirmedSnapshot: string | null = null;
    let busy = false;
    let recoveryRequired = false;
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const submissionInFlight = { current: false };
    const retryRef = { current: null as MortalitySubmission | null };
    const revision = { current: 0 };
    const setters = [
      (update: (current: Record<string, string>) => Record<string, string>) => {
        values = update(values);
      },
      (next: boolean) => {
        confirmed = next;
      },
      (next: string | null) => {
        confirmedSnapshot = next;
      },
      (next: boolean) => {
        busy = next;
      },
      jest.fn(),
      jest.fn(),
      (next: boolean) => {
        recoveryRequired = next;
      },
    ];
    let rejectPost!: (error: unknown) => void;
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPost = reject;
        }),
    );
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-mortality' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({
      estimated_remaining_population: 97,
    });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: [{ event_type: 'MORTALITY', performed_at: '2026-09-26T08:30:00.000Z' }],
      next_cursor: null,
      limit: 25,
    });

    const renderForm = () => {
      stateSpy.mockReset();
      [values, confirmed, confirmedSnapshot, busy, null, null, recoveryRequired].forEach(
        (value, index) => stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      const tree = MortalityForm({ batchId: 'batch-mortality', batchName: 'B-MORT' });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;

    try {
      const initial = renderForm();
      buttonWithText(initial, 'I confirm this mortality record').props.onPress();
      const confirmedElements = renderForm();
      buttonWithText(confirmedElements, 'Submit mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(1);
      expect(busy).toBe(true);
      expect(submissionInFlight.current).toBe(true);

      const busyElements = renderForm();
      const busyInputs = busyElements.filter(
        (element) => element.type === TextInput,
      ) as React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>[];
      expect(busyInputs.every((input) => input.props.editable === false)).toBe(true);
      const busyConfirm = buttonWithText(busyElements, 'I confirm this mortality record');
      expect(busyConfirm.props.disabled).toBe(true);
      const busyDisposal = buttonWithText(busyElements, 'burial');
      expect(busyDisposal.props.disabled).toBe(true);
      busyInputs[0].props.onChangeText('99');
      busyConfirm.props.onPress();
      busyDisposal.props.onPress();
      expect(values.count).toBe('3');
      expect(values.disposal_method).toBe('');
      expect(confirmed).toBe(true);
      expect(revision.current).toBe(0);
      expect(retryRef.current).toBeNull();

      const submittedKey = post.mock.calls[0][2];
      const submittedPerformedAt = post.mock.calls[0][1].performed_at;
      rejectPost(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-mortality/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(busy).toBe(false);
      expect(submissionInFlight.current).toBe(false);
      expect(retryRef.current?.idempotencyKey).toBe(submittedKey);
      expect(retryRef.current?.performedAt).toBe(submittedPerformedAt);
      expect(retryRef.current?.payload.count).toBe(3);

      const recoveryElements = renderForm();
      const recoveryInputs = recoveryElements.filter(
        (element) => element.type === TextInput,
      ) as React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>[];
      expect(recoveryInputs.every((input) => input.props.editable === false)).toBe(true);
      recoveryInputs[0].props.onChangeText('4');
      expect(values.count).toBe('3');
      expect(retryRef.current?.idempotencyKey).toBe(submittedKey);

      post.mockResolvedValueOnce({ id: 'event-mortality-recovered', event_type: 'MORTALITY' });
      await buttonWithText(recoveryElements, 'Retry previous mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map((call) => call[2])).toEqual([submittedKey, submittedKey]);
      expect(post.mock.calls[1][1].performed_at).toBe(submittedPerformedAt);
      expect(retryRef.current).toBeNull();
      expect(getMortalityWriteRecovery('batch-mortality')).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });
});
describe('stocking write workflow', () => {
  const stockingContext: WaterQualityWriteContext = {
    batchId: 'batch-stocking',
    batchName: 'B-STOCK',
    farmName: 'North Farm',
    unitName: 'Pond 1',
  };
  const stockingInput: StockingInput = {
    species_code: 'WHITE_SHRIMP',
    quantity: '25000',
    average_weight: '0.02',
    weight_unit: 'g',
    stocked_at: '2026-10-04T08:30',
    source: 'Hatchery 4',
    notes: 'PL10 cohort',
  };
  const stockingReconciliation: WaterQualityReconciliationData = {
    batch: {
      id: 'batch-stocking',
      code: 'B-STOCK',
      state: 'stocked',
      stocked_at: '2026-10-04T08:31:00Z',
    },
    projection: {
      batch_id: 'batch-stocking',
      initial_stocked_quantity: 25000,
      estimated_remaining_population: 25000,
      latest_average_weight: 0.02,
      weight_unit: 'g',
    },
    events: [{ event_type: 'STOCKING', performed_at: '2026-10-04T08:31:00.000Z' }],
  };

  test('validates STOCKING fields and preserves physical stocked_at as event data', () => {
    expect(buildStockingPayload(stockingInput)).toEqual({
      species_code: 'WHITE_SHRIMP',
      quantity: 25000,
      average_weight: 0.02,
      weight_unit: 'g',
      stocked_at: normalizeProductionEventTime(stockingInput.stocked_at),
      source: 'Hatchery 4',
      notes: 'PL10 cohort',
    });
    expect(buildStockingPayload({ ...stockingInput, weight_unit: undefined }).weight_unit).toBe(
      'g',
    );
    expect(() => buildStockingPayload({ ...stockingInput, quantity: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => buildStockingPayload({ ...stockingInput, average_weight: -1 })).toThrow(
      /zero or greater/,
    );
    expect(() => buildStockingPayload({ ...stockingInput, species_code: ' ' })).toThrow(
      /species_code/,
    );
    expect(() => buildStockingPayload({ ...stockingInput, stocked_at: 'invalid' })).toThrow(
      /physical stocking time/,
    );
  });

  test('disables STOCKING inputs and submit when the authoritative batch is not PLANNED', () => {
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    stateSpy
      .mockReset()
      .mockImplementation((initial: unknown) => [
        typeof initial === 'function' ? (initial as () => unknown)() : initial,
        jest.fn(),
      ]);
    refSpy.mockReset().mockImplementation((initial: unknown) => ({ current: initial }));
    effectSpy.mockReset().mockImplementation(() => undefined);
    const onSaved = jest.fn();
    const tree = StockingForm({ batchId: 'batch-stocked', batchState: 'stocked', onSaved });
    const elements: React.ReactElement[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (React.isValidElement(node)) {
        const element = node as React.ReactElement<{ children?: unknown }>;
        elements.push(element);
        visit(element.props.children);
      }
    };
    visit(tree);
    const inputs = elements.filter((element) => element.type === TextInput) as Array<
      React.ReactElement<{ editable?: boolean }>
    >;
    const pressables = elements.filter((element) => element.type === Pressable) as Array<
      React.ReactElement<{ disabled?: boolean }>
    >;
    const submit = pressables[pressables.length - 1];
    const visibleText = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(visibleText).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return visibleText((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const normalizedVisibleText = visibleText(tree).replace(/\s+/g, ' ').trim();
    expect(normalizedVisibleText).toContain('Stocking requires an authoritative PLANNED batch');
    expect(inputs).toHaveLength(6);
    expect(inputs.every((input) => input.props.editable === false)).toBe(true);
    expect(submit.props.disabled).toBe(true);
    expect(normalizedVisibleText).toContain('Current state: stocked');
    jest.restoreAllMocks();
  });

  test('accepted STOCKING settlement survives unmount and remounts into read-only reconciliation', async () => {
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    let stateValues: unknown[] = [];
    let refs: Array<{ current: unknown }> = [];
    let effects: Array<() => unknown> = [];
    let stateIndex = 0;
    let refIndex = 0;
    const configureMount = () => {
      stateValues = [];
      refs = [];
      effects = [];
      stateIndex = 0;
      refIndex = 0;
      stateSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = stateIndex++;
        if (stateValues.length <= index) {
          stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        return [
          stateValues[index],
          (next: unknown) => {
            stateValues[index] =
              typeof next === 'function'
                ? (next as (current: unknown) => unknown)(stateValues[index])
                : next;
          },
        ];
      });
      refSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = refIndex++;
        if (refs.length <= index) refs.push({ current: initial });
        return refs[index];
      });
      effectSpy.mockReset().mockImplementation((effect: () => unknown) => {
        effects.push(effect);
      });
    };
    const renderForm = (onSaved: jest.Mock) => {
      stateIndex = 0;
      refIndex = 0;
      const tree = StockingForm({
        batchId: stockingContext.batchId,
        batchName: stockingContext.batchName,
        batchState: 'planned',
        onSaved,
      });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;
    let resolvePost!: (event: Record<string, unknown>) => void;
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolvePost = resolve;
        }),
    );
    type StockingProjection = {
      batch_id: string;
      estimated_remaining_population: number;
    };
    const isStockingProjection = (
      value: Record<string, unknown>,
    ): value is Record<string, unknown> & StockingProjection =>
      typeof value.batch_id === 'string' &&
      typeof value.estimated_remaining_population === 'number';
    let projection: StockingProjection = {
      batch_id: stockingContext.batchId,
      estimated_remaining_population: 100,
    };
    let events: Record<string, unknown>[] = [{ event_type: 'STOCKING', performed_at: 'old' }];
    jest.mocked(productionApi.getProductionBatch).mockClear();
    jest.mocked(productionApi.getBatchProjections).mockClear();
    jest.mocked(productionApi.listBatchEvents).mockClear();
    jest
      .mocked(productionApi.getProductionBatch)
      .mockResolvedValue({ id: stockingContext.batchId, state: 'stocked' });
    jest.mocked(productionApi.getBatchProjections).mockImplementation(async () => projection);
    jest
      .mocked(productionApi.listBatchEvents)
      .mockImplementation(async () => ({ items: events, next_cursor: null, limit: 25 }));
    const originalOnSaved = jest.fn();
    const remountedOnSaved = jest.fn(
      (_submission: StockingSubmission, result: WaterQualityReconciliationData) => {
        if (!isStockingProjection(result.projection)) {
          throw new Error('Expected the STOCKING reconciliation to include a valid projection.');
        }
        projection = result.projection;
        events = result.events;
      },
    );

    try {
      configureMount();
      let elements = renderForm(originalOnSaved);
      const originalCleanups = effects.map((effect) => effect());
      const inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText(stockingInput.species_code!);
      inputs[1].props.onChangeText(stockingInput.quantity!.toString());
      inputs[2].props.onChangeText(stockingInput.average_weight!.toString());
      inputs[3].props.onChangeText(stockingInput.stocked_at!);
      inputs[4].props.onChangeText(stockingInput.source!);
      inputs[5].props.onChangeText(stockingInput.notes!);
      elements = renderForm(originalOnSaved);
      buttonWithText(elements, 'I confirm initial stocking').props.onPress();
      elements = renderForm(originalOnSaved);
      buttonWithText(elements, 'Submit stocking').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      const recovery = getStockingWriteRecovery(stockingContext.batchId);
      if (!recovery?.promise)
        throw new Error('Expected STOCKING recovery to retain the pending promise.');
      const submission = recovery.submission as StockingSubmission;
      const pendingPromise = recovery.promise;
      const firstPostCall = post.mock.calls[0];
      if (!firstPostCall) throw new Error('Expected the initial STOCKING POST call.');
      expect(firstPostCall[0]).toBe(stockingContext.batchId);
      expect(firstPostCall[1]).toMatchObject({
        event_type: 'STOCKING',
        data: submission.payload,
      });
      const firstPostData = firstPostCall[1].data;
      if (!firstPostData) throw new Error('Expected the STOCKING POST body to include event data.');
      expect(firstPostData.stocked_at).toBe(submission.payload.stocked_at);
      expect(firstPostCall[1]).not.toHaveProperty('performed_at');
      expect(firstPostCall[2]).toBe(submission.idempotencyKey);
      originalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });

      resolvePost({
        id: 'stocking-event-1',
        event_type: 'STOCKING',
        batch_id: stockingContext.batchId,
      });
      await pendingPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(originalOnSaved).not.toHaveBeenCalled();
      expect(getStockingWriteRecovery(stockingContext.batchId)?.retryOutcome).toBe('accepted');
      expect(projection.estimated_remaining_population).toBe(100);
      const initialEvent = events[0];
      if (!initialEvent)
        throw new Error('Expected the initial STOCKING event to remain unchanged.');
      expect(initialEvent.performed_at).toBe('old');

      const authoritative = {
        batch: {
          id: stockingContext.batchId,
          state: 'stocked',
          stocked_at: '2026-10-04T08:31:00Z',
        },
        projection: { batch_id: stockingContext.batchId, estimated_remaining_population: 25000 },
        events: [{ event_type: 'STOCKING', performed_at: '2026-10-04T08:31:00.000Z' }],
      };
      jest.mocked(productionApi.getProductionBatch).mockResolvedValue(authoritative.batch);
      jest
        .mocked(productionApi.getBatchProjections)
        .mockResolvedValueOnce(authoritative.projection);
      jest
        .mocked(productionApi.listBatchEvents)
        .mockResolvedValueOnce({ items: authoritative.events, next_cursor: null, limit: 25 });
      jest.mocked(productionApi.getBatchProjections).mockClear();
      configureMount();
      elements = renderForm(remountedOnSaved);
      effects.forEach((effect) => effect());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(productionApi.getBatchProjections).toHaveBeenCalledTimes(1);
      expect(remountedOnSaved).toHaveBeenCalledWith(
        submission,
        expect.objectContaining(authoritative),
      );
      expect(projection.estimated_remaining_population).toBe(25000);
      expect(events).toEqual(authoritative.events);
      expect(getStockingWriteRecovery(stockingContext.batchId)).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('retains accepted-but-unreconciled STOCKING and retries authoritative reads without posting', async () => {
    const submission = createStockingSubmission(
      stockingContext.batchId,
      stockingInput,
      'stocking-readonly-key',
      stockingContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-stocking', event_type: 'STOCKING' });
    const readAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue(stockingReconciliation);
    const first = await reconcileStockingWrite({
      context: stockingContext,
      payload: stockingInput,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('reconciliation_failed');
    expect(getStockingWriteRecovery(stockingContext.batchId)).toMatchObject({
      submission,
      inFlight: false,
      retryOutcome: 'reconciliation_failed',
    });

    const retry = await reconcileStockingWrite({
      context: stockingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(retry.reconciliation).toEqual(stockingReconciliation);
    expect(post).toHaveBeenCalledTimes(1);
    clearStockingWriteRecovery(stockingContext.batchId, submission.idempotencyKey);
    expect(getStockingWriteRecovery(stockingContext.batchId)).toBeNull();
  });
});

describe('stocking definitive-rejection handling', () => {
  const stockingValues = [
    'WHITE_SHRIMP',
    '25000',
    '0.02',
    '2026-10-04T08:30',
    'Hatchery 4',
    'PL10 cohort',
  ];
  const refreshed: WaterQualityReconciliationData = {
    batch: { id: 'batch-reject', state: 'stocked' },
    projection: {
      batch_id: 'batch-reject',
      initial_stocked_quantity: 25000,
      estimated_remaining_population: 25000,
      survival_rate: null,
    },
    events: [{ event_type: 'STOCKING' }],
  };

  const mountForm = (batchId: string, onConflictRefreshed: jest.Mock) => {
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    const stateValues: unknown[] = [];
    const refs: Array<{ current: unknown }> = [];
    let stateIndex = 0;
    let refIndex = 0;
    stateSpy.mockReset().mockImplementation((initial: unknown) => {
      const index = stateIndex++;
      if (stateValues.length <= index) {
        stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
      }
      return [
        stateValues[index],
        (next: unknown) => {
          stateValues[index] =
            typeof next === 'function'
              ? (next as (current: unknown) => unknown)(stateValues[index])
              : next;
        },
      ];
    });
    refSpy.mockReset().mockImplementation((initial: unknown) => {
      const index = refIndex++;
      if (refs.length <= index) refs.push({ current: initial });
      return refs[index];
    });
    effectSpy.mockReset().mockImplementation(() => undefined);
    const render = () => {
      stateIndex = 0;
      refIndex = 0;
      const tree = StockingForm({
        batchId,
        batchName: 'B-REJECT',
        batchState: 'planned',
        onConflictRefreshed,
      });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return { tree, elements };
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const text = () => textContent(render().tree).replace(/\s+/g, ' ');
    const button = (label: string) =>
      render().elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(label),
      ) as React.ReactElement<{ onPress: () => void }> | undefined;
    const submit = async () => {
      const inputs = render().elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ onChangeText: (value: string) => void }>
      >;
      stockingValues.forEach((value, index) => inputs[index]?.props.onChangeText(value));
      button('I confirm initial stocking')?.props.onPress();
      const submitButton = button('Submit stocking');
      if (!submitButton) throw new Error('Expected the submit button.');
      submitButton.props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { text, button, submit };
  };

  const rejectWith = (status: number, detail: string) =>
    jest
      .mocked(productionApi.createBatchEvent)
      .mockReset()
      .mockRejectedValue(new ApiFailure('http', 'api', '/events', status, 'ApiError', detail));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('409 stocking_only_in_planned_state clears retry identity, refreshes authoritatively and offers no retry', async () => {
    const batchId = 'batch-reject-409';
    const post = rejectWith(409, 'stocking_only_in_planned_state');
    jest.mocked(productionApi.getProductionBatch).mockReset().mockResolvedValue(refreshed.batch);
    jest
      .mocked(productionApi.getBatchProjections)
      .mockReset()
      .mockResolvedValue(refreshed.projection);
    jest
      .mocked(productionApi.listBatchEvents)
      .mockReset()
      .mockResolvedValue({ items: refreshed.events, next_cursor: null, limit: 25 });
    const onConflictRefreshed = jest.fn();
    const form = mountForm(batchId, onConflictRefreshed);

    await form.submit();

    expect(post).toHaveBeenCalledTimes(1);
    expect(getStockingWriteRecovery(batchId)).toBeNull();
    expect(productionApi.getProductionBatch).toHaveBeenCalledWith(batchId);
    expect(onConflictRefreshed).toHaveBeenCalledTimes(1);
    expect(onConflictRefreshed).toHaveBeenCalledWith(refreshed);
    const text = form.text();
    expect(text).toContain('current state changed');
    expect(text).not.toContain('Retry previous stocking');
    expect(text).not.toContain('Reconcile previous stocking');
    expect(text).toContain('Submit stocking');
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('failed authoritative refresh after 409 is surfaced, not silent, and does not restore retry', async () => {
    const batchId = 'batch-reject-refresh-failed';
    const post = rejectWith(409, 'stocking_only_in_planned_state');
    jest
      .mocked(productionApi.getProductionBatch)
      .mockReset()
      .mockRejectedValue(new Error('network down'));
    jest
      .mocked(productionApi.getBatchProjections)
      .mockReset()
      .mockResolvedValue(refreshed.projection);
    jest
      .mocked(productionApi.listBatchEvents)
      .mockReset()
      .mockResolvedValue({ items: refreshed.events, next_cursor: null, limit: 25 });
    const onConflictRefreshed = jest.fn();
    const form = mountForm(batchId, onConflictRefreshed);

    await form.submit();

    expect(onConflictRefreshed).not.toHaveBeenCalled();
    const text = form.text();
    expect(text).toContain('could not be refreshed');
    expect(text).toContain('not confirmed');
    expect(text).toContain('Reload the batch');
    expect(text).not.toContain('Retry previous stocking');
    expect(getStockingWriteRecovery(batchId)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['site_closed_no_writes', 'site for this batch is closed', 'reopen or reactivate the site'],
    [
      'unit_closed_no_writes',
      'production unit for this batch is closed',
      'reopen or reactivate the unit',
    ],
    [
      'site_under_maintenance',
      'site for this batch is under maintenance',
      'returned to an operational state',
    ],
    [
      'unit_under_maintenance',
      'production unit for this batch is under maintenance',
      'returned to an operational state',
    ],
  ])(
    'lifecycle 409 %s shows parent-resource guidance without claiming a batch-state change',
    async (code, subject, action) => {
      const batchId = `batch-lifecycle-${code}`;
      const post = jest
        .mocked(productionApi.createBatchEvent)
        .mockReset()
        .mockRejectedValue(new ApiError(409, 'Request validation failed.', 'api', '/events', code));
      jest.mocked(productionApi.getProductionBatch).mockReset().mockResolvedValue({
        id: batchId,
        state: 'planned',
      });
      jest
        .mocked(productionApi.getBatchProjections)
        .mockReset()
        .mockResolvedValue(refreshed.projection);
      jest
        .mocked(productionApi.listBatchEvents)
        .mockReset()
        .mockResolvedValue({ items: [], next_cursor: null, limit: 25 });
      const onConflictRefreshed = jest.fn();
      const form = mountForm(batchId, onConflictRefreshed);

      await form.submit();

      const text = form.text();
      expect(text).toContain(subject);
      expect(text).toContain(action);
      expect(text).not.toContain('current state changed');
      expect(text).not.toContain('Retry previous stocking');
      expect(getStockingWriteRecovery(batchId)).toBeNull();
      expect(productionApi.getProductionBatch).toHaveBeenCalledWith(batchId);
      expect(onConflictRefreshed).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  test('lifecycle 409 with failed refresh keeps lifecycle guidance and stale-state warning', async () => {
    const batchId = 'batch-lifecycle-refresh-failed';
    const post = jest
      .mocked(productionApi.createBatchEvent)
      .mockReset()
      .mockRejectedValue(
        new ApiError(409, 'Request validation failed.', 'api', '/events', 'site_closed_no_writes'),
      );
    jest
      .mocked(productionApi.getProductionBatch)
      .mockReset()
      .mockRejectedValue(new Error('network down'));
    jest
      .mocked(productionApi.getBatchProjections)
      .mockReset()
      .mockResolvedValue(refreshed.projection);
    jest
      .mocked(productionApi.listBatchEvents)
      .mockReset()
      .mockResolvedValue({ items: [], next_cursor: null, limit: 25 });
    const form = mountForm(batchId, jest.fn());

    await form.submit();

    const text = form.text();
    expect(text).toContain('site for this batch is closed');
    expect(text).toContain('not confirmed');
    expect(text).toContain('Reload the batch');
    expect(text).not.toContain('current state changed');
    expect(getStockingWriteRecovery(batchId)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('409 with an unrecognized structured code keeps the batch-state message', async () => {
    const batchId = 'batch-unknown-409-code';
    const post = jest
      .mocked(productionApi.createBatchEvent)
      .mockReset()
      .mockRejectedValue(
        new ApiError(
          409,
          'Request validation failed.',
          'api',
          '/events',
          'stocking_only_in_planned_state',
        ),
      );
    jest.mocked(productionApi.getProductionBatch).mockReset().mockResolvedValue(refreshed.batch);
    jest
      .mocked(productionApi.getBatchProjections)
      .mockReset()
      .mockResolvedValue(refreshed.projection);
    jest
      .mocked(productionApi.listBatchEvents)
      .mockReset()
      .mockResolvedValue({ items: refreshed.events, next_cursor: null, limit: 25 });
    const form = mountForm(batchId, jest.fn());

    await form.submit();

    expect(form.text()).toContain('current state changed');
    expect(getStockingWriteRecovery(batchId)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  test.each([
    [403, 'You do not have permission to stock this batch'],
    [404, 'This batch could not be found'],
  ])(
    'HTTP %i is definitive, shows its specific message and offers no retry',
    async (status, message) => {
      const batchId = `batch-reject-${status}`;
      const post = rejectWith(status, 'denied');
      jest.mocked(productionApi.getProductionBatch).mockReset();
      const onConflictRefreshed = jest.fn();
      const form = mountForm(batchId, onConflictRefreshed);

      await form.submit();

      const text = form.text();
      expect(text).toContain(message);
      expect(text).not.toContain('Retry previous stocking');
      expect(getStockingWriteRecovery(batchId)).toBeNull();
      expect(onConflictRefreshed).not.toHaveBeenCalled();
      expect(productionApi.getProductionBatch).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(1);
    },
  );
});

describe('sampling write workflow', () => {
  const samplingContext: WaterQualityWriteContext = {
    batchId: 'batch-sampling',
    batchName: 'B-SAMPLE',
    farmName: 'North Farm',
    unitName: 'Pond 4',
  };
  const samplingInput: SamplingInput = {
    performed_at: '2026-09-26T08:30',
    sample_size: '30',
    average_weight: '4.8',
    minimum_weight: '3.9',
    maximum_weight: '5.7',
    weight_unit: 'g',
    estimated_population: '22800',
    notes: 'Growth sampling week 6',
  };
  const samplingReconciliation = {
    batch: { id: 'batch-sampling', code: 'B-SAMPLE', state: 'active' },
    projection: {
      batch_id: 'batch-sampling',
      initial_stocked_quantity: 25000,
      estimated_remaining_population: 22800,
      latest_average_weight: 4.8,
    },
    events: [{ event_type: 'SAMPLING', performed_at: '2026-09-27T00:00:00.000Z' }],
  };

  test('builds exact canonical SAMPLING data and binds intent to batch and payload', () => {
    const payload = buildSamplingPayload(samplingInput);
    expect(payload).toEqual({
      sample_size: 30,
      average_weight: 4.8,
      minimum_weight: 3.9,
      maximum_weight: 5.7,
      weight_unit: 'g',
      estimated_population: 22800,
      notes: 'Growth sampling week 6',
    });
    const signature = createSamplingDraftSignature('batch-sampling', samplingInput);
    expect(signature).toContain('batch-sampling');
    expect(signature).toContain(normalizeProductionEventTime(samplingInput.performed_at ?? null));
    expect(
      createSamplingDraftSignature('batch-sampling', { ...samplingInput, sample_size: 40 }),
    ).not.toBe(signature);
    expect(
      createSamplingDraftSignature('batch-sampling', {
        ...samplingInput,
        performed_at: '2026-09-26T09:30',
      }),
    ).not.toBe(signature);
  });

  test('normalizes local sampling time and preserves explicit offsets while rejecting invalid local times', () => {
    const localTime = '2026-09-26T08:30';
    expect(normalizeProductionEventTime(localTime)).toBe(new Date(localTime).toISOString());
    expect(normalizeProductionEventTime('2026-09-26T08:30Z')).toBe('2026-09-26T08:30:00.000Z');
    expect(normalizeProductionEventTime('2026-09-26T08:30+02:30')).toBe('2026-09-26T06:00:00.000Z');
    expect(normalizeProductionEventTime('2026-02-30T08:30')).toBeNull();
    if (new Date('2026-03-08T02:30').getHours() !== 2) {
      expect(normalizeProductionEventTime('2026-03-08T02:30')).toBeNull();
    }
  });

  test.each([
    ['timezone-free input', '2026-09-26T08:30', 'device'],
    ['UTC Z input', '2026-09-26T08:30Z', 'UTC'],
    ['explicit offset input', '2026-09-26T08:30+02:30', 'entered offset +02:30'],
  ])('sampling confirmation labels %s accurately', (_label, performedAt, expectedZone) => {
    const values: Record<string, string> = {
      performed_at: performedAt,
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: '',
      maximum_weight: '',
      weight_unit: 'g',
      estimated_population: '',
      notes: '',
    };
    const input: SamplingInput = {
      performed_at: performedAt,
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: null,
      maximum_weight: null,
      weight_unit: 'g',
      estimated_population: null,
      notes: '',
    };
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    stateSpy.mockReset();
    [
      [values, jest.fn()],
      [true, jest.fn()],
      [createSamplingDraftSignature('batch-sampling', input), jest.fn()],
      [false, jest.fn()],
      [null, jest.fn()],
      [null, jest.fn()],
      [false, jest.fn()],
    ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
    refSpy.mockReset().mockImplementation((initial: unknown) => ({ current: initial }));

    try {
      const tree = SamplingForm({ batchId: 'batch-sampling' });
      const textContent = (node: unknown): string => {
        if (Array.isArray(node)) return node.map(textContent).join(' ');
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (React.isValidElement(node)) {
          return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
        }
        return '';
      };
      const preview = textContent(tree).replace(/\s+/g, ' ');
      const zone =
        expectedZone === 'device'
          ? `device local time (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time'})`
          : expectedZone;
      expect(preview).toContain(`Observation time ( ${zone} ): ${performedAt}`);
      expect(preview).toContain(`Sent as UTC: ${normalizeProductionEventTime(performedAt)}`);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('defaults weight_unit to g and accepts kg', () => {
    const defaulted = buildSamplingPayload({ sample_size: '10', average_weight: '5' });
    expect(defaulted.weight_unit).toBe('g');
    expect(defaulted).not.toHaveProperty('minimum_weight');
    expect(defaulted).not.toHaveProperty('maximum_weight');
    expect(defaulted).not.toHaveProperty('estimated_population');
    expect(defaulted).not.toHaveProperty('notes');

    const kg = buildSamplingPayload({ ...samplingInput, weight_unit: 'kg' });
    expect(kg.weight_unit).toBe('kg');

    expect(() => buildSamplingPayload({ ...samplingInput, weight_unit: 'lb' })).toThrow(
      /weight_unit/,
    );
  });

  test('rejects nonpositive/noninteger sample sizes, negative weights, cross-field bound violations, and overlong notes', () => {
    for (const sample_size of [0, -1, 1.5, '2.2']) {
      expect(() => buildSamplingPayload({ ...samplingInput, sample_size })).toThrow(
        /positive integer/,
      );
    }
    expect(() => buildSamplingPayload({ ...samplingInput, average_weight: -1 })).toThrow(
      /average_weight/,
    );
    expect(() => buildSamplingPayload({ ...samplingInput, minimum_weight: -1 })).toThrow(
      /minimum_weight/,
    );
    expect(() => buildSamplingPayload({ ...samplingInput, maximum_weight: -1 })).toThrow(
      /maximum_weight/,
    );
    expect(() =>
      buildSamplingPayload({ ...samplingInput, minimum_weight: 5, average_weight: 4.8 }),
    ).toThrow(/minimum_weight cannot exceed average_weight/);
    expect(() =>
      buildSamplingPayload({ ...samplingInput, maximum_weight: 4, average_weight: 4.8 }),
    ).toThrow(/maximum_weight cannot be below average_weight/);
    expect(() => buildSamplingPayload({ ...samplingInput, estimated_population: -1 })).toThrow(
      /estimated_population/,
    );
    expect(() => buildSamplingPayload({ ...samplingInput, estimated_population: 1.5 })).toThrow(
      /estimated_population/,
    );
    expect(
      buildSamplingPayload({ ...samplingInput, estimated_population: 0 }).estimated_population,
    ).toBe(0);
    expect(() => buildSamplingPayload({ ...samplingInput, notes: 'x'.repeat(1001) })).toThrow(
      /notes/,
    );
  });

  test('keeps a compact immutable submission and rejects batch/key identity mismatches', () => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      undefined,
      samplingContext,
    );
    expect(submission.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(submission.context.batchId).toBe(samplingContext.batchId);

    const post = jest.fn();
    const readAll = jest.fn();
    expect(() =>
      reconcileSamplingWrite({
        context: { ...samplingContext, batchId: 'another-batch' },
        payload: submission.payload,
        idempotencyKey: submission.idempotencyKey,
        submission,
        post,
        readAll,
      }),
    ).toThrow(/current intent/);
    expect(() =>
      reconcileSamplingWrite({
        context: samplingContext,
        payload: submission.payload,
        idempotencyKey: 'different-key',
        submission,
        post,
        readAll,
      }),
    ).toThrow(/current intent/);
  });

  test('accepts a resolved/replayed event and uses only authoritative reconciliation projections', async () => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      'sampling-accept-key',
      samplingContext,
    );
    const eventRecord = {
      id: 'event-sampling',
      event_type: 'SAMPLING',
      batch_id: 'batch-sampling',
      performed_by_id: 'server-actor',
      data: submission.payload,
    };
    const post = jest.fn().mockResolvedValue(eventRecord);
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);
    const result = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });

    expect(post).toHaveBeenCalledWith(
      samplingContext.batchId,
      'SAMPLING',
      submission.payload,
      submission.idempotencyKey,
      submission.performedAt,
    );
    expect(result.outcome).toBe('accepted');
    expect(result.reconciliation).toEqual(samplingReconciliation);
    expect(result.reconciliation?.projection.estimated_remaining_population).toBe(22800);
    expect(result.submission.payload.sample_size).toBe(30);
    expect(result.submission.payload).not.toHaveProperty('performed_by_id');
    expect(getSamplingWriteRecovery(samplingContext.batchId)).toMatchObject({
      submission,
      inFlight: false,
      promise: null,
      retryOutcome: 'accepted',
    });
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);

    const replay = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(replay.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(getSamplingWriteRecovery(samplingContext.batchId)?.retryOutcome).toBe('accepted');
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);
    expect(getSamplingWriteRecovery(samplingContext.batchId)).toBeNull();
  });

  test('does not reuse a settled sampling result for a different payload under the same key', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);
    const first = await reconcileSamplingWrite({
      context: samplingContext,
      payload: samplingInput,
      idempotencyKey: 'sampling-settled-identity-key',
      post,
      readAll,
    });
    expect(first.outcome).toBe('accepted');
    expect(getSamplingWriteRecovery(samplingContext.batchId)?.retryOutcome).toBe('accepted');
    clearSamplingWriteRecovery(samplingContext.batchId, first.submission.idempotencyKey);

    const differentIntent = await reconcileSamplingWrite({
      context: samplingContext,
      payload: { ...samplingInput, sample_size: 40 },
      idempotencyKey: 'sampling-settled-identity-key',
      post,
      readAll,
    });
    expect(differentIntent.outcome).toBe('write_failed');
    expect(differentIntent.posted).toBe(false);
    expect(readAll).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('treats a different observation instant as a different submission under the same key', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);
    const first = await reconcileSamplingWrite({
      context: samplingContext,
      payload: { ...samplingInput, performed_at: '2026-09-26T08:30Z' },
      idempotencyKey: 'sampling-same-key-different-time',
      post,
      readAll,
    });
    clearSamplingWriteRecovery(samplingContext.batchId, first.submission.idempotencyKey);
    const differentTime = await reconcileSamplingWrite({
      context: samplingContext,
      payload: { ...samplingInput, performed_at: '2026-09-26T09:30Z' },
      idempotencyKey: 'sampling-same-key-different-time',
      post,
      readAll,
    });

    expect(first.outcome).toBe('accepted');
    expect(differentTime.outcome).toBe('write_failed');
    expect(differentTime.posted).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('ambiguous network failure preserves the exact submission and key', async () => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      'sampling-ambiguous-key',
      samplingContext,
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-sampling/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      )
      .mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);
    const first = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);

    const retry = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][3]).toBe(submission.idempotencyKey);
    expect(post.mock.calls[1][3]).toBe(submission.idempotencyKey);
    expect(post.mock.calls.map((call) => call[4])).toEqual([
      submission.performedAt,
      submission.performedAt,
    ]);
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);
    expect(retry.submission).toBe(submission);
  });

  test.each([
    [
      'HTTP 503',
      new ApiFailure(
        'http',
        'http://localhost:8000/api',
        '/v1/batches/batch-sampling/events',
        503,
        'ApiError',
        'Service unavailable',
      ),
      'sampling-http-503-key',
    ],
    [
      'post-response contract failure',
      new ApiFailure(
        'application',
        'http://localhost:8000/api',
        '/v1/batches/batch-sampling/events',
        undefined,
        'ApiContractError',
        'Invalid event response contract',
      ),
      'sampling-contract-failure-key',
    ],
  ])('%s preserves the immutable submission for same-key retry', async (_name, failure, key) => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      key,
      samplingContext,
    );
    const post = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);

    const first = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);

    const retry = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(retry.submission).toBe(submission);
    expect(post.mock.calls.map((call) => call[3])).toEqual([key, key]);
    expect(post.mock.calls.map((call) => call[4])).toEqual([
      submission.performedAt,
      submission.performedAt,
    ]);
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);
  });

  test.each([409, 422])('does not retry a definitive HTTP %s rejection', async (status) => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      `sampling-definitive-${status}`,
      samplingContext,
    );
    const post = jest
      .fn()
      .mockRejectedValue(
        new ApiFailure(
          'http',
          'http://localhost:8000/api',
          '/v1/batches/batch-sampling/events',
          status,
          'ApiError',
          'Rejected',
        ),
      );
    const result = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll: jest.fn(),
    });
    expect(result.outcome).toBe('rejected');
    expect(result.retrySubmission).toBeNull();
    expect(getSamplingWriteRecovery(samplingContext.batchId)).toBeNull();
  });

  test('coalesces concurrent same-key sampling calls into one POST', async () => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      'sampling-concurrent-key',
      samplingContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest.fn().mockResolvedValue(samplingReconciliation);
    const args = {
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    };
    const [first, second] = await Promise.all([
      reconcileSamplingWrite(args),
      reconcileSamplingWrite(args),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);
  });

  test('reconciliation failure retries reads only and never reposts sampling', async () => {
    const submission = createSamplingSubmission(
      samplingContext.batchId,
      samplingInput,
      'sampling-readonly-retry-key',
      samplingContext,
    );
    const post = jest.fn().mockResolvedValue({ id: 'event-sampling', event_type: 'SAMPLING' });
    const readAll = jest
      .fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue(samplingReconciliation);
    const first = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('reconciliation_failed');
    expect(first.posted).toBe(true);
    expect(first.retrySubmission).toBe(submission);
    expect(getSamplingWriteRecovery(samplingContext.batchId)).toMatchObject({
      submission,
      inFlight: false,
      promise: null,
      retryOutcome: 'reconciliation_failed',
    });

    const retry = await reconcileSamplingWrite({
      context: samplingContext,
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission: first.retrySubmission ?? undefined,
      post,
      readAll,
    });
    expect(retry.outcome).toBe('accepted');
    expect(retry.reconciled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(getSamplingWriteRecovery(samplingContext.batchId)?.retryOutcome).toBe('accepted');
    clearSamplingWriteRecovery(samplingContext.batchId, submission.idempotencyKey);
    expect(getSamplingWriteRecovery(samplingContext.batchId)).toBeNull();
  });

  test('sampling form requires explicit confirmation, shows high-impact population warning, and blocks stale duplicate submit', async () => {
    let values: Record<string, string> = {
      performed_at: '2026-09-26T08:30',
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: '3.9',
      maximum_weight: '5.7',
      weight_unit: 'g',
      estimated_population: '22800',
      notes: 'Growth sampling week 6',
    };
    let confirmed = false;
    let confirmedSnapshot: string | null = null;
    let busy = false;
    let error: string | null = null;
    let statusMessage: string | null = null;
    let recoveryRequired = false;
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const submissionInFlight = { current: false };
    const retrySubmission = { current: null as SamplingSubmission | null };
    const draftRevision = { current: 0 };
    const setters = [
      (update: (current: Record<string, string>) => Record<string, string>) => {
        values = update(values);
      },
      (next: boolean) => {
        confirmed = next;
      },
      (next: string | null) => {
        confirmedSnapshot = next;
      },
      (next: boolean) => {
        busy = next;
      },
      (next: string | null) => {
        error = next;
      },
      (next: string | null) => {
        statusMessage = next;
      },
      (next: boolean) => {
        recoveryRequired = next;
      },
    ];
    let lastTree: React.ReactElement | null = null;
    const eventRecord = {
      id: 'sampling-event-1',
      event_type: 'SAMPLING',
      batch_id: 'batch-sampling',
      performed_by_id: 'server-actor',
      data: buildSamplingPayload(samplingInput),
    };
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockResolvedValue(eventRecord);
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-sampling' });
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue({
      ...samplingReconciliation.projection,
      estimated_remaining_population: 22800,
    });
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: samplingReconciliation.events,
      next_cursor: null,
      limit: 25,
    });
    const onSaved = jest.fn();

    const renderForm = () => {
      stateSpy.mockReset();
      [values, confirmed, confirmedSnapshot, busy, error, statusMessage, recoveryRequired].forEach(
        (value, index) => stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retrySubmission)
        .mockReturnValueOnce(draftRevision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      const tree = SamplingForm({
        batchId: 'batch-sampling',
        batchName: 'B-SAMPLE',
        farmName: 'North Farm',
        siteName: 'Site 4',
        unitName: 'Pond 4',
        currentEstimatedRemainingPopulation: 25000,
        onSaved,
      });
      lastTree = tree;
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(textContent);
      if (typeof node === 'string' || typeof node === 'number') return [String(node)];
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return [];
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent((element as React.ReactElement<{ children?: unknown }>).props.children)
            .join(' ')
            .includes(text),
      ) as React.ReactElement<{ onPress: () => void }>;

    try {
      const initial = renderForm();
      await buttonWithText(initial, 'Submit sampling').props.onPress();
      expect(post).not.toHaveBeenCalled();
      expect(error).toContain('confirm');

      const preWarning = textContent(lastTree).join('');
      expect(preWarning).toContain('replace the projected remaining population');
      expect(preWarning).toContain('25000');

      const confirmation = buttonWithText(initial, 'I confirm this sampling record');
      confirmation.props.onPress();
      expect(confirmed).toBe(true);
      const confirmedElements = renderForm();
      const preview = textContent(lastTree).join('');
      expect(preview).toContain('Sample size: 30');
      expect(preview).toContain('Observation time (');
      expect(preview).toContain('2026-09-26T08:30');
      expect(preview).toContain(`Sent as UTC: ${normalizeProductionEventTime('2026-09-26T08:30')}`);
      expect(preview).toContain('Average weight: 4.8 g');
      expect(preview).toContain('Minimum weight: 3.9 g');
      expect(preview).toContain('Maximum weight: 5.7 g');
      expect(preview).toContain('Current projected remaining population: 25000');
      expect(preview).toContain('Proposed estimated population: 22800');
      expect(preview).toContain('this will replace the projected remaining population');

      const submit = buttonWithText(confirmedElements, 'Submit sampling');
      void submit.props.onPress();
      void submit.props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe('batch-sampling');
      expect(post.mock.calls[0][1]).toMatchObject({
        event_type: 'SAMPLING',
        performed_at: normalizeProductionEventTime('2026-09-26T08:30'),
        data: {
          sample_size: 30,
          average_weight: 4.8,
          minimum_weight: 3.9,
          maximum_weight: 5.7,
          weight_unit: 'g',
          estimated_population: 22800,
        },
      });
      expect(post.mock.calls[0][1].data).not.toHaveProperty('performed_at');
      expect(post.mock.calls[0][1].data).not.toHaveProperty('performed_by_id');
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            batchId: 'batch-sampling',
            farmName: 'North Farm',
            siteName: 'Site 4',
            unitName: 'Pond 4',
          }),
        }),
        expect.objectContaining({
          projection: expect.objectContaining({ estimated_remaining_population: 22800 }),
        }),
      );
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();

      await buttonWithText(renderForm(), 'Submit sampling').props.onPress();
      expect(post).toHaveBeenCalledTimes(1);
      expect(error).toContain('confirm');
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('sampling draft stays locked after ambiguity and explicitly retries the exact submission', async () => {
    let values: Record<string, string> = {
      performed_at: '2026-09-26T08:30',
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: '',
      maximum_weight: '',
      weight_unit: 'g',
      estimated_population: '',
      notes: '',
    };
    let confirmed = false;
    let confirmedSnapshot: string | null = null;
    let busy = false;
    let recoveryRequired = false;
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const submissionInFlight = { current: false };
    const retrySubmission = { current: null as SamplingSubmission | null };
    const draftRevision = { current: 0 };
    const setters = [
      (update: (current: Record<string, string>) => Record<string, string>) => {
        values = update(values);
      },
      (next: boolean) => {
        confirmed = next;
      },
      (next: string | null) => {
        confirmedSnapshot = next;
      },
      (next: boolean) => {
        busy = next;
      },
      jest.fn(),
      jest.fn(),
      (next: boolean) => {
        recoveryRequired = next;
      },
    ];
    let rejectPost!: (error: unknown) => void;
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPost = reject;
        }),
    );
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue({ id: 'batch-sampling' });
    jest
      .mocked(productionApi.getBatchProjections)
      .mockResolvedValue(samplingReconciliation.projection);
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: samplingReconciliation.events,
      next_cursor: null,
      limit: 25,
    });

    const renderForm = () => {
      stateSpy.mockReset();
      [values, confirmed, confirmedSnapshot, busy, null, null, recoveryRequired].forEach(
        (value, index) => stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retrySubmission)
        .mockReturnValueOnce(draftRevision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      const tree = SamplingForm({ batchId: 'batch-sampling' });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;

    try {
      const initial = renderForm();
      buttonWithText(initial, 'I confirm this sampling record').props.onPress();
      const confirmedElements = renderForm();
      buttonWithText(confirmedElements, 'Submit sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(1);
      expect(busy).toBe(true);
      expect(submissionInFlight.current).toBe(true);

      const busyElements = renderForm();
      const busyInputs = busyElements.filter(
        (element) => element.type === TextInput,
      ) as React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>[];
      expect(busyInputs.every((input) => input.props.editable === false)).toBe(true);
      const busyUnit = buttonWithText(busyElements, 'kg');
      const busyConfirm = buttonWithText(busyElements, 'I confirm this sampling record');
      expect(busyUnit.props.disabled).toBe(true);
      expect(busyConfirm.props.disabled).toBe(true);

      busyInputs[1].props.onChangeText('99');
      busyUnit.props.onPress();
      busyConfirm.props.onPress();
      expect(values.sample_size).toBe('30');
      expect(values.weight_unit).toBe('g');
      expect(confirmed).toBe(true);
      expect(draftRevision.current).toBe(0);
      expect(retrySubmission.current).toBeNull();

      const submittedKey = post.mock.calls[0][2];
      const submittedPerformedAt = post.mock.calls[0][1].performed_at;
      rejectPost(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          '/v1/batches/batch-sampling/events',
          undefined,
          'TypeError',
          'Network request failed',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(busy).toBe(false);
      expect(submissionInFlight.current).toBe(false);
      expect(retrySubmission.current?.idempotencyKey).toBe(submittedKey);
      expect(retrySubmission.current?.performedAt).toBe(submittedPerformedAt);
      expect(retrySubmission.current?.performedAt).toBe(
        normalizeProductionEventTime('2026-09-26T08:30'),
      );

      const recoveryElements = renderForm();
      const recoveryInputs = recoveryElements.filter(
        (element) => element.type === TextInput,
      ) as React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>[];
      expect(recoveryInputs.every((input) => input.props.editable === false)).toBe(true);
      recoveryInputs[1].props.onChangeText('31');
      expect(values.sample_size).toBe('30');
      expect(retrySubmission.current?.idempotencyKey).toBe(submittedKey);
      post.mockResolvedValueOnce({ id: 'event-sampling-recovered', event_type: 'SAMPLING' });
      buttonWithText(recoveryElements, 'Retry previous sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map((call) => call[2])).toEqual([submittedKey, submittedKey]);
      expect(post.mock.calls.map((call) => call[1].performed_at)).toEqual([
        submittedPerformedAt,
        submittedPerformedAt,
      ]);
      expect(post.mock.calls[1][1].data).toEqual(post.mock.calls[0][1].data);
      expect(getSamplingWriteRecovery('batch-sampling')).toBeNull();
      expect(retrySubmission.current).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('sampling recovery reattaches pending writes and preserves settled ambiguity across remounts', async () => {
    const batchId = 'batch-sampling-remount';
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const effectSpy = React.useEffect as unknown as jest.Mock;
    let stateValues: unknown[] = [];
    let refs: Array<{ current: unknown }> = [];
    let effects: Array<() => unknown> = [];
    let stateIndex = 0;
    let refIndex = 0;
    const configureMount = () => {
      stateValues = [];
      refs = [];
      effects = [];
      stateIndex = 0;
      refIndex = 0;
      stateSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = stateIndex++;
        if (stateValues.length <= index) {
          stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
        }
        return [
          stateValues[index],
          (next: unknown) => {
            stateValues[index] =
              typeof next === 'function'
                ? (next as (current: unknown) => unknown)(stateValues[index])
                : next;
          },
        ];
      });
      refSpy.mockReset().mockImplementation((initial: unknown) => {
        const index = refIndex++;
        if (refs.length <= index) refs.push({ current: initial });
        return refs[index];
      });
      effectSpy.mockReset().mockImplementation((effect: () => unknown) => {
        effects.push(effect);
      });
    };
    const renderForm = (onSaved: jest.Mock) => {
      stateIndex = 0;
      refIndex = 0;
      const tree = SamplingForm({ batchId, batchName: 'B-SAMPLE-REMOUNT', onSaved });
      const elements: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          elements.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      return elements;
    };
    const textContent = (node: unknown): string => {
      if (Array.isArray(node)) return node.map(textContent).join(' ');
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (React.isValidElement(node)) {
        return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
      }
      return '';
    };
    const buttonWithText = (elements: React.ReactElement[], text: string) =>
      elements.find(
        (element) =>
          element.type === Pressable &&
          textContent(
            (element as React.ReactElement<{ children?: unknown }>).props.children,
          ).includes(text),
      ) as React.ReactElement<{ onPress: () => void; disabled?: boolean }>;
    const deferredPosts: Array<{
      resolve: (event: Record<string, unknown>) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const post = jest.mocked(productionApi.createBatchEvent);
    post.mockReset().mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          deferredPosts.push({ resolve, reject });
        }),
    );
    const reconciliation = {
      batch: { id: batchId, code: 'B-SAMPLE-REMOUNT', state: 'active' },
      projection: {
        batch_id: batchId,
        initial_stocked_quantity: 100,
        estimated_remaining_population: 75,
        latest_average_weight: 4.8,
      },
      events: [{ event_type: 'SAMPLING', performed_at: '2026-09-27T08:30:00.000Z' }],
    };
    jest.mocked(productionApi.getProductionBatch).mockResolvedValue(reconciliation.batch);
    jest.mocked(productionApi.getBatchProjections).mockResolvedValue(reconciliation.projection);
    jest.mocked(productionApi.listBatchEvents).mockResolvedValue({
      items: reconciliation.events,
      next_cursor: null,
      limit: 25,
    });
    const firstOriginalOnSaved = jest.fn();
    const firstRemountedOnSaved = jest.fn();
    const secondOriginalOnSaved = jest.fn();
    const secondPendingRemountedOnSaved = jest.fn();
    const settledRetryOnSaved = jest.fn();
    const routeState: {
      projection: Record<string, unknown>;
      events: Record<string, unknown>[];
    } = {
      projection: { batch_id: batchId, estimated_remaining_population: 100 },
      events: [{ event_type: 'STOCKING', performed_at: '2026-09-20T08:30:00.000Z' }],
    };
    const acceptedWhileUnmountedOnSaved = jest.fn(
      (_submission: SamplingSubmission, acceptedReconciliation: WaterQualityReconciliationData) => {
        routeState.projection = acceptedReconciliation.projection;
        routeState.events = acceptedReconciliation.events;
      },
    );

    try {
      configureMount();
      let elements = renderForm(firstOriginalOnSaved);
      const firstOriginalCleanups = effects.slice().map((effect) => effect());
      let inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText('2026-09-26T08:30Z');
      inputs[1].props.onChangeText('30');
      inputs[2].props.onChangeText('4.8');
      elements = renderForm(firstOriginalOnSaved);
      buttonWithText(elements, 'I confirm this sampling record').props.onPress();
      elements = renderForm(firstOriginalOnSaved);
      buttonWithText(elements, 'Submit sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      const firstRecovery = getSamplingWriteRecovery(batchId);
      if (!firstRecovery?.promise) {
        throw new Error('Expected the pending SAMPLING recovery to retain its promise.');
      }
      const firstSubmission = firstRecovery.submission as SamplingSubmission;
      const firstPromise = firstRecovery.promise;
      expect(firstRecovery.inFlight).toBe(true);
      expect(getSamplingWriteRecovery('another-sampling-batch')).toBeNull();
      expect(getMortalityWriteRecovery(batchId)).toBeNull();
      expect(post.mock.calls[0][0]).toBe(batchId);
      expect(post.mock.calls[0][1]).toMatchObject({
        event_type: 'SAMPLING',
        performed_at: firstSubmission.performedAt,
        data: firstSubmission.payload,
      });
      expect(post.mock.calls[0][2]).toBe(firstSubmission.idempotencyKey);
      expect(firstSubmission.performedAt).toBe('2026-09-26T08:30:00.000Z');

      firstOriginalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
      configureMount();
      elements = renderForm(firstRemountedOnSaved);
      const pendingRemountEffects = effects.slice();
      const pendingRemountCleanups = pendingRemountEffects.map((effect) => effect());
      expect(getSamplingWriteRecovery(batchId)?.promise).toBe(firstPromise);
      expect(stateValues[3]).toBe(true);
      expect(buttonWithText(elements, 'Saving…').props.disabled).toBe(true);
      await Promise.resolve();
      expect(post).toHaveBeenCalledTimes(1);

      deferredPosts[0].resolve({
        id: 'event-sampling-pending-remount',
        event_type: 'SAMPLING',
        batch_id: batchId,
      });
      await firstPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe(batchId);
      expect(post.mock.calls[0][2]).toBe(firstSubmission.idempotencyKey);
      expect(post.mock.calls[0][1].performed_at).toBe(firstSubmission.performedAt);
      expect(post.mock.calls[0][1].data).toEqual(firstSubmission.payload);
      expect(firstOriginalOnSaved).not.toHaveBeenCalled();
      expect(firstRemountedOnSaved).toHaveBeenCalledWith(firstSubmission, reconciliation);
      expect(stateValues[5]).toContain('Sampling has been recorded and reconciled');
      expect(getSamplingWriteRecovery(batchId)).toBeNull();
      pendingRemountCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });

      configureMount();
      elements = renderForm(secondOriginalOnSaved);
      const secondOriginalCleanups = effects.slice().map((effect) => effect());
      inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText('2026-09-27T08:30Z');
      inputs[1].props.onChangeText('25');
      inputs[2].props.onChangeText('5.2');
      elements = renderForm(secondOriginalOnSaved);
      buttonWithText(elements, 'I confirm this sampling record').props.onPress();
      elements = renderForm(secondOriginalOnSaved);
      buttonWithText(elements, 'Submit sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(2);
      const secondRecovery = getSamplingWriteRecovery(batchId);
      if (!secondRecovery?.promise) {
        throw new Error('Expected the second pending SAMPLING recovery to retain its promise.');
      }
      const secondSubmission = secondRecovery.submission as SamplingSubmission;
      const secondPromise = secondRecovery.promise;
      expect(secondRecovery.inFlight).toBe(true);
      expect(secondSubmission.idempotencyKey).not.toBe(firstSubmission.idempotencyKey);
      expect(post.mock.calls[1][0]).toBe(batchId);
      expect(post.mock.calls[1][1]).toMatchObject({
        event_type: 'SAMPLING',
        performed_at: secondSubmission.performedAt,
        data: secondSubmission.payload,
      });

      secondOriginalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
      configureMount();
      elements = renderForm(secondPendingRemountedOnSaved);
      const secondPendingEffects = effects.slice();
      const secondPendingCleanups = secondPendingEffects.map((effect) => effect());
      expect(getSamplingWriteRecovery(batchId)?.promise).toBe(secondPromise);
      expect(getSamplingWriteRecovery('other-sampling-batch')).toBeNull();
      expect(getMortalityWriteRecovery(batchId)).toBeNull();
      expect(stateValues[3]).toBe(true);
      expect(post).toHaveBeenCalledTimes(2);

      deferredPosts[1].reject(
        new ApiFailure(
          'network',
          'http://localhost:8000/api',
          `/v1/batches/${batchId}/events`,
          undefined,
          'TypeError',
          'Network request failed',
        ),
      );
      await secondPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const settledRecovery = getSamplingWriteRecovery(batchId);
      expect(settledRecovery?.inFlight).toBe(false);
      expect(settledRecovery?.retryOutcome).toBe('outcome_unknown');
      expect(settledRecovery?.submission).toBe(secondSubmission);
      expect(secondPendingRemountedOnSaved).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(2);
      secondPendingCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });

      configureMount();
      elements = renderForm(settledRetryOnSaved);
      effects.slice().forEach((effect) => effect());
      inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>
      >;
      expect(inputs.every((input) => input.props.editable === false)).toBe(true);
      expect(textContent(elements)).toContain('uncertain outcome');
      expect(buttonWithText(elements, 'Retry previous sampling').props.disabled).toBe(false);
      inputs[1].props.onChangeText('99');
      expect(stateValues[0]).toMatchObject({ sample_size: '25' });
      expect(getSamplingWriteRecovery(batchId)?.submission).toBe(secondSubmission);
      expect(post).toHaveBeenCalledTimes(2);

      post.mockResolvedValueOnce({
        id: 'event-sampling-settled-retry',
        event_type: 'SAMPLING',
        batch_id: batchId,
      });
      buttonWithText(elements, 'Retry previous sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(3);
      expect(post.mock.calls[2][0]).toBe(batchId);
      expect(post.mock.calls.map((call) => call[2])).toEqual([
        firstSubmission.idempotencyKey,
        secondSubmission.idempotencyKey,
        secondSubmission.idempotencyKey,
      ]);
      expect(post.mock.calls[2][1].performed_at).toBe(secondSubmission.performedAt);
      expect(post.mock.calls[2][1].data).toEqual(post.mock.calls[1][1].data);
      expect(settledRetryOnSaved).toHaveBeenCalledWith(secondSubmission, reconciliation);
      expect(getSamplingWriteRecovery(batchId)).toBeNull();
      expect(getMortalityWriteRecovery(batchId)).toBeNull();

      configureMount();
      elements = renderForm(acceptedWhileUnmountedOnSaved);
      const thirdOriginalCleanups = effects.slice().map((effect) => effect());
      inputs = elements.filter((element) => element.type === TextInput) as Array<
        React.ReactElement<{ editable?: boolean; onChangeText: (value: string) => void }>
      >;
      inputs[0].props.onChangeText('2026-09-28T08:30Z');
      inputs[1].props.onChangeText('20');
      inputs[2].props.onChangeText('6.1');
      elements = renderForm(acceptedWhileUnmountedOnSaved);
      buttonWithText(elements, 'I confirm this sampling record').props.onPress();
      elements = renderForm(acceptedWhileUnmountedOnSaved);
      buttonWithText(elements, 'Submit sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(4);
      const thirdRecovery = getSamplingWriteRecovery(batchId);
      if (!thirdRecovery?.promise) {
        throw new Error(
          'Expected the accepted-settlement SAMPLING recovery to retain its promise.',
        );
      }
      const thirdSubmission = thirdRecovery.submission as SamplingSubmission;
      const acceptedWritePromise = thirdRecovery.promise;
      expect(post.mock.calls[3][0]).toBe(batchId);
      expect(post.mock.calls[3][1]).toMatchObject({
        event_type: 'SAMPLING',
        performed_at: thirdSubmission.performedAt,
        data: thirdSubmission.payload,
      });
      expect(post.mock.calls[3][2]).toBe(thirdSubmission.idempotencyKey);

      thirdOriginalCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
      deferredPosts[2].resolve({
        id: 'event-sampling-accepted-while-unmounted',
        event_type: 'SAMPLING',
        batch_id: batchId,
      });
      await acceptedWritePromise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const acceptedRecovery = getSamplingWriteRecovery(batchId);
      expect(acceptedRecovery?.inFlight).toBe(false);
      expect(acceptedRecovery?.retryOutcome).toBe('accepted');
      expect(acceptedRecovery?.submission).toBe(thirdSubmission);
      expect(acceptedWhileUnmountedOnSaved).not.toHaveBeenCalled();
      expect(routeState.projection.estimated_remaining_population).toBe(100);
      expect(routeState.events).toEqual([
        { event_type: 'STOCKING', performed_at: '2026-09-20T08:30:00.000Z' },
      ]);
      expect(post).toHaveBeenCalledTimes(4);

      const projectionReadCount = jest.mocked(productionApi.getBatchProjections).mock.calls.length;
      jest
        .mocked(productionApi.getBatchProjections)
        .mockRejectedValueOnce(new Error('temporary projection read failure'))
        .mockResolvedValueOnce(reconciliation.projection);
      configureMount();
      elements = renderForm(acceptedWhileUnmountedOnSaved);
      const acceptedRemountCleanups = effects.slice().map((effect) => effect());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(4);
      expect(productionApi.getBatchProjections).toHaveBeenCalledTimes(projectionReadCount + 1);
      expect(getSamplingWriteRecovery(batchId)).toMatchObject({
        submission: thirdSubmission,
        inFlight: false,
        promise: null,
        retryOutcome: 'reconciliation_failed',
      });
      expect(acceptedWhileUnmountedOnSaved).not.toHaveBeenCalled();
      expect(routeState.projection.estimated_remaining_population).toBe(100);

      elements = renderForm(acceptedWhileUnmountedOnSaved);
      expect(buttonWithText(elements, 'Reconcile previous sampling').props.disabled).toBe(false);
      buttonWithText(elements, 'Reconcile previous sampling').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(4);
      expect(productionApi.getBatchProjections).toHaveBeenCalledTimes(projectionReadCount + 2);
      expect(acceptedWhileUnmountedOnSaved).toHaveBeenCalledWith(thirdSubmission, reconciliation);
      expect(routeState.projection.estimated_remaining_population).toBe(75);
      expect(routeState.events).toEqual(reconciliation.events);
      expect(getSamplingWriteRecovery(batchId)).toBeNull();
      expect(getMortalityWriteRecovery(batchId)).toBeNull();
      acceptedRemountCleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('sampling form does not claim population replacement when estimated_population is omitted', () => {
    let values: Record<string, string> = {
      performed_at: '2026-09-26T08:30',
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: '',
      maximum_weight: '',
      weight_unit: 'g',
      estimated_population: '',
      notes: '',
    };
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    stateSpy.mockReset();
    [
      [
        values,
        (update: (current: Record<string, string>) => Record<string, string>) => {
          values = update(values);
        },
      ],
      [false, jest.fn()],
      [null, jest.fn()],
      [false, jest.fn()],
      [null, jest.fn()],
      [null, jest.fn()],
      [false, jest.fn()],
    ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
    refSpy
      .mockReset()
      .mockReturnValueOnce({ current: false })
      .mockReturnValueOnce({ current: null })
      .mockReturnValueOnce({ current: 0 })
      .mockReturnValueOnce({ current: true })
      .mockReturnValueOnce({ current: null });

    try {
      const tree = SamplingForm({
        batchId: 'batch-sampling',
        currentEstimatedRemainingPopulation: 25000,
      });
      const textContent = (node: unknown): string[] => {
        if (Array.isArray(node)) return node.flatMap(textContent);
        if (typeof node === 'string' || typeof node === 'number') return [String(node)];
        if (React.isValidElement(node)) {
          return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
        }
        return [];
      };
      expect(textContent(tree).join(' ')).not.toContain(
        'replace the projected remaining population',
      );
    } finally {
      jest.restoreAllMocks();
    }
  });

  test.each([
    ['positive', 200, '250', 'Population change: +50', '4.8', 'Average weight: 4.8 g'],
    ['negative', 250, '200', 'Population change: -50', '4.8', 'Average weight: 4.8 g'],
    ['zero', 250, '250', 'Population change: 0', '4.8', 'Average weight: 4.8 g'],
    ['unknown current population', Number.NaN, '200', null, '4.8', 'Average weight: 4.8 g'],
    ['zero average weight', 200, '250', 'Population change: +50', '0', 'Average weight: 0 g'],
    [
      'empty average weight',
      200,
      '250',
      'Population change: +50',
      '  ',
      'Average weight: Not entered g',
    ],
  ])(
    'sampling confirmation displays %s population change and weight values',
    (
      _label,
      currentPopulation,
      proposedPopulation,
      expectedChange,
      averageWeight,
      expectedAverage,
    ) => {
      const values: Record<string, string> = {
        performed_at: '2026-09-26T08:30',
        sample_size: '30',
        average_weight: averageWeight,
        minimum_weight: '0',
        maximum_weight: '0',
        weight_unit: 'g',
        estimated_population: proposedPopulation,
        notes: '',
      };
      let confirmed = true;
      let confirmedSnapshot: string | null = createSamplingDraftSignature('batch-sampling', {
        performed_at: '2026-09-26T08:30',
        sample_size: '30',
        average_weight: averageWeight,
        minimum_weight: '0',
        maximum_weight: '0',
        weight_unit: 'g',
        estimated_population: proposedPopulation,
        notes: '',
      });
      const stateSpy = React.useState as unknown as jest.Mock;
      const refSpy = React.useRef as unknown as jest.Mock;
      const setConfirmed = (next: boolean) => {
        confirmed = next;
      };
      const setSnapshot = (next: string | null) => {
        confirmedSnapshot = next;
      };
      const inFlight = { current: false };
      const retrySubmission = { current: null as SamplingSubmission | null };
      const draftRevision = { current: 0 };

      const renderForm = () => {
        stateSpy.mockReset();
        [
          [values, jest.fn()],
          [confirmed, setConfirmed],
          [confirmedSnapshot, setSnapshot],
          [false, jest.fn()],
          [null, jest.fn()],
          [null, jest.fn()],
          [false, jest.fn()],
        ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
        refSpy
          .mockReset()
          .mockReturnValueOnce(inFlight)
          .mockReturnValueOnce(retrySubmission)
          .mockReturnValueOnce(draftRevision)
          .mockReturnValueOnce({ current: true })
          .mockReturnValueOnce({ current: null });
        return SamplingForm({
          batchId: 'batch-sampling',
          currentEstimatedRemainingPopulation: currentPopulation,
        });
      };
      const childrenText = (node: unknown): string => {
        if (Array.isArray(node)) return node.map(childrenText).join(' ');
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (React.isValidElement(node)) {
          return childrenText((node as React.ReactElement<{ children?: unknown }>).props.children);
        }
        return '';
      };
      try {
        const preview = childrenText(renderForm()).replace(/\s+/g, ' ').trim();
        expect(preview).toContain(expectedAverage);
        expect(preview).toContain('Minimum weight: 0 g');
        expect(preview).toContain('Maximum weight: 0 g');
        expect(preview).toContain(`Proposed estimated population: ${proposedPopulation}`);
        if (expectedChange) expect(preview).toContain(expectedChange);
        else expect(preview).not.toContain('Population change:');
      } finally {
        jest.restoreAllMocks();
      }
    },
  );

  test('sampling form edit invalidates confirmation and a retained ambiguous retry', async () => {
    const values: Record<string, string> = {
      performed_at: '2026-09-26T08:30',
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: '',
      maximum_weight: '',
      weight_unit: 'g',
      estimated_population: '',
      notes: '',
    };
    let confirmed = true;
    let confirmedSnapshot: string | null = createSamplingDraftSignature('batch-sampling', {
      performed_at: '2026-09-26T08:30',
      sample_size: '30',
      average_weight: '4.8',
      minimum_weight: null,
      maximum_weight: null,
      weight_unit: 'g',
      estimated_population: null,
      notes: '',
    });
    const stateSpy = React.useState as unknown as jest.Mock;
    const refSpy = React.useRef as unknown as jest.Mock;
    const inFlight = { current: false };
    const retryRef = {
      current: createSamplingSubmission('batch-sampling', {
        sample_size: '30',
        average_weight: '4.8',
      }) as SamplingSubmission | null,
    };
    const revision = { current: 0 };
    const setValues = jest.fn();
    const setConfirmed = (value: boolean) => {
      confirmed = value;
    };
    const setSnapshot = (value: string | null) => {
      confirmedSnapshot = value;
    };
    const renderForm = () => {
      stateSpy.mockReset();
      [
        [values, setValues],
        [confirmed, setConfirmed],
        [confirmedSnapshot, setSnapshot],
        [false, jest.fn()],
        [null, jest.fn()],
        [null, jest.fn()],
        [false, jest.fn()],
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy
        .mockReset()
        .mockReturnValueOnce(inFlight)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision)
        .mockReturnValueOnce({ current: true })
        .mockReturnValueOnce({ current: null });
      return SamplingForm({ batchId: 'batch-sampling' });
    };

    try {
      const tree = renderForm();
      const inputs: React.ReactElement[] = [];
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(visit);
        else if (React.isValidElement(node)) {
          const element = node as React.ReactElement<{ children?: unknown }>;
          inputs.push(element);
          visit(element.props.children);
        }
      };
      visit(tree);
      const sampleSizeInput = inputs.find((element) => element.type === TextInput);
      (sampleSizeInput?.props as { onChangeText: (value: string) => void }).onChangeText('45');

      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(retryRef.current).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('stocking write workflow', () => {
  const stockingContext: WaterQualityWriteContext = {
    batchId: 'batch-stocking',
    batchName: 'B-STOCK',
    farmName: 'North Farm',
    unitName: 'Pond 1',
  };
  const stockingInput: StockingInput = {
    species_code: 'WHITE_SHRIMP',
    quantity: '25000',
    average_weight: '0.02',
    weight_unit: 'g',
    stocked_at: '2026-10-04T08:30',
    source: 'Hatchery 4',
    notes: 'PL10 cohort',
  };

  test('builds the physical stocking payload without moving stocked_at into lifecycle performed_at', () => {
    const payload = buildStockingPayload(stockingInput);
    expect(payload).toEqual({
      species_code: 'WHITE_SHRIMP',
      quantity: 25000,
      average_weight: 0.02,
      weight_unit: 'g',
      stocked_at: normalizeProductionEventTime(stockingInput.stocked_at),
      source: 'Hatchery 4',
      notes: 'PL10 cohort',
    });
    expect(payload).not.toHaveProperty('performed_at');
    expect(() => buildStockingPayload({ ...stockingInput, quantity: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => buildStockingPayload({ ...stockingInput, average_weight: '-1' })).toThrow(
      /zero or greater/,
    );
    expect(() => buildStockingPayload({ ...stockingInput, species_code: ' ' })).toThrow(
      /species_code/,
    );
  });

  test('preserves identity and accepted reconciliation state without generating another POST', async () => {
    const submission = createStockingSubmission(
      stockingContext.batchId,
      stockingInput,
      'stocking-recovery-key',
      stockingContext,
    );
    const reconciliation: WaterQualityReconciliationData = {
      batch: { id: stockingContext.batchId, state: 'stocked', stocked_at: '2026-10-04T08:31:00Z' },
      projection: { batch_id: stockingContext.batchId, initial_stocked_quantity: 25000 },
      events: [{ event_type: 'STOCKING', performed_at: '2026-10-04T08:31:00Z' }],
    };
    const post = jest.fn().mockResolvedValue({ id: 'event-stocking', event_type: 'STOCKING' });
    const readAll = jest.fn().mockResolvedValue(reconciliation);
    const first = await reconcileStockingWrite({
      context: stockingContext,
      payload: stockingInput,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(first.outcome).toBe('accepted');
    expect(submission.performedAt).toBeUndefined();
    expect(post).toHaveBeenCalledWith(
      stockingContext.batchId,
      'STOCKING',
      submission.payload,
      submission.idempotencyKey,
    );
    expect(getStockingWriteRecovery(stockingContext.batchId)).toMatchObject({
      submission,
      inFlight: false,
      retryOutcome: 'accepted',
    });
    expect(getSamplingWriteRecovery(stockingContext.batchId)).toBeNull();
    clearStockingWriteRecovery(stockingContext.batchId, submission.idempotencyKey);
    const replay = await reconcileStockingWrite({
      context: stockingContext,
      payload: stockingInput,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readAll,
    });
    expect(replay.outcome).toBe('accepted');
    expect(replay.reconciliation).toEqual(reconciliation);
    expect(post).toHaveBeenCalledTimes(1);
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(getStockingWriteRecovery(stockingContext.batchId)?.retryOutcome).toBe('accepted');
    clearStockingWriteRecovery(stockingContext.batchId, submission.idempotencyKey);
    expect(getStockingWriteRecovery(stockingContext.batchId)).toBeNull();
  });
});

describe('transfer write workflow', () => {
  const SOURCE = 'batch-src';
  const DEST = 'batch-dst';
  const transferInput: TransferInput = {
    source_unit_id: 'unit-src',
    destination_unit_id: 'unit-dst',
    destination_batch_id: DEST,
    quantity: '200',
    transfer_loss: '5',
    average_weight: '1.5',
    weight_unit: 'g',
    transferred_at: '2024-05-01T10:00:00Z',
    notes: 'Move to grow-out',
  };
  const networkFailure = () =>
    new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'Network request failed');
  const httpFailure = (status: number, code?: string) =>
    new ApiError(status, 'rejected', 'http://api', '/p', code);

  const pairEvents = (
    submission: TransferSubmission,
    transferId = 'transfer-1',
    overrides: { out?: Record<string, unknown>; in?: Record<string, unknown> } = {},
  ) => {
    const base = {
      event_type: 'TRANSFER',
      transfer_id: transferId,
      data: submission.payload,
    };
    return {
      out: {
        ...base,
        id: 'event-out',
        batch_id: SOURCE,
        transfer_role: 'out',
        idempotency_key: submission.idempotencyKey,
        ...overrides.out,
      },
      in: {
        ...base,
        id: 'event-in',
        batch_id: DEST,
        transfer_role: 'in',
        idempotency_key: null,
        ...overrides.in,
      },
    };
  };

  type Pages = Record<string, Array<Record<string, unknown>[]>>;
  const makeReaders = (pages: Pages) => {
    const listEvents = jest.fn(
      async (batchId: string, options: { limit: number; cursor?: string; eventType?: string }) => {
        const list = pages[batchId] ?? [[]];
        const index = options.cursor ? Number(options.cursor.replace('cursor-', '')) : 0;
        return {
          items: list[index] ?? [],
          next_cursor: index + 1 < list.length ? `cursor-${index + 1}` : null,
        };
      },
    );
    const getBatch = jest.fn(async (id: string) => ({ id, state: 'active' }));
    const getProjection = jest.fn(async (id: string) => ({ batch_id: id }));
    const readers: TransferReaders = { getBatch, getProjection, listEvents };
    return { readers, listEvents, getBatch, getProjection };
  };

  const run = (
    submission: TransferSubmission,
    post: jest.Mock,
    readers: TransferReaders,
    batchId = SOURCE,
  ) =>
    reconcileTransferWrite({
      context: { batchId },
      payload: submission.payload,
      idempotencyKey: submission.idempotencyKey,
      submission,
      post,
      readers,
    });
  const newSubmission = (key: string, input: TransferInput = transferInput) =>
    createTransferSubmission(SOURCE, input, key, { batchId: SOURCE });
  const cleanup = (submission: TransferSubmission) =>
    clearTransferWriteRecovery(submission.batchId, submission.idempotencyKey);
  afterEach(() => {
    const leftover = getTransferWriteRecovery(SOURCE);
    if (leftover) clearTransferWriteRecovery(SOURCE, leftover.submission.idempotencyKey);
  });

  test('validates TRANSFER payload and normalizes the physical time to UTC', () => {
    expect(buildTransferPayload(transferInput)).toEqual({
      source_unit_id: 'unit-src',
      destination_unit_id: 'unit-dst',
      destination_batch_id: DEST,
      quantity: 200,
      transfer_loss: 5,
      average_weight: 1.5,
      weight_unit: 'g',
      transferred_at: '2024-05-01T10:00:00.000Z',
      notes: 'Move to grow-out',
    });
    const offset = buildTransferPayload({
      ...transferInput,
      transferred_at: '2024-05-01T10:00:00-05:00',
    });
    expect(offset.transferred_at).toBe('2024-05-01T15:00:00.000Z');
    const minimal = buildTransferPayload({
      ...transferInput,
      average_weight: '',
      transfer_loss: undefined,
      notes: ' ',
    });
    expect(minimal).not.toHaveProperty('average_weight');
    expect(minimal).not.toHaveProperty('weight_unit');
    expect(minimal).not.toHaveProperty('notes');
    expect(minimal.transfer_loss).toBe(0);
    expect(buildTransferPayload({ ...transferInput, weight_unit: 'kg' }).weight_unit).toBe('kg');
  });

  test('rejects invalid TRANSFER input before any write', () => {
    const invalid = (patch: Partial<TransferInput>) =>
      buildTransferPayload({ ...transferInput, ...patch });
    expect(() => invalid({ quantity: 0 })).toThrow(/positive integer/);
    expect(() => invalid({ quantity: '1.5' })).toThrow(/positive integer/);
    expect(() => invalid({ transfer_loss: -1 })).toThrow(/transfer_loss/);
    expect(() => invalid({ transfer_loss: '1.2' })).toThrow(/transfer_loss/);
    expect(() => invalid({ average_weight: -1 })).toThrow(/zero or greater/);
    expect(() => invalid({ weight_unit: 'lb' })).toThrow(/g or kg/);
    expect(() => invalid({ transferred_at: 'invalid' })).toThrow(/physical transfer time/);
    expect(() => invalid({ transferred_at: '2999-01-01T00:00:00Z' })).toThrow(/future/);
    expect(() => invalid({ destination_batch_id: '' })).toThrow(/eligible destinations/);
    expect(() => invalid({ destination_unit_id: 'unit-src' })).toThrow(/differ/);
    expect(() => invalid({ source_unit_id: null })).toThrow(/source unit/);
    expect(() => invalid({ notes: 'x'.repeat(1001) })).toThrow(/at most 1000/);
  });

  test('posts once, reconciles both batches, and matches OUT and IN by transfer_id', async () => {
    const submission = newSubmission('transfer-key-ok');
    const events = pairEvents(submission);
    const { readers, getBatch, getProjection, listEvents } = makeReaders({
      [SOURCE]: [[events.out]],
      [DEST]: [[events.in]],
    });
    const post = jest.fn().mockResolvedValue({ ...events.out, transfer_id: 'transfer-1' });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      SOURCE,
      'TRANSFER',
      submission.payload,
      'transfer-key-ok',
      undefined,
    );
    expect(getBatch.mock.calls.map((call) => call[0]).sort()).toEqual([DEST, SOURCE]);
    expect(getProjection.mock.calls.map((call) => call[0]).sort()).toEqual([DEST, SOURCE]);
    expect(
      listEvents.mock.calls.filter((call) => call[1].eventType === 'TRANSFER').map((c) => c[0]),
    ).toEqual([SOURCE, DEST]);
    expect(result.reconciliation).toMatchObject({
      transfer_id: 'transfer-1',
      batch: { id: SOURCE },
      destination: { batch: { id: DEST } },
    });
    expect(getTransferWriteRecovery(SOURCE)?.retryOutcome).toBe('accepted');
    cleanup(submission);
    expect(getTransferWriteRecovery(SOURCE)).toBeNull();
  });

  test('pages TRANSFER timelines with opaque cursors on both batches', async () => {
    const submission = newSubmission('transfer-key-paging');
    const events = pairEvents(submission);
    const noise = { event_type: 'TRANSFER', transfer_id: 'other', transfer_role: 'out' };
    const { readers, listEvents } = makeReaders({
      [SOURCE]: [[noise], [noise], [events.out]],
      [DEST]: [[noise], [events.in]],
    });
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('accepted');
    const transferCalls = listEvents.mock.calls.filter((c) => c[1].eventType === 'TRANSFER');
    expect(transferCalls.map((c) => [c[0], c[1].cursor])).toEqual([
      [SOURCE, undefined],
      [SOURCE, 'cursor-1'],
      [SOURCE, 'cursor-2'],
      [DEST, undefined],
      [DEST, 'cursor-1'],
    ]);
    cleanup(submission);
  });

  test('reports a fully read timeline without the pair as an integrity anomaly and never re-posts', async () => {
    const submission = newSubmission('transfer-key-anomaly');
    const events = pairEvents(submission);
    const { readers } = makeReaders({ [SOURCE]: [[events.out]], [DEST]: [[]] });
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const first = await run(submission, post, readers);
    expect(first.outcome).toBe('reconciliation_failed');
    expect(first.posted).toBe(true);
    expect(first.error).toBeInstanceOf(TransferReconciliationError);
    expect((first.error as TransferReconciliationError).kind).toBe('integrity_anomaly');
    expect(getTransferWriteRecovery(SOURCE)?.retryOutcome).toBe('reconciliation_failed');
    const second = await run(submission, post, readers);
    expect(second.outcome).toBe('reconciliation_failed');
    expect(post).toHaveBeenCalledTimes(1);
    cleanup(submission);
  });

  test('treats read failures as incomplete reconciliation, preserves acceptance, and recovers read-only', async () => {
    const submission = newSubmission('transfer-key-readfail');
    const events = pairEvents(submission);
    const { readers, getBatch } = makeReaders({
      [SOURCE]: [[events.out]],
      [DEST]: [[events.in]],
    });
    getBatch.mockRejectedValueOnce(new Error('destination unavailable'));
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const failed = await run(submission, post, readers);
    expect(failed.outcome).toBe('reconciliation_failed');
    expect(failed.retrySubmission).toBe(submission);
    expect(getTransferWriteRecovery(SOURCE)?.retryOutcome).toBe('reconciliation_failed');
    const recovered = await run(submission, post, readers);
    expect(recovered.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(1);
    cleanup(submission);
  });

  test('flags an exhausted-cap pagination as an incomplete read, not an anomaly', async () => {
    const submission = newSubmission('transfer-key-cap');
    const events = pairEvents(submission);
    const listEvents = jest.fn(async () => ({
      items: [{ event_type: 'TRANSFER', transfer_id: 'noise', transfer_role: 'out' }],
      next_cursor: `c-${Math.random()}`,
    }));
    const readers: TransferReaders = {
      getBatch: async (id) => ({ id }),
      getProjection: async (id) => ({ id }),
      listEvents,
    };
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('reconciliation_failed');
    expect((result.error as TransferReconciliationError).kind).toBe('incomplete_read');
    cleanup(submission);
  });

  test.each([
    ['wrong source role', { out: { transfer_role: 'in' } }],
    ['mismatched quantity', { out: { data: { quantity: 1 } } }],
    ['mismatched destination batch', { out: { data: { destination_batch_id: 'other' } } }],
  ])('fails reconciliation on %s for the OUT event', async (_label, overrides) => {
    const submission = newSubmission(`transfer-key-mm-${_label}`);
    const events = pairEvents(submission);
    const out = {
      ...events.out,
      ...overrides.out,
      data: { ...submission.payload, ...((overrides.out as { data?: object }).data ?? {}) },
    };
    const { readers } = makeReaders({ [SOURCE]: [[out]], [DEST]: [[events.in]] });
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('reconciliation_failed');
    expect(post).toHaveBeenCalledTimes(1);
    cleanup(submission);
  });

  test('fails reconciliation when the destination IN event is on the wrong batch or mismatched', async () => {
    const submission = newSubmission('transfer-key-in-mismatch');
    const events = pairEvents(submission);
    const badIn = { ...events.in, data: { ...submission.payload, quantity: 199 } };
    const { readers } = makeReaders({ [SOURCE]: [[events.out]], [DEST]: [[badIn]] });
    const post = jest.fn().mockResolvedValue({ ...events.out });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('reconciliation_failed');
    expect((result.error as TransferReconciliationError).kind).toBe('pair_mismatch');
    cleanup(submission);
  });

  test('fails reconciliation when the server transfer_id differs from the OUT event', async () => {
    const submission = newSubmission('transfer-key-id-mismatch');
    const events = pairEvents(submission, 'transfer-A');
    const { readers } = makeReaders({ [SOURCE]: [[events.out]], [DEST]: [[events.in]] });
    const post = jest.fn().mockResolvedValue({ ...events.out, transfer_id: 'transfer-B' });
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe('reconciliation_failed');
    expect((result.error as TransferReconciliationError).kind).toBe('pair_mismatch');
    cleanup(submission);
  });

  test('a response without transfer_id is an uncertain outcome that retries with the same key', async () => {
    const submission = newSubmission('transfer-key-no-id');
    const events = pairEvents(submission);
    const { readers } = makeReaders({ [SOURCE]: [[events.out]], [DEST]: [[events.in]] });
    const post = jest
      .fn()
      .mockResolvedValueOnce({ id: 'event-out', transfer_id: null })
      .mockResolvedValueOnce({ ...events.out });
    const first = await run(submission, post, readers);
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);
    const retry = await run(submission, post, readers);
    expect(retry.outcome).toBe('accepted');
    expect(post.mock.calls.map((c) => c[3])).toEqual(['transfer-key-no-id', 'transfer-key-no-id']);
    cleanup(submission);
  });

  test('retries a timeout with the exact original submission and idempotency key', async () => {
    const submission = newSubmission('transfer-key-timeout');
    const events = pairEvents(submission);
    const { readers } = makeReaders({ [SOURCE]: [[events.out]], [DEST]: [[events.in]] });
    const post = jest
      .fn()
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce({ ...events.out });
    const first = await run(submission, post, readers);
    expect(first.outcome).toBe('outcome_unknown');
    expect(first.retrySubmission).toBe(submission);
    expect(getTransferWriteRecovery(SOURCE)?.retryOutcome).toBe('outcome_unknown');
    const retry = await run(first.retrySubmission as TransferSubmission, post, readers);
    expect(retry.outcome).toBe('accepted');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    cleanup(submission);
  });

  test('does not allow a different payload under the same key or a second unresolved transfer', async () => {
    const submission = newSubmission('transfer-key-guard');
    const post = jest.fn().mockRejectedValue(networkFailure());
    const { readers } = makeReaders({ [SOURCE]: [[]], [DEST]: [[]] });
    await run(submission, post, readers);
    const changed = newSubmission('transfer-key-guard', { ...transferInput, quantity: '201' });
    expect(() => run(changed, post, readers)).toThrow(/unresolved TRANSFER/);
    const other = newSubmission('transfer-key-other');
    expect(() => run(other, post, readers)).toThrow(/unresolved TRANSFER/);
    expect(post).toHaveBeenCalledTimes(1);
    cleanup(submission);
  });

  test('rejects a preserved submission that no longer matches the intent', () => {
    const submission = newSubmission('transfer-key-intent');
    const { readers } = makeReaders({});
    expect(() =>
      reconcileTransferWrite({
        context: { batchId: SOURCE },
        payload: { ...transferInput, quantity: '201' },
        idempotencyKey: submission.idempotencyKey,
        submission,
        post: jest.fn(),
        readers,
      }),
    ).toThrow(/does not match the current intent/);
  });

  test.each([
    [403, undefined, 'write_failed'],
    [404, undefined, 'write_failed'],
    [409, 'transfer_exceeds_population', 'rejected'],
    [409, 'unit_under_maintenance', 'rejected'],
    [409, undefined, 'rejected'],
    [422, 'transfer_destination_ineligible', 'rejected'],
  ])('treats HTTP %s (%s) as definitive with no retry', async (status, code, outcome) => {
    const submission = newSubmission(`transfer-key-http-${status}-${code}`);
    const { readers } = makeReaders({});
    const post = jest.fn().mockRejectedValue(httpFailure(status, code));
    const result = await run(submission, post, readers);
    expect(result.outcome).toBe(outcome);
    expect(result.retrySubmission).toBeNull();
    expect(result.response?.status).toBe(status);
    expect(result.response?.code).toBe(code);
    expect(getTransferWriteRecovery(SOURCE)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('transfer form workflow', () => {
  const BATCH = 'batch-form';
  const DEST = 'batch-form-dst';
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let stateValues: unknown[] = [];
  let refs: Array<{ current: unknown }> = [];
  let effects: Array<() => unknown> = [];
  let stateIndex = 0;
  let refIndex = 0;
  let lastKey = '';
  let lastData: Record<string, unknown> = {};
  let transferEventsReady = true;

  const textContent = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(textContent).join(' ');
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (React.isValidElement(node)) {
      return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
    }
    return '';
  };
  const configureMount = () => {
    stateValues = [];
    refs = [];
    effects = [];
    stateIndex = 0;
    refIndex = 0;
    (React.useState as unknown as jest.Mock).mockReset().mockImplementation((initial: unknown) => {
      const index = stateIndex++;
      if (stateValues.length <= index) {
        stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
      }
      return [
        stateValues[index],
        (next: unknown) => {
          stateValues[index] =
            typeof next === 'function'
              ? (next as (current: unknown) => unknown)(stateValues[index])
              : next;
        },
      ];
    });
    (React.useRef as unknown as jest.Mock).mockReset().mockImplementation((initial: unknown) => {
      const index = refIndex++;
      if (refs.length <= index) refs.push({ current: initial });
      return refs[index];
    });
    (React.useEffect as unknown as jest.Mock).mockReset().mockImplementation((e: () => unknown) => {
      effects.push(e);
    });
  };
  const render = (props: Partial<React.ComponentProps<typeof TransferForm>> = {}) => {
    stateIndex = 0;
    refIndex = 0;
    const onSaved = props.onSaved ?? jest.fn();
    const tree = TransferForm({
      batchId: BATCH,
      batchName: 'B-SRC',
      farmName: 'North Farm',
      unitName: 'Pond 1',
      sourceUnitId: 'unit-src',
      batchState: 'active',
      currentEstimatedRemainingPopulation: 1000,
      onSaved,
      ...props,
    });
    const elements: React.ReactElement[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (React.isValidElement(node)) {
        const element = node as React.ReactElement<{ children?: unknown }>;
        elements.push(element);
        visit(element.props.children);
      }
    };
    visit(tree);
    return { tree, elements, text: textContent(tree).replace(/\s+/g, ' ') };
  };
  type Pressed = React.ReactElement<{ onPress: () => unknown; disabled?: boolean }>;
  const button = (elements: React.ReactElement[], text: string) =>
    elements.find(
      (element) =>
        element.type === Pressable &&
        textContent(
          (element as React.ReactElement<{ children?: unknown }>).props.children,
        ).includes(text),
    ) as Pressed | undefined;
  const inputs = (elements: React.ReactElement[]) =>
    elements.filter((element) => element.type === TextInput) as Array<
      React.ReactElement<{ onChangeText: (value: string) => void; editable?: boolean }>
    >;

  const api = productionApi as jest.Mocked<typeof productionApi>;
  const installApi = () => {
    lastKey = '';
    transferEventsReady = true;
    api.createBatchEvent.mockReset().mockImplementation(async (_batchId, body, key) => {
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      return {
        id: 'event-out',
        event_type: 'TRANSFER',
        batch_id: BATCH,
        transfer_id: 'transfer-form-1',
        transfer_role: 'out',
        idempotency_key: key,
      };
    });
    api.getProductionBatch.mockReset().mockImplementation(async (id) => ({ id, state: 'active' }));
    api.getBatchProjections
      .mockReset()
      .mockImplementation(async (id) => ({ batch_id: id, estimated_remaining_population: 1000 }));
    api.listBatchEvents.mockReset().mockImplementation(async (id, options) => {
      if (options?.eventType !== 'TRANSFER' || !transferEventsReady) {
        return { items: [], next_cursor: null, limit: 25 };
      }
      const isSource = id === BATCH;
      return {
        items: [
          {
            event_type: 'TRANSFER',
            transfer_id: 'transfer-form-1',
            transfer_role: isSource ? 'out' : 'in',
            batch_id: id,
            idempotency_key: isSource ? lastKey : null,
            data: lastData,
          },
        ],
        next_cursor: null,
        limit: 100,
      };
    });
    api.listTransferDestinations.mockReset().mockResolvedValue([
      { id: DEST, unit_id: 'unit-dst', label: 'Pond 2 · B-DST' },
      { id: BATCH, unit_id: 'unit-other', label: 'Source batch should be hidden' },
      { id: 'batch-same-unit', unit_id: 'unit-src', label: 'Same unit should be hidden' },
    ]);
  };

  const mount = async (props: Partial<React.ComponentProps<typeof TransferForm>> = {}) => {
    configureMount();
    render(props);
    const cleanups = effects.map((effect) => effect());
    await flush();
    return { cleanups, view: render(props) };
  };
  const fillAndConfirm = (props: Partial<React.ComponentProps<typeof TransferForm>> = {}) => {
    let view = render(props);
    button(view.elements, 'Pond 2')!.props.onPress();
    view = render(props);
    const fields = inputs(view.elements);
    fields[0].props.onChangeText('200');
    fields[1].props.onChangeText('5');
    fields[2].props.onChangeText('1.5');
    fields[3].props.onChangeText('2024-05-01T10:00:00Z');
    view = render(props);
    button(view.elements, 'I confirm transferring')!.props.onPress();
    return render(props);
  };

  beforeEach(() => installApi());
  afterEach(() => {
    const leftover = getTransferWriteRecovery(BATCH);
    if (leftover) clearTransferWriteRecovery(BATCH, leftover.submission.idempotencyKey);
    jest.restoreAllMocks();
  });

  test('offers only server-returned destinations and excludes the source batch and unit', async () => {
    const { view } = await mount();
    expect(api.listTransferDestinations).toHaveBeenCalledWith(BATCH);
    expect(view.text).toContain('Pond 2 · B-DST');
    expect(view.text).not.toContain('Source batch should be hidden');
    expect(view.text).not.toContain('Same unit should be hidden');
  });

  test('is disabled for non-STOCKED/ACTIVE source batches', async () => {
    configureMount();
    const view = render({ batchState: 'planned' });
    expect(view.text).toContain('Transfers require an authoritative STOCKED, ACTIVE or SUSPENDED');
    expect(inputs(view.elements).every((input) => input.props.editable === false)).toBe(true);
    expect(button(view.elements, 'Submit transfer')!.props.disabled).toBe(true);
    expect(api.listTransferDestinations).not.toHaveBeenCalled();
  });

  test('requires explicit confirmation with source, destination, and remaining-population review', async () => {
    await mount();
    let view = render();
    button(view.elements, 'Pond 2')!.props.onPress();
    view = render();
    const fields = inputs(view.elements);
    fields[0].props.onChangeText('200');
    fields[1].props.onChangeText('5');
    view = render();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    view = render();
    expect(view.text).toContain('Explicitly confirm the source and destination');
    button(view.elements, 'I confirm transferring')!.props.onPress();
    view = render();
    expect(view.text).toContain('Source: B-SRC · Pond 1 ( unit-src )');
    expect(view.text).toContain('Destination: Pond 2 · B-DST');
    expect(view.text).toContain('Net transferred: 200');
    expect(view.text).toContain('Loss in transit: 5');
    expect(view.text).toContain('Source remaining after transfer: 795');
    expect(view.text).toContain('Farm: North Farm');
  });

  test('rejects quantity plus loss above the known remaining population before posting', async () => {
    await mount();
    let view = render();
    button(view.elements, 'Pond 2')!.props.onPress();
    view = render();
    const fields = inputs(view.elements);
    fields[0].props.onChangeText('999');
    fields[1].props.onChangeText('5');
    view = render();
    button(view.elements, 'I confirm transferring')!.props.onPress();
    view = render();
    expect(view.text).toContain('exceeds the current remaining population');
    expect(api.createBatchEvent).not.toHaveBeenCalled();
  });

  test('submits once with UTC transferred_at, no performed_at, and reconciles both batches', async () => {
    const onSaved = jest.fn();
    await mount({ onSaved });
    const view = fillAndConfirm({ onSaved });
    const submit = button(view.elements, 'Submit transfer')!;
    const first = submit.props.onPress();
    const second = submit.props.onPress();
    await Promise.all([first, second]);
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    const [batchId, body, key] = api.createBatchEvent.mock.calls[0];
    expect(batchId).toBe(BATCH);
    expect(body).not.toHaveProperty('performed_at');
    expect(body.data).toMatchObject({
      source_unit_id: 'unit-src',
      destination_unit_id: 'unit-dst',
      destination_batch_id: DEST,
      quantity: 200,
      transfer_loss: 5,
      average_weight: 1.5,
      weight_unit: 'g',
      transferred_at: '2024-05-01T10:00:00.000Z',
    });
    expect(key).toBe(lastKey);
    expect(onSaved).toHaveBeenCalledTimes(1);
    const reconciliation = onSaved.mock.calls[0][1];
    expect(reconciliation.transfer_id).toBe('transfer-form-1');
    expect(reconciliation.destination.batch.id).toBe(DEST);
    expect(getTransferWriteRecovery(BATCH)).toBeNull();
    expect(render().text).toContain('recorded and verified on both');
  });

  test('resets the draft after a verified transfer and requires fresh input and confirmation', async () => {
    await mount();
    const destinationLoadsBefore = api.listTransferDestinations.mock.calls.length;
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    const after = render();
    expect(after.text).toContain('recorded and verified on both');
    expect(api.listTransferDestinations.mock.calls.length).toBe(destinationLoadsBefore + 1);
    const fields = inputs(after.elements) as Array<
      React.ReactElement<{ value?: string; onChangeText: (value: string) => void }>
    >;
    expect(fields[0].props.value).toBe('');
    expect(fields[1].props.value).toBe('0');
    expect(fields[2].props.value).toBe('');
    expect(fields[4].props.value).toBe('');
    expect(after.text).not.toContain('Source remaining after transfer');
    expect(after.text).toContain('I confirm transferring from B-SRC to the selected destination');
    fields[0].props.onChangeText('10');
    await button(render().elements, 'Submit transfer')!.props.onPress();
    expect(render().text).toContain('Explicitly confirm the source and destination');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('does not reset into a writable form while an accepted transfer is unreconciled', async () => {
    await mount();
    transferEventsReady = false;
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    const after = render();
    const first = inputs(after.elements)[0] as React.ReactElement<{ value?: string }>;
    expect(first.props.value).toBe('200');
    expect(after.text).not.toContain('recorded and verified on both');
    expect(button(after.elements, 'Submit transfer')).toBeUndefined();
    expect(button(after.elements, 'Reconcile previous transfer')).toBeTruthy();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('keeps the accepted write through failed reconciliation and never posts again', async () => {
    await mount();
    transferEventsReady = false;
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    let after = render();
    expect(after.text).toContain('Transfer recorded — refresh to confirm');
    expect(getTransferWriteRecovery(BATCH)?.retryOutcome).toBe('reconciliation_failed');
    expect(button(after.elements, 'Reconcile previous transfer')).toBeTruthy();
    expect(button(after.elements, 'Submit transfer')).toBeUndefined();
    expect(inputs(after.elements).every((input) => input.props.editable === false)).toBe(true);
    transferEventsReady = true;
    await button(after.elements, 'Reconcile previous transfer')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    after = render();
    expect(after.text).toContain('recorded and verified on both');
  });

  test('allows a SUSPENDED source with valid population to transfer', async () => {
    const props = { batchState: 'suspended' };
    await mount(props);
    expect(api.listTransferDestinations).toHaveBeenCalledTimes(1);
    const view = fillAndConfirm(props);
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(render(props).text).toContain('recorded and verified on both');
  });

  test.each(['failed', 'cancelled', 'closed', 'planned'])(
    'does not allow a new transfer from a %s source batch',
    async (batchState) => {
      configureMount();
      const view = render({ batchState });
      effects.forEach((effect) => effect());
      await flush();
      expect(view.text).toContain('STOCKED, ACTIVE or SUSPENDED');
      expect(button(view.elements, 'Submit transfer')!.props.disabled).toBe(true);
      expect(api.listTransferDestinations).not.toHaveBeenCalled();
      await button(view.elements, 'Submit transfer')!.props.onPress();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
    },
  );

  test.each(['suspended', 'failed'])(
    'keeps an uncertain transfer recoverable with the same key after the source becomes %s',
    async (laterState) => {
      const { cleanups } = await mount();
      api.createBatchEvent.mockReset().mockImplementationOnce(async (_b, body, key) => {
        lastKey = key;
        lastData = (body.data ?? {}) as Record<string, unknown>;
        throw new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'timeout');
      });
      const view = fillAndConfirm();
      await button(view.elements, 'Submit transfer')!.props.onPress();
      await flush();
      const firstKey = lastKey;
      cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup());

      const props = { batchState: laterState };
      configureMount();
      render(props);
      effects.forEach((effect) => effect());
      await flush();
      const remounted = render(props);
      expect(remounted.text).not.toContain('STOCKED, ACTIVE or SUSPENDED');
      expect(inputs(remounted.elements).every((input) => input.props.editable === false)).toBe(
        true,
      );
      api.createBatchEvent.mockImplementationOnce(async (_b, body, key) => {
        lastKey = key;
        lastData = (body.data ?? {}) as Record<string, unknown>;
        return {
          id: 'event-out',
          event_type: 'TRANSFER',
          batch_id: BATCH,
          transfer_id: 'transfer-form-1',
          transfer_role: 'out',
          idempotency_key: key,
        };
      });
      await button(remounted.elements, 'Retry same transfer')!.props.onPress();
      await flush();
      expect(lastKey).toBe(firstKey);
      expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
      expect(render(props).text).toContain('recorded and verified on both');
    },
  );

  test('reconciles an accepted transfer read-only after the source becomes terminal', async () => {
    const { cleanups } = await mount();
    transferEventsReady = false;
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    expect(getTransferWriteRecovery(BATCH)?.retryOutcome).toBe('reconciliation_failed');
    cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup());

    transferEventsReady = true;
    const props = { batchState: 'failed' };
    configureMount();
    render(props);
    effects.forEach((effect) => effect());
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(render(props).text).toContain('recorded and verified on both');
    expect(getTransferWriteRecovery(BATCH)).toBeNull();
  });

  test('reports a fully read pair-less timeline as an integrity anomaly', async () => {
    await mount();
    api.listBatchEvents.mockImplementation(async () => ({
      items: [],
      next_cursor: null,
      limit: 25,
    }));
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    expect(render().text).toContain('INTEGRITY ANOMALY');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('retries an ambiguous timeout with the identical submission and survives remount', async () => {
    const onSaved = jest.fn();
    const { cleanups } = await mount({ onSaved });
    api.createBatchEvent.mockReset().mockImplementationOnce(async (_b, body, key) => {
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      throw new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'timeout');
    });
    const view = fillAndConfirm({ onSaved });
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    const firstKey = lastKey;
    const firstData = lastData;
    expect(getTransferWriteRecovery(BATCH)?.retryOutcome).toBe('outcome_unknown');
    expect(render().text).toContain('outcome is uncertain');
    cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup());

    configureMount();
    render({ onSaved });
    effects.map((effect) => effect());
    await flush();
    const remounted = render({ onSaved });
    expect(remounted.text).toContain('Pond 2'.slice(0, 0) + 'Batch ' + DEST);
    expect(inputs(remounted.elements).every((input) => input.props.editable === false)).toBe(true);
    api.createBatchEvent.mockImplementationOnce(async (_b, body, key) => {
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      return {
        id: 'event-out',
        event_type: 'TRANSFER',
        batch_id: BATCH,
        transfer_id: 'transfer-form-1',
        transfer_role: 'out',
        idempotency_key: key,
      };
    });
    await button(remounted.elements, 'Retry same transfer')!.props.onPress();
    await flush();
    expect(lastKey).toBe(firstKey);
    expect(lastData).toEqual(firstData);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test.each([
    [403, undefined, 'do not have permission'],
    [404, undefined, 'source batch could not be found'],
    [409, 'unit_under_maintenance', 'unit is under maintenance'],
    [409, 'transfer_exceeds_population', 'exceeds'],
    [409, 'transfer_source_changed', 'source batch or unit changed'],
    [422, 'transfer_destination_ineligible', 'destination is no longer eligible'],
  ])('handles definitive HTTP %s (%s) with guidance and no retry', async (status, code, copy) => {
    await mount();
    api.createBatchEvent
      .mockReset()
      .mockRejectedValue(new ApiError(status, 'rejected', 'http://api', '/p', code));
    const view = fillAndConfirm();
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    const after = render();
    expect(after.text).toContain(copy);
    expect(after.text).toContain('Nothing was transferred');
    expect(getTransferWriteRecovery(BATCH)).toBeNull();
    expect(button(after.elements, 'Retry same transfer')).toBeUndefined();
    expect(button(after.elements, 'Submit transfer')).toBeTruthy();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('refreshes the source and destinations after a conflict', async () => {
    const onConflictRefreshed = jest.fn();
    await mount({ onConflictRefreshed });
    api.createBatchEvent
      .mockReset()
      .mockRejectedValue(
        new ApiError(409, 'changed', 'http://api', '/p', 'transfer_destination_batch_state'),
      );
    const view = fillAndConfirm({ onConflictRefreshed });
    await button(view.elements, 'Submit transfer')!.props.onPress();
    await flush();
    expect(onConflictRefreshed).toHaveBeenCalledTimes(1);
    expect(api.listTransferDestinations).toHaveBeenCalledTimes(2);
  });
});

describe('harvest write workflow', () => {
  const BATCH = 'batch-harvest';
  const partialInput: HarvestInput = {
    quantity: '40',
    total_weight: '12.5',
    weight_unit: 'kg',
    average_weight: '',
    notes: ' first pass ',
    is_final: false,
  };
  const finalInput: HarvestInput = { ...partialInput, quantity: '100', is_final: true };
  const api = productionApi as jest.Mocked<typeof productionApi>;
  const context = { batchId: BATCH };
  let batchState = 'active';
  let remaining = 100;
  let lastKey = '';
  let lastData: Record<string, unknown> = {};
  let eventsReady = true;

  const installApi = () => {
    batchState = 'active';
    remaining = 100;
    lastKey = '';
    lastData = {};
    eventsReady = true;
    api.createBatchEvent.mockReset().mockImplementation(async (_id, body, key) => {
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      if (lastData.is_final === true) batchState = 'harvested';
      return { id: 'event-h', event_type: 'HARVEST', idempotency_key: key };
    });
    api.getProductionBatch
      .mockReset()
      .mockImplementation(async (id) => ({ id, state: batchState }));
    api.getBatchProjections.mockReset().mockImplementation(async (id) => ({
      batch_id: id,
      estimated_remaining_population: remaining,
    }));
    api.listBatchEvents.mockReset().mockImplementation(async () => ({
      items: eventsReady
        ? [{ event_type: 'HARVEST', idempotency_key: lastKey, data: lastData }]
        : [],
      next_cursor: null,
      limit: 25,
    }));
  };
  const reconcile = (
    input: HarvestInput,
    extra: Partial<Parameters<typeof reconcileHarvestWrite>[0]> = {},
  ) =>
    reconcileHarvestWrite({
      context,
      payload: input,
      idempotencyKey: extra.submission?.idempotencyKey ?? 'harvest-key-1',
      post: async (id, type, data, key, performedAt) =>
        api.createBatchEvent(
          id,
          { event_type: type, ...(performedAt ? { performed_at: performedAt } : {}), data },
          key,
        ),
      readAll: async (id) => ({
        batch: await api.getProductionBatch(id),
        projection: await api.getBatchProjections(id),
        events: (await api.listBatchEvents(id)).items,
      }),
      ...extra,
    });

  beforeEach(() => installApi());
  afterEach(() => {
    const leftover = getHarvestWriteRecovery(BATCH);
    if (leftover) clearHarvestWriteRecovery(BATCH, leftover.submission.idempotencyKey);
  });

  test('builds exact partial and final payloads with one canonical timestamp', () => {
    const at = '2026-05-01T10:00:00.000Z';
    expect(buildHarvestPayload(partialInput, at)).toEqual({
      harvest_type: 'partial',
      is_final: false,
      quantity: 40,
      total_weight: 12.5,
      weight_unit: 'kg',
      harvested_at: at,
      notes: 'first pass',
    });
    expect(buildHarvestPayload({ ...finalInput, average_weight: '0.4' }, at)).toMatchObject({
      harvest_type: 'total',
      is_final: true,
      quantity: 100,
      average_weight: 0.4,
    });
    for (const bad of [
      { quantity: '0' },
      { quantity: '1.5' },
      { total_weight: '0' },
      { weight_unit: 'lb' },
      { average_weight: '-1' },
    ]) {
      expect(() => buildHarvestPayload({ ...partialInput, ...bad }, at)).toThrow();
    }
    expect(() => buildHarvestPayload(partialInput, 'not-a-time')).toThrow();
  });

  test('submission uses the identical timestamp for performed_at and harvested_at', () => {
    const submission = createHarvestSubmission(
      BATCH,
      partialInput,
      undefined,
      undefined,
      new Date('2026-05-01T10:00:00Z'),
    );
    expect(submission.performedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(submission.payload.harvested_at).toBe(submission.performedAt);
    expect(submission.idempotencyKey.length).toBeLessThanOrEqual(64);
  });

  test('draft signature changes with any edit and with the final projection', () => {
    const base = createHarvestDraftSignature(BATCH, finalInput, 100);
    expect(createHarvestDraftSignature(BATCH, { ...finalInput, quantity: '99' }, 100)).not.toBe(
      base,
    );
    expect(createHarvestDraftSignature(BATCH, finalInput, 99)).not.toBe(base);
    expect(createHarvestDraftSignature(BATCH, { ...finalInput, is_final: false }, 100)).not.toBe(
      base,
    );
  });

  test('posts once with matching top-level and data timestamps and reconciles', async () => {
    const result = await reconcile(partialInput);
    expect(result.outcome).toBe('accepted');
    const [, body, key] = api.createBatchEvent.mock.calls[0];
    expect(body.event_type).toBe('HARVEST');
    expect(body.performed_at).toBe(body.data?.harvested_at);
    expect(key).toBe('harvest-key-1');
    expect(getHarvestWriteRecovery(BATCH)?.retryOutcome).toBe('accepted');
  });

  test('final harvest is verified against a HARVESTED batch and retained until cleared', async () => {
    const result = await reconcile(finalInput, { idempotencyKey: 'harvest-key-final' } as never);
    expect(result.outcome).toBe('accepted');
    expect(result.submission.payload).toMatchObject({ harvest_type: 'total', is_final: true });
    expect((result.reconciliation?.batch as { state: string }).state).toBe('harvested');
  });

  test('final harvest accepted while the batch is not HARVESTED is not marked reconciled', async () => {
    api.getProductionBatch.mockImplementation(async (id) => ({ id, state: 'active' }));
    const result = await reconcile(finalInput, { idempotencyKey: 'harvest-key-nf' } as never);
    expect(result.outcome).toBe('reconciliation_failed');
    expect(result.reconciled).toBe(false);
    expect(result.retrySubmission).not.toBeNull();
    expect(getHarvestWriteRecovery(BATCH)?.retryOutcome).toBe('reconciliation_failed');
  });

  test('accepted but missing timeline event retries read-only without a second POST', async () => {
    eventsReady = false;
    const first = await reconcile(partialInput, { idempotencyKey: 'harvest-key-ro' } as never);
    expect(first.outcome).toBe('reconciliation_failed');
    eventsReady = true;
    const retained = getHarvestWriteRecovery(BATCH)!.submission as never;
    const second = await reconcile(partialInput, {
      idempotencyKey: 'harvest-key-ro',
      submission: retained,
    } as never);
    expect(second.outcome).toBe('accepted');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('ambiguous network failure retains the same key, payload and timestamps for retry', async () => {
    api.createBatchEvent
      .mockReset()
      .mockRejectedValueOnce(
        new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'timeout'),
      );
    const first = await reconcile(partialInput, { idempotencyKey: 'harvest-key-net' } as never);
    expect(first.outcome).toBe('outcome_unknown');
    const retained = first.retrySubmission!;
    expect(getHarvestWriteRecovery(BATCH)?.submission).toEqual(retained);
    api.createBatchEvent.mockImplementation(async (_id, body, key) => {
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      expect(body.performed_at).toBe(retained.performedAt);
      expect(body.data?.harvested_at).toBe(retained.payload.harvested_at);
      return { id: 'event-h' };
    });
    const second = await reconcile(partialInput, {
      idempotencyKey: 'harvest-key-net',
      submission: retained,
    } as never);
    expect(second.outcome).toBe('accepted');
    expect(lastKey).toBe('harvest-key-net');
  });

  test('rejects a preserved submission that differs from the intent or its timestamps', () => {
    const submission = createHarvestSubmission(BATCH, partialInput, 'harvest-key-x');
    expect(() =>
      reconcile({ ...partialInput, quantity: '41' }, {
        idempotencyKey: 'harvest-key-x',
        submission,
      } as never),
    ).toThrow(/does not match/);
    expect(() =>
      reconcile(partialInput, {
        idempotencyKey: 'harvest-key-x',
        submission: { ...submission, performedAt: '2020-01-01T00:00:00.000Z' },
      } as never),
    ).toThrow(/does not match/);
    expect(() => reconcile(partialInput, { idempotencyKey: 'other', submission } as never)).toThrow(
      /does not match/,
    );
  });

  test.each([
    'harvest_final_backdated',
    'harvest_final_quantity_mismatch',
    'harvest_final_requires_active',
    'harvest_already_final',
    'harvest_exceeds_population',
    'idempotency_key_payload_conflict',
  ])('definitive 409 %s is rejected, not retried and clears recovery', async (code) => {
    api.createBatchEvent
      .mockReset()
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'http://api', '/p', code));
    const result = await reconcile(finalInput, {
      idempotencyKey: `harvest-${code}`.slice(0, 60),
    } as never);
    expect(result.outcome).toBe('rejected');
    expect(result.response?.status).toBe(409);
    expect(result.response?.code).toBe(code);
    expect(result.retrySubmission).toBeNull();
    expect(getHarvestWriteRecovery(BATCH)).toBeNull();
  });

  test('permission denial is a non-retryable failure and 422 is rejected', async () => {
    api.createBatchEvent
      .mockReset()
      .mockRejectedValueOnce(new ApiError(403, 'forbidden', 'http://api', '/p'));
    const denied = await reconcile(partialInput, { idempotencyKey: 'harvest-key-403' } as never);
    expect(denied.outcome).toBe('write_failed');
    expect(denied.response?.status).toBe(403);
    expect(denied.retrySubmission).toBeNull();
    api.createBatchEvent
      .mockReset()
      .mockRejectedValueOnce(
        new ApiError(422, 'invalid', 'http://api', '/p', 'harvest_total_weight_required'),
      );
    const invalid = await reconcile(partialInput, { idempotencyKey: 'harvest-key-422' } as never);
    expect(invalid.outcome).toBe('rejected');
    expect(invalid.response?.code).toBe('harvest_total_weight_required');
  });
});

describe('harvest form workflow', () => {
  const BATCH = 'batch-harvest-form';
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let stateValues: unknown[] = [];
  let refs: Array<{ current: unknown }> = [];
  let effects: Array<() => unknown> = [];
  let stateIndex = 0;
  let refIndex = 0;
  let batchState = 'active';
  let remaining = 100;
  let lastKey = '';
  let lastData: Record<string, unknown> = {};
  let postFailure: unknown = null;

  const textContent = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(textContent).join(' ');
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (React.isValidElement(node)) {
      return textContent((node as React.ReactElement<{ children?: unknown }>).props.children);
    }
    return '';
  };
  const configureMount = () => {
    stateValues = [];
    refs = [];
    effects = [];
    stateIndex = 0;
    refIndex = 0;
    (React.useState as unknown as jest.Mock).mockReset().mockImplementation((initial: unknown) => {
      const index = stateIndex++;
      if (stateValues.length <= index) {
        stateValues.push(typeof initial === 'function' ? (initial as () => unknown)() : initial);
      }
      return [
        stateValues[index],
        (next: unknown) => {
          stateValues[index] =
            typeof next === 'function'
              ? (next as (current: unknown) => unknown)(stateValues[index])
              : next;
        },
      ];
    });
    (React.useRef as unknown as jest.Mock).mockReset().mockImplementation((initial: unknown) => {
      const index = refIndex++;
      if (refs.length <= index) refs.push({ current: initial });
      return refs[index];
    });
    (React.useEffect as unknown as jest.Mock).mockReset().mockImplementation((e: () => unknown) => {
      effects.push(e);
    });
  };
  const render = (props: Partial<React.ComponentProps<typeof HarvestForm>> = {}) => {
    stateIndex = 0;
    refIndex = 0;
    const tree = HarvestForm({
      batchId: BATCH,
      batchName: 'B-H',
      farmName: 'North Farm',
      siteName: 'Site 1',
      unitName: 'Pond 1',
      batchState,
      currentEstimatedRemainingPopulation: remaining,
      ...props,
    });
    const elements: React.ReactElement[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (React.isValidElement(node)) {
        const element = node as React.ReactElement<{ children?: unknown }>;
        elements.push(element);
        visit(element.props.children);
      }
    };
    visit(tree);
    return { elements, text: textContent(tree).replace(/\s+/g, ' ') };
  };
  type Pressed = React.ReactElement<{ onPress: () => unknown; disabled?: boolean }>;
  const button = (elements: React.ReactElement[], text: string) =>
    elements.find(
      (element) =>
        element.type === Pressable &&
        textContent(
          (element as React.ReactElement<{ children?: unknown }>).props.children,
        ).includes(text),
    ) as Pressed | undefined;
  const inputs = (elements: React.ReactElement[]) =>
    elements.filter((element) => element.type === TextInput) as Array<
      React.ReactElement<{ onChangeText: (value: string) => void; editable?: boolean }>
    >;
  const api = productionApi as jest.Mocked<typeof productionApi>;
  const installApi = () => {
    mockSecureValues.clear();
    mockSecureLog.length = 0;
    Object.assign(mockSecureFaults, {
      unavailable: false,
      failSet: false,
      corruptReadBack: false,
      failDelete: false,
    });
    (getCurrentUser as jest.Mock).mockReset().mockResolvedValue({ id: 'user-1' });
    batchState = 'active';
    remaining = 100;
    lastKey = '';
    lastData = {};
    postFailure = null;
    api.createBatchEvent.mockReset().mockImplementation(async (_id, body, key) => {
      if (postFailure) {
        const failure = postFailure;
        postFailure = null;
        throw failure;
      }
      lastKey = key;
      lastData = (body.data ?? {}) as Record<string, unknown>;
      if (lastData.is_final === true) batchState = 'harvested';
      return { id: 'event-h', event_type: 'HARVEST', idempotency_key: key };
    });
    api.getProductionBatch
      .mockReset()
      .mockImplementation(async (id) => ({ id, state: batchState }));
    api.getBatchProjections.mockReset().mockImplementation(async (id) => ({
      batch_id: id,
      estimated_remaining_population: remaining,
    }));
    api.listBatchEvents.mockReset().mockImplementation(async () => ({
      items: lastKey ? [{ event_type: 'HARVEST', idempotency_key: lastKey, data: lastData }] : [],
      next_cursor: null,
      limit: 25,
    }));
  };
  const runEffects = async () => {
    if (effects.length === 0) render();
    const cleanups = effects.map((effect) => effect());
    await flush();
    return cleanups;
  };
  const enterFinal = async (props: Partial<React.ComponentProps<typeof HarvestForm>> = {}) => {
    render(props);
    await runEffects();
    effects = [];
    button(render(props).elements, 'Final harvest')!.props.onPress();
    effects = [];
    render(props);
    await runEffects();
    effects = [];
    return render(props);
  };
  const fill = (
    quantity: string,
    props: Partial<React.ComponentProps<typeof HarvestForm>> = {},
  ) => {
    const fields = inputs(render(props).elements);
    fields[0].props.onChangeText(quantity);
    fields[1].props.onChangeText('25.5');
    return render(props);
  };
  const confirmAll = (
    steps: string[],
    props: Partial<React.ComponentProps<typeof HarvestForm>> = {},
  ) => {
    let view = render(props);
    for (const step of steps) {
      button(view.elements, step)!.props.onPress();
      view = render(props);
    }
    return view;
  };
  const FINAL_STEPS = [
    'I confirm the observed physical count',
    'I confirm this is an irreversible final harvest',
    'Second confirmation',
  ];

  beforeEach(() => {
    installApi();
    configureMount();
  });
  afterEach(() => {
    const leftover = getHarvestWriteRecovery(BATCH);
    if (leftover) clearHarvestWriteRecovery(BATCH, leftover.submission.idempotencyKey);
    jest.restoreAllMocks();
  });

  test('shows the restart limitation and projection context for a partial harvest', () => {
    const view = render();
    expect(view.text).toContain("saved to this device's secure storage");
    expect(view.text).toContain('does not prove that a duplicate cannot occur');
    expect(view.text).toContain('Projected remaining population (context only): 100');
  });

  test('submits a confirmed partial harvest and reports verified success', async () => {
    const onSaved = jest.fn();
    await runEffects();
    fill('40', { onSaved });
    let view = render({ onSaved });
    await button(view.elements, 'Submit harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(render({ onSaved }).text).toContain('Explicitly confirm the recorded quantity');
    view = confirmAll(['I confirm 40 individuals'], { onSaved });
    await button(view.elements, 'Submit harvest')!.props.onPress();
    await flush();
    const [id, body] = api.createBatchEvent.mock.calls[0];
    expect(id).toBe(BATCH);
    expect(body.performed_at).toBe(body.data?.harvested_at);
    expect(body.data).toMatchObject({
      harvest_type: 'partial',
      is_final: false,
      quantity: 40,
      total_weight: 25.5,
      weight_unit: 'kg',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    expect(render({ onSaved }).text).toContain('Partial harvest recorded and verified');
  });

  test('draft edits invalidate confirmations', async () => {
    await runEffects();
    fill('40');
    confirmAll(['I confirm 40 individuals']);
    inputs(render().elements)[0].props.onChangeText('41');
    const view = render();
    await button(view.elements, 'Submit harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(view.text).not.toContain('Farm: North Farm Type');
  });

  test('final harvest loads a fresh projection and blocks a differing physical count', async () => {
    remaining = 90;
    await enterFinal();
    fill('100');
    const view = render();
    expect(view.text).toContain('Projected remaining population (server, fresh): 90');
    expect(view.text).toContain('Final harvest is blocked');
    button(view.elements, FINAL_STEPS[0])!.props.onPress();
    expect(render().text).toContain('differs from the server-projected remaining population (90)');
    await button(render().elements, 'Submit final harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
  });

  test('final harvest requires all three confirmations in order and posts fresh quantity', async () => {
    const onSaved = jest.fn();
    await enterFinal({ onSaved });
    fill('100', { onSaved });
    let view = render({ onSaved });
    expect(view.text).toContain('No correction or reversal endpoint currently exists');
    button(view.elements, FINAL_STEPS[1])!.props.onPress();
    button(render({ onSaved }).elements, FINAL_STEPS[2])!.props.onPress();
    await button(render({ onSaved }).elements, 'Submit final harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    view = confirmAll(FINAL_STEPS.slice(0, 2), { onSaved });
    await button(view.elements, 'Submit final harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    view = confirmAll(FINAL_STEPS.slice(2), { onSaved });
    await button(view.elements, 'Submit final harvest')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    const [, body] = api.createBatchEvent.mock.calls[0];
    expect(body.performed_at).toBe(body.data?.harvested_at);
    expect(body.data).toMatchObject({ harvest_type: 'total', is_final: true, quantity: 100 });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((onSaved.mock.calls[0][1].batch as { state: string }).state).toBe('harvested');
    expect(render({ onSaved }).text).toContain('The batch is HARVESTED');
  });

  test('a projection change after confirmation invalidates both confirmations and does not post', async () => {
    await enterFinal();
    fill('100');
    const view = confirmAll(FINAL_STEPS);
    remaining = 95;
    await button(view.elements, 'Submit final harvest')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    const after = render();
    expect(after.text).toContain('differs from the server-projected remaining population (95)');
    expect(button(after.elements, FINAL_STEPS[1])).toBeTruthy();
  });

  test('final harvest is disabled for a non-ACTIVE batch', async () => {
    batchState = 'suspended';
    const view = await enterFinal();
    expect(view.text).toContain('A final harvest requires an authoritative ACTIVE batch');
    expect(button(view.elements, 'Submit final harvest')!.props.disabled).toBe(true);
    await button(view.elements, 'Submit final harvest')!.props.onPress();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['harvest_final_backdated', 'earlier than existing population-affecting events'],
    ['harvest_final_quantity_mismatch', 'does not equal the server-projected remaining'],
    ['harvest_final_requires_active', 'requires an ACTIVE batch'],
    ['harvest_already_final', 'already been recorded'],
    ['harvest_exceeds_population', 'exceeds the server-projected remaining population'],
    ['idempotency_key_payload_conflict', 'conflicts with a different recorded harvest'],
  ])('409 %s clears confirmations, refreshes and shows the conflict', async (code, text) => {
    const onConflictRefreshed = jest.fn();
    await runEffects();
    fill('40', { onConflictRefreshed });
    const view = confirmAll(['I confirm 40 individuals'], { onConflictRefreshed });
    postFailure = new ApiError(409, 'conflict', 'http://api', '/p', code);
    await button(view.elements, 'Submit harvest')!.props.onPress();
    await flush();
    expect(render({ onConflictRefreshed }).text).toContain(text);
    expect(onConflictRefreshed).toHaveBeenCalledTimes(1);
    expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    await button(render({ onConflictRefreshed }).elements, 'Submit harvest')!.props.onPress();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
  });

  test('permission denial is explained and not retried', async () => {
    await runEffects();
    fill('40');
    const view = confirmAll(['I confirm 40 individuals']);
    postFailure = new ApiError(403, 'forbidden', 'http://api', '/p');
    await button(view.elements, 'Submit harvest')!.props.onPress();
    await flush();
    expect(render().text).toContain('do not have permission to harvest this batch');
    expect(getHarvestWriteRecovery(BATCH)).toBeNull();
  });

  test('ambiguous outcome retries with the same key and timestamps and survives remount', async () => {
    const first = await runEffects();
    fill('40');
    const view = confirmAll(['I confirm 40 individuals']);
    postFailure = new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'timeout');
    await button(view.elements, 'Submit harvest')!.props.onPress();
    await flush();
    const retained = getHarvestWriteRecovery(BATCH)!.submission;
    expect(render().text).toContain('outcome is uncertain');
    first.forEach((cleanup) => typeof cleanup === 'function' && cleanup());

    configureMount();
    render();
    await runEffects();
    const remounted = render();
    expect(inputs(remounted.elements).every((input) => input.props.editable === false)).toBe(true);
    expect(button(remounted.elements, 'Submit harvest')).toBeUndefined();
    await button(remounted.elements, 'Retry same harvest')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
    expect(lastKey).toBe(retained.idempotencyKey);
    expect(lastData.harvested_at).toBe(retained.payload.harvested_at);
    const [, body] = api.createBatchEvent.mock.calls[1];
    expect(body.performed_at).toBe(retained.performedAt);
  });

  test('accepted but unreconciled harvest locks the form and never posts again', async () => {
    await runEffects();
    fill('40');
    const view = confirmAll(['I confirm 40 individuals']);
    api.listBatchEvents.mockImplementation(async () => ({
      items: [],
      next_cursor: null,
      limit: 25,
    }));
    await button(view.elements, 'Submit harvest')!.props.onPress();
    await flush();
    const after = render();
    expect(after.text).toContain('Harvest recorded — refresh to confirm');
    expect(getHarvestWriteRecovery(BATCH)?.retryOutcome).toBe('reconciliation_failed');
    expect(button(after.elements, 'Submit harvest')).toBeUndefined();
    expect(button(after.elements, 'Reconcile previous harvest')).toBeTruthy();
    api.listBatchEvents.mockImplementation(async () => ({
      items: [{ event_type: 'HARVEST', idempotency_key: lastKey, data: lastData }],
      next_cursor: null,
      limit: 25,
    }));
    await button(after.elements, 'Reconcile previous harvest')!.props.onPress();
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(render().text).toContain('Partial harvest recorded and verified');
  });
  describe('durable recovery', () => {
    const storeKey = `agrovix.harvest_recovery.${BATCH}`;
    const stored = () => JSON.parse(mockSecureValues.get(storeKey) ?? 'null');
    const postUnknown = () => {
      postFailure = new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'lost');
    };
    const submitPartial = async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      await button(view.elements, 'Submit harvest')!.props.onPress();
      await flush();
    };
    const restart = async () => {
      const leftover = getHarvestWriteRecovery(BATCH);
      if (leftover) clearHarvestWriteRecovery(BATCH, leftover.submission.idempotencyKey);
      configureMount();
      render();
      await runEffects();
      return render();
    };

    test('persists and verifies the record before the POST', async () => {
      api.createBatchEvent.mockImplementationOnce(async (_id, body, key) => {
        expect(stored()?.idempotencyKey).toBe(key);
        expect(stored()?.status).toBe('PREPARED');
        expect(stored()?.userId).toBe('user-1');
        expect(stored()?.performedAt).toBe(body.performed_at);
        throw new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'lost');
      });
      await submitPartial();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expect(mockSecureLog[0]).toBe(`set:${storeKey}`);
    });

    test('a storage write failure blocks the POST and shows a recovery-storage error', async () => {
      mockSecureFaults.failSet = true;
      await submitPartial();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(render().text).toContain('Recovery storage error');
      expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    });

    test('a read-back mismatch blocks the POST', async () => {
      mockSecureFaults.corruptReadBack = true;
      await submitPartial();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(render().text).toContain('Recovery storage error');
    });

    test('termination before the POST restores the record and never auto-submits', async () => {
      await runEffects();
      fill('40');
      const prepared = confirmAll(['I confirm 40 individuals']);
      api.createBatchEvent.mockImplementationOnce(async () => {
        throw new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'lost');
      });
      await button(prepared.elements, 'Submit harvest')!.props.onPress();
      await flush();
      const record = stored();
      const view = await restart();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expect(button(view.elements, 'Retry same harvest')).toBeTruthy();
      expect(getHarvestWriteRecovery(BATCH)?.submission.idempotencyKey).toBe(record.idempotencyKey);
    });

    test('termination during the POST: restart, explicit same-key retry, record deleted after reconciliation', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      const view = await restart();
      expect(inputs(view.elements).every((input) => input.props.editable === false)).toBe(true);
      expect(render().text).toContain('Its original identity is restored');
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
      expect(lastKey).toBe(record.idempotencyKey);
      const [, body] = api.createBatchEvent.mock.calls[1];
      expect(body.performed_at).toBe(record.performedAt);
      expect(body.data).toEqual(record.payload);
      expect(mockSecureValues.has(storeKey)).toBe(false);
      expect(render().text).toContain('Partial harvest recorded and verified');
    });

    test('accepted response lost then repeated restarts keep the same key', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      await restart();
      await restart();
      const view = await restart();
      expect(stored()).toEqual(record);
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expect(button(view.elements, 'Submit harvest')).toBeUndefined();
    });

    test('accepted but unreconciled keeps the record and does not allow a new key', async () => {
      api.listBatchEvents.mockImplementation(async () => ({
        items: [],
        next_cursor: null,
        limit: 25,
      }));
      await submitPartial();
      expect(stored()?.status).toBe('PREPARED');
      const view = await restart();
      expect(button(view.elements, 'Submit harvest')).toBeUndefined();
      expect(mockSecureValues.has(storeKey)).toBe(true);
    });

    test('a definitive 409 rejection deletes the record', async () => {
      postFailure = new ApiFailure('http', 'http://api', '/p', 409, 'ApiError', 'conflict');
      await submitPartial();
      expect(mockSecureValues.has(storeKey)).toBe(false);
      expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    });

    test('a failed delete after acceptance keeps the safety lock', async () => {
      mockSecureFaults.failDelete = true;
      await submitPartial();
      expect(mockSecureValues.has(storeKey)).toBe(true);
      expect(button(render().elements, 'Submit harvest')).toBeUndefined();
    });

    test('a corrupt record blocks new submissions without deleting it', async () => {
      mockSecureValues.set(storeKey, '{not json');
      await runEffects();
      const view = render();
      expect(view.text).toContain('is unreadable');
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(mockSecureValues.get(storeKey)).toBe('{not json');
    });

    test('unavailable storage fails closed', async () => {
      mockSecureFaults.unavailable = true;
      await runEffects();
      const view = render();
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(api.createBatchEvent).not.toHaveBeenCalled();
    });

    test('a record of another user blocks and exposes no payload', async () => {
      postUnknown();
      await submitPartial();
      (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-2' });
      const leftover = getHarvestWriteRecovery(BATCH);
      if (leftover) clearHarvestWriteRecovery(BATCH, leftover.submission.idempotencyKey);
      configureMount();
      render();
      await runEffects();
      const view = render();
      expect(view.text).toContain('supervisor');
      expect(view.text).not.toContain('40');
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(mockSecureValues.has(storeKey)).toBe(true);
      expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    });

    const retryFailures: Array<[string, () => unknown]> = [
      ['401', () => new ApiError(401, 'expired', 'http://api', '/p')],
      ['403', () => new ApiError(403, 'forbidden', 'http://api', '/p')],
      ['404', () => new ApiError(404, 'missing', 'http://api', '/p')],
      ['400', () => new ApiError(400, 'bad', 'http://api', '/p')],
      ['408', () => new ApiError(408, 'timeout', 'http://api', '/p')],
      ['429', () => new ApiError(429, 'slow down', 'http://api', '/p')],
      ['503', () => new ApiFailure('http', 'http://api', '/p', 503, 'ApiError', 'down')],
    ];

    test.each(retryFailures)(
      'ambiguous partial harvest then %s on retry keeps the original key and blocks a new submission',
      async (_label, makeFailure) => {
        postUnknown();
        await submitPartial();
        const record = stored();
        let view = await restart();
        postFailure = makeFailure();
        await button(view.elements, 'Retry same harvest')!.props.onPress();
        await flush();
        expect(mockSecureValues.get(storeKey)).toBe(JSON.stringify(record));
        expect(getHarvestWriteRecovery(BATCH)?.submission.idempotencyKey).toBe(
          record.idempotencyKey,
        );
        view = render();
        expect(button(view.elements, 'Submit harvest')).toBeUndefined();
        expect(button(view.elements, 'Retry same harvest')).toBeTruthy();
        const posts = api.createBatchEvent.mock.calls.length;
        expect(posts).toBe(2);
        await button(view.elements, 'Retry same harvest')!.props.onPress();
        await flush();
        expect(api.createBatchEvent.mock.calls.length).toBe(3);
        expect(
          api.createBatchEvent.mock.calls.every((call) => call[2] === record.idempotencyKey),
        ).toBe(true);
      },
    );

    test('same-key replay after reauthentication succeeds and clears the record', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      const view = await restart();
      postFailure = new ApiError(401, 'expired', 'http://api', '/p');
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(mockSecureValues.has(storeKey)).toBe(true);
      await button(render().elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(lastKey).toBe(record.idempotencyKey);
      expect(mockSecureValues.has(storeKey)).toBe(false);
      expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    });

    test.each([
      [409, 'harvest_exceeds_population'],
      [422, 'harvest_invalid_state'],
    ])('a definitive %s domain rejection on retry deletes the record', async (status, code) => {
      postUnknown();
      await submitPartial();
      const view = await restart();
      postFailure = new ApiError(status, 'rejected', 'http://api', '/p', code);
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(mockSecureValues.has(storeKey)).toBe(false);
      expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    });

    test('a 422 without a domain code on retry is not definitive', async () => {
      postUnknown();
      await submitPartial();
      const view = await restart();
      postFailure = new ApiError(422, 'schema', 'http://api', '/p');
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(mockSecureValues.has(storeKey)).toBe(true);
      expect(getHarvestWriteRecovery(BATCH)).not.toBeNull();
    });

    test('foreign in-memory recovery without a durable record is blocked and not rendered', async () => {
      postUnknown();
      await submitPartial();
      mockSecureValues.delete(storeKey);
      configureMount();
      render();
      await runEffects();
      const view = render();
      expect(view.text).not.toContain('I confirm 40');
      expect(button(view.elements, 'Retry same harvest')).toBeUndefined();
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    });

    test('foreign in-memory recovery with another users durable record is blocked and not rendered', async () => {
      postUnknown();
      await submitPartial();
      (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-2' });
      configureMount();
      render();
      await runEffects();
      const view = render();
      expect(view.text).not.toContain('I confirm 40');
      expect(button(view.elements, 'Retry same harvest')).toBeUndefined();
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(mockSecureValues.has(storeKey)).toBe(true);
    });

    test('no recovered payload renders before hydration completes', async () => {
      postUnknown();
      await submitPartial();
      configureMount();
      const before = render();
      expect(before.text).not.toContain('I confirm 40');
      expect(button(before.elements, 'Retry same harvest')).toBeUndefined();
      expect(button(before.elements, 'Submit harvest')?.props.disabled).not.toBe(false);
    });

    test('a /me failure during hydration keeps the form locked', async () => {
      (getCurrentUser as jest.Mock).mockRejectedValue(new Error('offline'));
      await runEffects();
      const view = render();
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBe(true);
      expect(api.createBatchEvent).not.toHaveBeenCalled();
    });

    test('the durable record is written once and never rewritten during an unresolved POST', async () => {
      postUnknown();
      await submitPartial();
      const sets = mockSecureLog.filter((entry) => entry.startsWith('set:'));
      expect(sets).toHaveLength(1);
      expect(stored().status).toBe('PREPARED');
    });

    test('persistence succeeding but in-memory registration failing blocks the POST and keeps the record', async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      const other = createHarvestSubmission(
        BATCH,
        {
          quantity: '7',
          total_weight: '3',
          weight_unit: 'kg',
          average_weight: '',
          notes: '',
          is_final: false,
        },
        'other-key',
      );
      restoreHarvestWriteRecovery(other);
      await button(view.elements, 'Submit harvest')!.props.onPress();
      await flush();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(mockSecureValues.has(storeKey)).toBe(true);
      expect(button(render().elements, 'Submit harvest')?.props.disabled).not.toBe(false);
    });

    test('unmounting during an in-flight POST keeps the record for restart', async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      let release: () => void = () => undefined;
      api.createBatchEvent.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            release = () =>
              reject(new ApiFailure('network', 'http://api', '/p', undefined, 'TypeError', 'lost'));
          }),
      );
      const pending = button(view.elements, 'Submit harvest')!.props.onPress();
      await flush();
      const record = stored();
      release();
      await pending;
      await flush();
      const restarted = await restart();
      expect(stored()).toEqual(record);
      expect(button(restarted.elements, 'Submit harvest')).toBeUndefined();
      expect(button(restarted.elements, 'Retry same harvest')).toBeTruthy();
    });

    test('double submit sends a single POST', async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      const submit = button(view.elements, 'Submit harvest')!;
      await Promise.all([submit.props.onPress(), submit.props.onPress()]);
      await flush();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    });

    test('a payload-conflict 409 on retry retains the record and escalates', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      const view = await restart();
      postFailure = new ApiError(
        409,
        'conflict',
        'http://api',
        '/p',
        'idempotency_key_payload_conflict',
      );
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(stored()).toEqual(record);
      expect(getHarvestWriteRecovery(BATCH)?.submission.idempotencyKey).toBe(record.idempotencyKey);
      const after = render();
      expect(after.text).toContain('Escalate to a supervisor');
      expect(button(after.elements, 'Submit harvest')).toBeUndefined();
    });

    test('a different batch mounted in place is locked until its own recovery check completes', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      configureMount();
      const before = render({ batchId: 'batch-other', batchName: 'B-O' });
      expect(button(before.elements, 'Submit harvest')?.props.disabled).not.toBe(false);
      expect(before.text).not.toContain('I confirm 40');
      await runEffects();
      const after = render({ batchId: 'batch-other', batchName: 'B-O' });
      expect(after.text).not.toContain('I confirm 40');
      expect(button(after.elements, 'Retry same harvest')).toBeUndefined();
      expect(stored()).toEqual(record);
    });

    test('an account switch while mounted blocks the submission and persists nothing', async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-2' });
      await button(view.elements, 'Submit harvest')!.props.onPress();
      await flush();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(mockSecureLog.some((entry) => entry.startsWith('set:'))).toBe(false);
      expect(mockSecureValues.has(storeKey)).toBe(false);
      const after = render();
      expect(after.text).toContain('account changed');
      expect(button(after.elements, 'Submit harvest')!.props.disabled).toBe(true);
    });

    test('an unavailable identity at persist time fails closed', async () => {
      await runEffects();
      fill('40');
      const view = confirmAll(['I confirm 40 individuals']);
      (getCurrentUser as jest.Mock).mockRejectedValue(new Error('offline'));
      await button(view.elements, 'Submit harvest')!.props.onPress();
      await flush();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(mockSecureValues.has(storeKey)).toBe(false);
    });

    test('an accepted but unreconciled write followed by an authentication failure keeps the record', async () => {
      api.listBatchEvents.mockImplementation(async () => ({
        items: [],
        next_cursor: null,
        limit: 25,
      }));
      await submitPartial();
      const record = stored();
      expect(getHarvestWriteRecovery(BATCH)).not.toBeNull();
      api.getProductionBatch.mockRejectedValue(new ApiError(401, 'expired', 'http://api', '/b'));
      api.listBatchEvents.mockRejectedValue(new ApiError(401, 'expired', 'http://api', '/e'));
      const view = await restart();
      const retry = button(view.elements, 'Retry same harvest');
      expect(retry).toBeTruthy();
      await retry!.props.onPress();
      await flush();
      expect(stored()).toEqual(record);
      expect(getHarvestWriteRecovery(BATCH)?.submission.idempotencyKey).toBe(record.idempotencyKey);
      expect(button(render().elements, 'Submit harvest')).toBeUndefined();
      expect(
        api.createBatchEvent.mock.calls.every((call) => call[2] === record.idempotencyKey),
      ).toBe(true);
    });

    test('a failed delete followed by a HARVESTED state keeps the form reachable and locked', async () => {
      mockSecureFaults.failDelete = true;
      await submitPartial();
      expect(mockSecureValues.has(storeKey)).toBe(true);
      batchState = 'harvested';
      const view = render({ batchState: 'harvested' });
      expect(view.elements.length).toBeGreaterThan(0);
      expect(button(view.elements, 'Submit harvest')).toBeUndefined();
    });

    test('a restored record stays reachable for reconciliation after a terminal-state transition', async () => {
      postUnknown();
      await submitPartial();
      const record = stored();
      batchState = 'harvested';
      configureMount();
      render({ batchState: 'harvested' });
      await runEffects();
      const view = render({ batchState: 'harvested' });
      expect(view.elements.length).toBeGreaterThan(0);
      await button(view.elements, 'Retry same harvest')!.props.onPress();
      await flush();
      expect(lastKey).toBe(record.idempotencyKey);
      expect(mockSecureValues.has(storeKey)).toBe(false);
    });

    test('a HARVESTED batch with no recovery record renders nothing', async () => {
      configureMount();
      render({ batchState: 'harvested' });
      await runEffects();
      expect(render({ batchState: 'harvested' }).elements).toHaveLength(0);
    });

    test('a record for another batch does not affect this batch', async () => {
      mockSecureValues.set('agrovix.harvest_recovery.other-batch', '{not json');
      await runEffects();
      const view = render();
      expect(button(view.elements, 'Submit harvest')!.props.disabled).toBeFalsy();
    });
  });
});
