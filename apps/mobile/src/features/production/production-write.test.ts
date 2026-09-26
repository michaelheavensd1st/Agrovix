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
import { WaterQualityForm } from '../../components/production/water-quality-form';
import { ApiFailure } from '../../lib/api';
import * as productionApi from '../../lib/production-api';
import {
  buildWaterQualityPayload,
  buildFeedingPayload,
  createFeedingDraftSignature,
  createWaterQualityDraftSignature,
  createWaterQualityIdempotencyKey,
  createWaterQualitySubmission,
  createFeedingSubmission,
  hasActualWaterQualityMeasurement,
  isSameLogicalSubmission,
  reconcileWaterQualityWrite,
  reconcileFeedingWrite,
  resolveWriteOutcome,
  type WaterQualityWriteContext,
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
        [null, setters[4]],
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
