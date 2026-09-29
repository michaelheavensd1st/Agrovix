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
import { Pressable, TextInput } from 'react-native';
import { FeedingForm } from '../../components/production/feeding-form';
import { MortalityForm } from '../../components/production/mortality-form';
import { SamplingForm } from '../../components/production/sampling-form';
import { WaterQualityForm } from '../../components/production/water-quality-form';
import { ApiFailure } from '../../lib/api';
import * as productionApi from '../../lib/production-api';
import {
  buildWaterQualityPayload,
  buildFeedingPayload,
  buildMortalityPayload,
  buildSamplingPayload,
  createFeedingDraftSignature,
  createMortalityDraftSignature,
  createSamplingDraftSignature,
  createWaterQualityDraftSignature,
  createWaterQualityIdempotencyKey,
  createWaterQualitySubmission,
  createMortalitySubmission,
  createSamplingSubmission,
  normalizeMortalityObservedAt,
  createFeedingSubmission,
  hasActualWaterQualityMeasurement,
  isSameLogicalSubmission,
  reconcileMortalityWrite,
  reconcileSamplingWrite,
  reconcileWaterQualityWrite,
  reconcileFeedingWrite,
  resolveWriteOutcome,
  type WaterQualityWriteContext,
  type MortalityInput,
  type MortalitySubmission,
  type SamplingInput,
  type SamplingSubmission,
  type WaterQualitySubmission,
  type FeedingInput,
  type FeedingSubmission,
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
    stateSpy.mockReset().mockImplementation((initial: unknown) => [initial, jest.fn()]);
    refSpy.mockReset().mockImplementation((initial: unknown) => ({ current: initial }));

    try {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const expectedLocalTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      expect(MortalityForm({ batchId: 'batch-mortality' })).toBeTruthy();
      expect(stateSpy.mock.calls[0][0]).toMatchObject({ observed_at: expectedLocalTime });
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

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
      [values, confirmed, confirmedSnapshot, busy, error, statusMessage].forEach((value, index) =>
        stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retrySubmission)
        .mockReturnValueOnce(draftRevision);
      const tree = MortalityForm({
        batchId: 'batch-mortality',
        batchName: 'B-MORT',
        farmName: 'North Farm',
        siteName: 'Site 3',
        unitName: 'Pond 3',
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
      expect(preview).toContain('Mortality count: 3');
      expect(preview).toContain('Observed at: 2026-09-26T08:30');
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

      buttonWithText(renderForm(), 'Submit mortality').props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map((call) => call[2])).toEqual([firstKey, firstKey]);
      expect(retrySubmission.current?.idempotencyKey).toBe(firstKey);
      expect(error).toContain('outcome is uncertain');

      const editableElements = renderForm();
      (
        editableElements.filter((element) => element.type === TextInput)[0].props as {
          onChangeText: (value: string) => void;
        }
      ).onChangeText('4');
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(retrySubmission.current).toBeNull();
      await buttonWithText(renderForm(), 'Submit mortality').props.onPress();
      expect(post).toHaveBeenCalledTimes(2);
      expect(error).toContain('confirm');

      buttonWithText(renderForm(), 'I confirm this mortality record').props.onPress();
      await buttonWithText(renderForm(), 'Submit mortality').props.onPress();
      expect(post).toHaveBeenCalledTimes(3);
      const secondKey = post.mock.calls[2][2];
      expect(secondKey).not.toBe(firstKey);
      expect(post.mock.calls[2][1]).toMatchObject({
        event_type: 'MORTALITY',
        data: {
          count: 4,
          observed_at: normalizeMortalityObservedAt('2026-09-26T08:30'),
          suspected_cause: 'Low dissolved oxygen',
          disposal_method: 'compost',
        },
      });
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
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy
        .mockReset()
        .mockReturnValueOnce(inFlight)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision);
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

    try {
      const initial = renderForm();
      const buttons = initial.filter((element) => element.type === Pressable);
      (buttons[buttons.length - 1].props as { onPress: () => void }).onPress();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).toHaveBeenCalledTimes(1);
      expect(confirmed).toBe(false);
      expect(confirmedSnapshot).toBeNull();
      expect(retryRef.current).toBeNull();

      const afterRejection = renderForm();
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

describe('sampling write workflow', () => {
  const samplingContext: WaterQualityWriteContext = {
    batchId: 'batch-sampling',
    batchName: 'B-SAMPLE',
    farmName: 'North Farm',
    unitName: 'Pond 4',
  };
  const samplingInput: SamplingInput = {
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
    expect(
      createSamplingDraftSignature('batch-sampling', { ...samplingInput, sample_size: 40 }),
    ).not.toBe(signature);
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
    );
    expect(result.outcome).toBe('accepted');
    expect(result.reconciliation).toEqual(samplingReconciliation);
    expect(result.reconciliation?.projection.estimated_remaining_population).toBe(22800);
    expect(result.submission.payload.sample_size).toBe(30);
    expect(result.submission.payload).not.toHaveProperty('performed_by_id');

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
  });

  test('sampling form requires explicit confirmation, shows high-impact population warning, and blocks stale duplicate submit', async () => {
    let values: Record<string, string> = {
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
      [values, confirmed, confirmedSnapshot, busy, error, statusMessage].forEach((value, index) =>
        stateSpy.mockImplementationOnce(() => [value, setters[index]]),
      );
      refSpy
        .mockReset()
        .mockReturnValueOnce(submissionInFlight)
        .mockReturnValueOnce(retrySubmission)
        .mockReturnValueOnce(draftRevision);
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
        data: {
          sample_size: 30,
          average_weight: 4.8,
          minimum_weight: 3.9,
          maximum_weight: 5.7,
          weight_unit: 'g',
          estimated_population: 22800,
        },
      });
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

  test('sampling form does not claim population replacement when estimated_population is omitted', () => {
    let values: Record<string, string> = {
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
    ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
    refSpy
      .mockReset()
      .mockReturnValueOnce({ current: false })
      .mockReturnValueOnce({ current: null })
      .mockReturnValueOnce({ current: 0 });

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
        ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
        refSpy
          .mockReset()
          .mockReturnValueOnce(inFlight)
          .mockReturnValueOnce(retrySubmission)
          .mockReturnValueOnce(draftRevision);
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
      ].forEach((state) => stateSpy.mockImplementationOnce(() => state));
      refSpy
        .mockReset()
        .mockReturnValueOnce(inFlight)
        .mockReturnValueOnce(retryRef)
        .mockReturnValueOnce(revision);
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
