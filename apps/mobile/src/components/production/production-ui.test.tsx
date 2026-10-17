import React from 'react';

jest.mock('react', () => {
  const React = jest.requireActual('react');
  return {
    ...React,
    useEffect: jest.fn(),
    useMemo: jest.fn(),
    useRef: jest.fn(),
    useState: jest.fn(),
  };
});
jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));
jest.mock('react-native', () => {
  const React = jest.requireActual('react');

  return {
    Platform: { OS: 'android' },
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    TextInput: (props: any) => React.createElement('TextInput', props),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
  };
});
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../../lib/secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
}));
let mockHarvestSessionUserId: string | null = 'user-1';
jest.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    session: mockHarvestSessionUserId
      ? { status: 'authenticated', user: { id: mockHarvestSessionUserId } }
      : { status: 'unauthenticated' },
  }),
}));
jest.mock('../../lib/api', () => ({
  ...jest.requireActual('../../lib/api'),
  getCurrentUser: jest.fn(),
}));
jest.mock('../../lib/production-api', () => ({
  ...jest.requireActual('../../lib/production-api'),
  createBatchEvent: jest.fn(),
  getProductionBatch: jest.fn(),
  getBatchProjections: jest.fn(),
  listBatchEvents: jest.fn(),
  listAllBatchEvents: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    batchId: 'batch-refresh',
    batchName: 'B-009',
    farmName: 'North Farm',
    siteName: 'Site 09',
    unitName: 'Pond 09',
  }),
}));

import { Pressable, TextInput } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as productionApi from '../../lib/production-api';
import { ApiError, ApiFailure, getCurrentUser } from '../../lib/api';
import { beginAuthOperation } from '../../lib/auth-operations';
import {
  harvestRecoveryStorageKey,
  createHarvestRecoveryRecord,
  persistHarvestRecoveryRecord,
  type HarvestRecoveryRecord,
} from '../../features/production/harvest-recovery-store';
import Constants from 'expo-constants';
import {
  armHarvestRecoveryFault,
  beginHarvestRecoveryFaultAttempt,
  captureHarvestRecoveryFaultAttempt,
  type HarvestRecoveryFaultAttempt,
  disarmHarvestRecoveryFault,
  consumeHarvestRecoveryStorageFailure,
  getHarvestRecoveryFaultSnapshot,
  releaseHarvestRecoveryCheckpoint,
  runHarvestRecoveryFaultCheckpoint,
} from '../../features/production/harvest-recovery-fault-injection';
import ProductionBatchDetailScreen from '../../../app/production/batches/[batchId]';
import { FeedingForm } from './feeding-form';
import { HarvestRecoveryQaControls, HarvestForm } from './harvest-form';
import { MortalityForm } from './mortality-form';
import { SamplingForm } from './sampling-form';
import { StockingForm } from './stocking-form';
import { TransferForm } from './transfer-form';
import {
  clearTransferWriteRecovery,
  getTransferWriteRecovery,
  reconcileTransferWrite,
  reconcileHarvestWrite,
  createHarvestSubmission,
  getHarvestWriteRecovery,
  clearHarvestWriteRecovery,
} from '../../features/production/production-write';
import { WaterQualityForm } from './water-quality-form';
import { BatchDetailPanel } from './batch-detail';
import { ResourceListScreen } from './resource-list';

function flattenNodes(node: any): any[] {
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenNodes);
  if (React.isValidElement(node)) {
    const element = node as any;
    const childNodes = flattenNodes(element.props?.children);
    return [node, ...childNodes];
  }
  return [];
}

function textValues(node: any): string[] {
  const values: string[] = [];
  const walk = (current: any) => {
    if (current == null) return;
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number') {
      values.push(String(current));
      return;
    }
    if (React.isValidElement(current)) {
      const element = current as any;
      walk(element.props?.children);
      return;
    }
  };
  walk(node);
  return values;
}

describe('M2 shared production UI boundary', () => {
  test('shows a loading state without exposing list actions', () => {
    const tree = ResourceListScreen({
      title: 'Farms',
      subtitle: 'Organization: North Farm Holdings',
      items: [],
      loading: true,
      emptyText: 'No farms are available for this organization.',
      error: null,
      onSelect: jest.fn(),
    });

    const pressables = flattenNodes(tree).filter(
      (node) => React.isValidElement(node) && node.type === Pressable,
    );

    expect(textValues(tree)).toContain('Farms');
    expect(textValues(tree)).toContain('Loading…');
    expect(pressables).toHaveLength(0);
  });

  test('renders empty and error+retry states without mutation affordances', () => {
    const onRetry = jest.fn();
    const errorTree = ResourceListScreen({
      title: 'Sites',
      subtitle: 'Farm: North Farm',
      items: [],
      loading: false,
      emptyText: 'No production sites are available for this farm.',
      error: '403 Forbidden: access denied',
      onRetry,
      onSelect: jest.fn(),
    });

    const errorPressable = flattenNodes(errorTree).find(
      (node) =>
        React.isValidElement(node) && node.type === Pressable && textValues(node).includes('Retry'),
    ) as any;

    expect(textValues(errorTree)).toContain('403 Forbidden: access denied');
    expect(errorPressable).toBeTruthy();
    if (errorPressable && React.isValidElement(errorPressable)) {
      (errorPressable as any).props.onPress();
    }
    expect(onRetry).toHaveBeenCalledTimes(1);

    const emptyTree = ResourceListScreen({
      title: 'Sites',
      subtitle: 'Farm: North Farm',
      items: [],
      loading: false,
      emptyText: 'No production sites are available for this farm.',
      error: null,
      onSelect: jest.fn(),
    });

    expect(textValues(emptyTree)).toContain('No production sites are available for this farm.');
    expect(
      flattenNodes(emptyTree).filter(
        (node) => React.isValidElement(node) && node.type === Pressable,
      ),
    ).toHaveLength(0);
  });

  test('passes item identity through the select action for the hierarchy flow', () => {
    const onSelect = jest.fn();
    const tree = ResourceListScreen({
      title: 'Units',
      subtitle: 'Site: Pond 01',
      items: [
        { id: 'unit-1', label: 'Tank A1', sublabel: 'TANK-01', status: 'active' },
        { id: 'unit-2', label: 'Tank B2', sublabel: 'TANK-02', status: 'planned' },
      ],
      loading: false,
      emptyText: 'No production units are available for this site.',
      error: null,
      onSelect,
    });

    const pressables = flattenNodes(tree).filter(
      (node) => React.isValidElement(node) && node.type === Pressable,
    ) as any[];

    expect(pressables).toHaveLength(2);
    pressables[0].props.onPress();
    expect(onSelect).toHaveBeenCalledWith({
      id: 'unit-1',
      label: 'Tank A1',
      sublabel: 'TANK-01',
      status: 'active',
    });
  });

  test('renders server-authoritative projection data and sorts events chronologically', () => {
    const tree = BatchDetailPanel({
      batch: {
        code: 'B-001',
        state: 'active',
        species: 'Tilapia',
        unit_id: 'unit-42',
        unit_name: 'North Tank 2',
        farm_name: 'North Farm',
      },
      projection: {
        initial_stocked_quantity: 120,
        estimated_remaining_population: 95,
        survival_rate: 0.79,
        computed_at: '2026-09-21T00:00:00Z',
      },
      events: [
        { performed_at: '2026-09-21T10:00:00Z', event_type: 'FEEDING' },
        { performed_at: '2026-09-20T09:00:00Z', event_type: 'STOCKING' },
      ],
    });

    const values = textValues(tree);

    expect(values).toContain('B-001');
    expect(values).toContain('Active');
    expect(values.some((value) => value.includes('Farm:'))).toBe(true);
    expect(values).toContain('North Farm');
    expect(values.some((value) => value.includes('Unit:'))).toBe(true);
    expect(values).toContain('North Tank 2');
    expect(values).toContain('Initial stocked: ');
    expect(values).toContain('120');
    expect(values).toContain('Estimated remaining: ');
    expect(values).toContain('95');
    expect(values).toContain('Survival rate: ');
    expect(values).toContain('0.79');
    expect(values).toContain('STOCKING');
    expect(values).toContain('FEEDING');
    expect(values.indexOf('STOCKING')).toBeLessThan(values.indexOf('FEEDING'));
    expect(
      flattenNodes(tree).filter((node) => React.isValidElement(node) && node.type === Pressable),
    ).toHaveLength(0);
  });

  test('surfaces the no-data empty batch state without any mutation action', () => {
    const tree = BatchDetailPanel({
      batch: {
        code: 'B-002',
        state: 'planned',
        species: 'Shrimp',
        unit_id: 'unit-9',
      },
      projection: null,
      events: [],
    });

    const values = textValues(tree);

    expect(values).toContain('No projection is available for this batch.');
    expect(values).toContain('No batch events recorded.');
    expect(
      flattenNodes(tree).filter((node) => React.isValidElement(node) && node.type === Pressable),
    ).toHaveLength(0);
  });

  test('displays authoritative batch state returned by water-quality reconciliation', () => {
    const routeState: { value: unknown }[] = [
      { value: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' } },
      {
        value: {
          initial_stocked_quantity: 100,
          estimated_remaining_population: 100,
          survival_rate: 0.8,
        },
      },
      { value: [{ event_type: 'FEEDING', performed_at: '2026-09-24T10:00:00Z' }] },
      { value: false },
      { value: null },
    ];
    let stateIndex = 0;
    const useStateSpy = React.useState as unknown as jest.Mock;
    const useEffectSpy = React.useEffect as unknown as jest.Mock;
    const useMemoSpy = React.useMemo as unknown as jest.Mock;
    useStateSpy.mockReset();
    useEffectSpy.mockReset();
    useMemoSpy.mockReset();
    useStateSpy.mockImplementation(() => {
      const slot = routeState[stateIndex++];
      return [
        slot.value,
        (next: unknown) => {
          slot.value =
            typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next;
        },
      ];
    });
    useEffectSpy.mockImplementation(() => undefined);
    useMemoSpy.mockImplementation((factory: () => unknown) => factory());

    const renderBatchDetail = () => {
      stateIndex = 0;
      const panel = ProductionBatchDetailScreen() as React.ReactElement<any>;
      return BatchDetailPanel(panel.props);
    };

    try {
      const beforeReconciliation = renderBatchDetail();
      const initialMortalityForm = flattenNodes(beforeReconciliation).find(
        (node) => React.isValidElement(node) && node.type === MortalityForm,
      ) as React.ReactElement<any>;
      expect(initialMortalityForm.props.currentEstimatedRemainingPopulation).toBe(100);
      const form = flattenNodes(beforeReconciliation).find(
        (node) => React.isValidElement(node) && node.type === WaterQualityForm,
      ) as React.ReactElement<any>;
      form.props.onSaved(
        { idempotencyKey: 'water-quality-key-refresh' },
        {
          batch: { id: 'batch-refresh', code: 'B-009', state: 'stocked', species: 'Shrimp' },
          projection: { initial_stocked_quantity: 250, survival_rate: 0.91 },
          events: [{ event_type: 'WATER_QUALITY', performed_at: '2026-09-25T14:30:00Z' }],
        },
      );

      const refreshedValues = textValues(renderBatchDetail());
      expect(refreshedValues).toContain('Stocked');
      expect(refreshedValues).toContain('250');
      expect(refreshedValues).toContain('0.91');
      expect(refreshedValues).toContain('WATER_QUALITY');
      expect(refreshedValues).not.toContain('100');

      const mortalityForm = flattenNodes(renderBatchDetail()).find(
        (node) => React.isValidElement(node) && node.type === MortalityForm,
      ) as React.ReactElement<any>;
      mortalityForm.props.onSaved(
        { idempotencyKey: 'mortality-key-route' },
        {
          batch: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' },
          projection: {
            initial_stocked_quantity: 250,
            cumulative_mortality: 4,
            estimated_remaining_population: 246,
            survival_rate: 0.984,
          },
          events: [{ event_type: 'MORTALITY', performed_at: '2026-09-26T08:30:00Z' }],
        },
      );
      const mortalityRefreshedValues = textValues(renderBatchDetail());
      expect(mortalityRefreshedValues).toContain('246');
      expect(mortalityRefreshedValues).toContain('MORTALITY');

      const mortalityFormAfterWrite = flattenNodes(renderBatchDetail()).find(
        (node) => React.isValidElement(node) && node.type === MortalityForm,
      ) as React.ReactElement<any>;
      expect(mortalityFormAfterWrite.props.currentEstimatedRemainingPopulation).toBe(246);
      mortalityFormAfterWrite.props.onConflictRefreshed({
        batch: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' },
        projection: {
          initial_stocked_quantity: 250,
          cumulative_mortality: 25,
          estimated_remaining_population: 225,
          survival_rate: 0.9,
        },
        events: [
          { event_type: 'MORTALITY', performed_at: '2026-09-26T08:30:00Z' },
          { event_type: 'MORTALITY', performed_at: '2026-09-27T09:00:00Z' },
        ],
      });
      const conflictRefreshedValues = textValues(renderBatchDetail());
      expect(conflictRefreshedValues).toContain('225');
      const mortalityFormAfterConflict = flattenNodes(renderBatchDetail()).find(
        (node) => React.isValidElement(node) && node.type === MortalityForm,
      ) as React.ReactElement<any>;
      expect(mortalityFormAfterConflict.props.currentEstimatedRemainingPopulation).toBe(225);

      const samplingForm = flattenNodes(renderBatchDetail()).find(
        (node) => React.isValidElement(node) && node.type === SamplingForm,
      ) as React.ReactElement<any>;
      samplingForm.props.onSaved(
        { idempotencyKey: 'sampling-key-route' },
        {
          batch: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' },
          projection: {
            initial_stocked_quantity: 250,
            estimated_remaining_population: 228,
            latest_average_weight: 4.8,
            survival_rate: 0.912,
          },
          events: [{ event_type: 'SAMPLING', performed_at: '2026-09-27T00:00:00Z' }],
        },
      );
      const samplingRefreshedValues = textValues(renderBatchDetail());
      expect(samplingRefreshedValues).toContain('228');
      expect(samplingRefreshedValues).toContain('SAMPLING');
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('renders the non-inventory feeding write form from batch detail', () => {
    const tree = BatchDetailPanel({
      batch: { code: 'B-FEED', state: 'active', species: 'Shrimp' },
      projection: { initial_stocked_quantity: 100, estimated_remaining_population: 100 },
      events: [],
      feedingContext: { batchId: 'batch-feed', batchName: 'B-FEED' },
    });

    const feedingElement = flattenNodes(tree).find(
      (node) => React.isValidElement(node) && node.type === FeedingForm,
    ) as React.ReactElement<any>;
    expect(feedingElement).toBeTruthy();
  });

  test('passes authoritative lifecycle state and reconciliation callbacks to STOCKING', () => {
    const onStockingSaved = jest.fn();
    const onStockingConflictRefreshed = jest.fn();
    const tree = BatchDetailPanel({
      batch: { id: 'batch-stock', code: 'B-STOCK', state: 'planned' },
      projection: null,
      events: [],
      stockingContext: { batchId: 'batch-stock', batchName: 'B-STOCK' },
      onStockingSaved,
      onStockingConflictRefreshed,
    });
    const stocking = flattenNodes(tree).find(
      (node) => React.isValidElement(node) && node.type === StockingForm,
    ) as React.ReactElement<any>;
    expect(stocking).toBeTruthy();
    expect(stocking.props.batchState).toBe('planned');
    stocking.props.onSaved({}, { batch: { state: 'stocked' }, projection: {}, events: [] });
    stocking.props.onConflictRefreshed({ batch: { state: 'planned' }, projection: {}, events: [] });
    expect(onStockingSaved).toHaveBeenCalledTimes(1);
    expect(onStockingConflictRefreshed).toHaveBeenCalledTimes(1);
  });

  test('renders STOCKING only as a PLANNED batch workflow and wires authoritative refresh', () => {
    const onSaved = jest.fn();
    const onConflictRefreshed = jest.fn();
    const plannedTree = BatchDetailPanel({
      batch: { id: 'batch-stock', code: 'B-STOCK', state: 'planned' },
      projection: null,
      events: [],
      stockingContext: { batchId: 'batch-stock', batchName: 'B-STOCK' },
      onStockingSaved: onSaved,
      onStockingConflictRefreshed: onConflictRefreshed,
    });
    const stocking = flattenNodes(plannedTree).find(
      (node) => React.isValidElement(node) && node.type === StockingForm,
    ) as React.ReactElement<any>;
    expect(stocking).toBeTruthy();
    expect(stocking.props.batchState).toBe('planned');
    expect(stocking.props.onSaved).toEqual(expect.any(Function));
    expect(stocking.props.onConflictRefreshed).toBe(onConflictRefreshed);

    const stockedTree = BatchDetailPanel({
      batch: { id: 'batch-stock', code: 'B-STOCK', state: 'stocked' },
      projection: null,
      events: [],
      stockingContext: { batchId: 'batch-stock', batchName: 'B-STOCK' },
    });
    const disabledStocking = flattenNodes(stockedTree).find(
      (node) => React.isValidElement(node) && node.type === StockingForm,
    ) as React.ReactElement<any>;
    expect(disabledStocking.props.batchState).toBe('stocked');
  });

  test('mounts TRANSFER only for STOCKED, ACTIVE or SUSPENDED batches and wires reconciliation callbacks', () => {
    const onTransferSaved = jest.fn();
    const onTransferConflictRefreshed = jest.fn();
    const findTransfer = (state: string, withContext = true) =>
      flattenNodes(
        BatchDetailPanel({
          batch: { id: 'batch-t', code: 'B-T', state, unit_id: 'unit-t' },
          projection: { estimated_remaining_population: 500 },
          events: [],
          transferContext: withContext
            ? { batchId: 'batch-t', batchName: 'B-T', sourceUnitId: 'unit-fallback' }
            : undefined,
          onTransferSaved,
          onTransferConflictRefreshed,
        }),
      ).find((node) => React.isValidElement(node) && node.type === TransferForm) as
        React.ReactElement<any> | undefined;

    expect(findTransfer('planned')).toBeUndefined();
    expect(findTransfer('harvested')).toBeUndefined();
    expect(findTransfer('failed')).toBeUndefined();
    expect(findTransfer('active', false)).toBeUndefined();
    for (const state of ['stocked', 'active', 'suspended']) {
      const transfer = findTransfer(state);
      expect(transfer).toBeTruthy();
      expect(transfer!.props.batchId).toBe('batch-t');
      expect(transfer!.props.batchState).toBe(state);
      expect(transfer!.props.sourceUnitId).toBe('unit-t');
      expect(transfer!.props.currentEstimatedRemainingPopulation).toBe(500);
      expect(transfer!.props.onConflictRefreshed).toBe(onTransferConflictRefreshed);
    }
    findTransfer('active')!.props.onSaved({}, { batch: {}, projection: {}, events: [] });
    expect(onTransferSaved).toHaveBeenCalledTimes(1);
  });

  test('keeps TRANSFER mounted for an unresolved write after the source becomes terminal', async () => {
    const batchId = 'batch-recover';
    const post = jest.fn().mockRejectedValue(new Error('network down'));
    const readers = {
      getBatch: jest.fn(),
      getProjection: jest.fn(),
      listEvents: jest.fn(),
    };
    await reconcileTransferWrite({
      context: { batchId },
      payload: {
        source_unit_id: 'unit-a',
        destination_unit_id: 'unit-b',
        destination_batch_id: 'batch-b',
        quantity: '5',
        transfer_loss: '0',
        transferred_at: '2020-01-01T00:00:00Z',
      },
      idempotencyKey: 'ui-recover-key',
      post,
      readers,
    });
    expect(getTransferWriteRecovery(batchId)).not.toBeNull();
    try {
      const tree = BatchDetailPanel({
        batch: { id: batchId, code: 'B-R', state: 'failed' },
        projection: null,
        events: [],
        transferContext: { batchId, batchName: 'B-R' },
      });
      const transfer = flattenNodes(tree).find(
        (node) => React.isValidElement(node) && node.type === TransferForm,
      ) as React.ReactElement<any> | undefined;
      expect(transfer).toBeTruthy();
      expect(transfer!.props.batchState).toBe('failed');
    } finally {
      clearTransferWriteRecovery(batchId, 'ui-recover-key');
    }
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('mounts HARVEST for STOCKED, ACTIVE or SUSPENDED batches and wires reconciliation callbacks', () => {
    const onHarvestSaved = jest.fn();
    const onHarvestConflictRefreshed = jest.fn();
    const findHarvest = (state: string, withContext = true) =>
      flattenNodes(
        BatchDetailPanel({
          batch: { id: 'batch-h', code: 'B-H', state },
          projection: { estimated_remaining_population: 321 },
          events: [],
          harvestContext: withContext ? { batchId: 'batch-h', batchName: 'B-H' } : undefined,
          onHarvestSaved,
          onHarvestConflictRefreshed,
        }),
      ).find((node) => React.isValidElement(node) && node.type === HarvestForm) as
        React.ReactElement<any> | undefined;

    for (const state of ['planned', 'failed', 'closed']) {
      expect(findHarvest(state)).toBeUndefined();
    }
    expect(findHarvest('active', false)).toBeUndefined();
    for (const state of ['stocked', 'active', 'suspended']) {
      const harvest = findHarvest(state);
      expect(harvest).toBeTruthy();
      expect(harvest!.props.batchState).toBe(state);
      expect(harvest!.props.currentEstimatedRemainingPopulation).toBe(321);
      expect(harvest!.props.onConflictRefreshed).toBe(onHarvestConflictRefreshed);
    }
    expect(findHarvest('harvested')!.key).toBe('batch-h');
    findHarvest('active')!.props.onSaved({}, { batch: {}, projection: {}, events: [] });
    expect(onHarvestSaved).toHaveBeenCalledTimes(1);
  });

  test('keeps HARVEST mounted for an unresolved write after the batch becomes HARVESTED', async () => {
    const batchId = 'batch-harvest-recover';
    const post = jest.fn().mockRejectedValue(new Error('network down'));
    await reconcileHarvestWrite({
      context: { batchId },
      payload: { quantity: '5', total_weight: '2', weight_unit: 'kg', is_final: false },
      idempotencyKey: 'ui-harvest-recover',
      post,
      readAll: jest.fn(),
    });
    expect(getHarvestWriteRecovery(batchId)).not.toBeNull();
    try {
      const tree = BatchDetailPanel({
        batch: { id: batchId, code: 'B-R', state: 'harvested' },
        projection: null,
        events: [],
        harvestContext: { batchId, batchName: 'B-R' },
      });
      const harvest = flattenNodes(tree).find(
        (node) => React.isValidElement(node) && node.type === HarvestForm,
      ) as React.ReactElement<any> | undefined;
      expect(harvest).toBeTruthy();
      expect(harvest!.props.batchState).toBe('harvested');
    } finally {
      clearHarvestWriteRecovery(batchId, 'ui-harvest-recover');
    }
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('the batch screen wires HARVEST context and authoritative refresh callbacks', () => {
    const routeState: { value: unknown }[] = [
      { value: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' } },
      { value: { initial_stocked_quantity: 100, estimated_remaining_population: 100 } },
      { value: [] },
      { value: false },
      { value: null },
    ];
    let stateIndex = 0;
    const useStateSpy = React.useState as unknown as jest.Mock;
    const useEffectSpy = React.useEffect as unknown as jest.Mock;
    const useMemoSpy = React.useMemo as unknown as jest.Mock;
    useStateSpy.mockReset();
    useEffectSpy.mockReset();
    useMemoSpy.mockReset();
    useStateSpy.mockImplementation(() => {
      const slot = routeState[stateIndex++];
      return [
        slot.value,
        (next: unknown) => {
          slot.value =
            typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next;
        },
      ];
    });
    useEffectSpy.mockImplementation(() => undefined);
    useMemoSpy.mockImplementation((factory: () => unknown) => factory());
    const renderPanel = () => {
      stateIndex = 0;
      const panel = ProductionBatchDetailScreen() as React.ReactElement<any>;
      return panel.props;
    };
    const props = renderPanel();
    expect(props.harvestContext).toMatchObject({ batchId: 'batch-refresh' });
    props.onHarvestSaved({
      batch: { id: 'batch-refresh', code: 'B-009', state: 'harvested', species: 'Shrimp' },
      projection: { initial_stocked_quantity: 100, estimated_remaining_population: 0 },
      events: [{ event_type: 'HARVEST', performed_at: '2026-09-26T08:30:00Z' }],
    });
    const refreshed = renderPanel();
    expect(refreshed.batch.state).toBe('harvested');
    expect(refreshed.projection.estimated_remaining_population).toBe(0);
    refreshed.onHarvestConflictRefreshed({
      batch: { id: 'batch-refresh', code: 'B-009', state: 'active', species: 'Shrimp' },
      projection: { initial_stocked_quantity: 100, estimated_remaining_population: 60 },
      events: [],
    });
    expect(renderPanel().projection.estimated_remaining_population).toBe(60);
  });
});

test('production identity cannot render QA recovery controls even with the public flag set', () => {
  const flag = process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
  process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
  (React.useState as jest.Mock).mockImplementation((value) => [
    typeof value === 'function' ? value() : value,
    jest.fn(),
  ]);
  try {
    expect(HarvestRecoveryQaControls()).toBeNull();
  } finally {
    if (flag === undefined) delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    else process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = flag;
  }
});

test('QA controls disarm unused faults separately from releasing a persisted-boundary pause', async () => {
  const originalConfig = Constants.expoConfig;
  const originalFlag = process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
  Constants.expoConfig = {
    name: 'Agrovix AgOS F-D QA',
    slug: 'agrovix',
    extra: { appVariant: 'fdqa', fdQaFaultInjection: true },
    ios: { bundleIdentifier: 'com.agrovix.agos.fdqa' },
    android: { package: 'com.agrovix.agos.fdqa' },
  };
  process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
  (React.useState as jest.Mock).mockImplementation((value) => [
    typeof value === 'function' ? value() : value,
    jest.fn(),
  ]);
  const checkpointOwner = captureHarvestRecoveryFaultAttempt();
  try {
    const tree = HarvestRecoveryQaControls();
    const button = (label: string) =>
      flattenNodes(HarvestRecoveryQaControls()).find(
        (node) =>
          React.isValidElement(node) && node.type === Pressable && textValues(node).includes(label),
      ) as React.ReactElement<any>;
    expect(textValues(tree)).toContain('No fault armed');
    expect(button('Disarm unused QA fault').props.disabled).toBe(true);
    button('Arm storage failure: write').props.onPress();
    expect(button('Disarm unused QA fault').props.disabled).toBe(false);
    button('Disarm unused QA fault').props.onPress();
    expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
    expect(consumeHarvestRecoveryStorageFailure('write')).toBe(false);
    button('Arm storage failure: write').props.onPress();
    expect(getHarvestRecoveryFaultSnapshot().armed).toEqual({
      kind: 'storage_failure',
      operation: 'write',
    });
    expect(consumeHarvestRecoveryStorageFailure('write')).toBe(true);
    expect(consumeHarvestRecoveryStorageFailure('write')).toBe(false);
    button('Arm pause: after_posting').props.onPress();
    const pending = runHarvestRecoveryFaultCheckpoint('after_posting');
    expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_posting');
    expect(button('Disarm unused QA fault').props.disabled).toBe(true);
    button('Disarm unused QA fault').props.onPress();
    expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_posting');
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'read' })).toBe(false);
    button('Release QA pause').props.onPress();
    await pending;
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
  } finally {
    releaseHarvestRecoveryCheckpoint(checkpointOwner);
    Constants.expoConfig = originalConfig;
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    else process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = originalFlag;
  }
});

// Same hook-driver approach as production-write.test.ts. React hooks, session
// provider and external API/SecureStore adapters are mocked; the form, recovery
// ledger, fault hooks and auth epoch run unchanged.
describe('F-D HARVEST form recovery integration', () => {
  const BATCH = 'fdqa-form-regression';
  const KEY = harvestRecoveryStorageKey(BATCH)!;
  const api = productionApi as jest.Mocked<typeof productionApi>;
  const store = new Map<string, string>();
  const originalConfig = Constants.expoConfig;
  const originalFlag = process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
  let states: unknown[];
  let refs: { current: unknown }[];
  let stateIndex: number;
  let refIndex: number;
  let effects: (() => unknown)[];
  let cleanups: unknown[];
  let pending: Promise<unknown>[];
  let failDelete: boolean;
  let writes: string[];
  let checkpointOwner: HarvestRecoveryFaultAttempt;
  let accepted: { key: string; body: any } | null;
  const onSaved = jest.fn();
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const text = (node: unknown) => textValues(node).join(' ').replace(/\s+/g, ' ');
  const stored = () => JSON.parse(store.get(KEY)!) as HarvestRecoveryRecord;
  const identity = (record: HarvestRecoveryRecord) => ({
    userId: record.userId,
    batchId: record.batchId,
    idempotencyKey: record.idempotencyKey,
    performedAt: record.performedAt,
    createdAt: record.createdAt,
    payload: record.payload,
  });
  const mount = () => {
    states = [];
    refs = [];
    effects = [];
    cleanups = [];
    (React.useState as jest.Mock).mockImplementation((initial: unknown) => {
      const index = stateIndex++;
      if (states.length <= index) states.push(typeof initial === 'function' ? initial() : initial);
      return [
        states[index],
        (next: unknown) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next;
        },
      ];
    });
    (React.useRef as jest.Mock).mockImplementation((initial: unknown) => {
      const index = refIndex++;
      if (refs.length <= index) refs.push({ current: initial });
      return refs[index];
    });
    (React.useEffect as jest.Mock).mockImplementation((effect: () => unknown) =>
      effects.push(effect),
    );
  };
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    const tree = HarvestForm({
      batchId: BATCH,
      batchState: 'active',
      currentEstimatedRemainingPopulation: 100,
      onSaved,
    });
    return { tree, text: text(tree), elements: flattenNodes(tree) as React.ReactElement<any>[] };
  };
  const runMountEffects = async () => {
    effects = [];
    render();
    cleanups = effects.map((effect) => effect());
    effects = [];
    await flush();
  };
  const unmount = () =>
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === 'function') cleanup();
    });
  const clearMemory = () => {
    const recovery = getHarvestWriteRecovery(BATCH);
    if (recovery) clearHarvestWriteRecovery(BATCH, recovery.submission.idempotencyKey);
  };
  const restart = async () => {
    unmount();
    clearMemory();
    mount();
    await runMountEffects();
    return render();
  };
  const button = (label: string) =>
    render().elements.find(
      (element) => element.type === Pressable && text(element).includes(label),
    );
  const press = (label: string) => {
    const control = button(label);
    expect(control).toBeDefined();
    expect(control!.props.disabled).not.toBe(true);
    // The native onPress intentionally returns void; drain its asynchronous work explicitly.
    const result = Promise.resolve(control!.props.onPress()).then(flush);
    pending.push(result);
    return result;
  };
  const prepare = async () => {
    await runMountEffects();
    const fields = render().elements.filter((element) => element.type === TextInput);
    fields[0].props.onChangeText('40');
    fields[1].props.onChangeText('25.5');
    fields[3].props.onChangeText('Disposable QA regression');
    await press('I confirm 40 individuals');
  };
  const expectLocked = () => {
    expect(button('Submit harvest')).toBeUndefined();
    const fields = render().elements.filter((element) => element.type === TextInput);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.props.editable === false)).toBe(true);
  };
  const expectDispatchIdentity = (call: number, record: HarvestRecoveryRecord) => {
    const [batchId, body, key] = api.createBatchEvent.mock.calls[call];
    expect(batchId).toBe(record.batchId);
    expect(key).toBe(record.idempotencyKey);
    expect(body.event_type).toBe('HARVEST');
    expect(body.performed_at).toBe(record.performedAt);
    expect(body.data).toEqual(record.payload);
    expect(body.data?.harvested_at).toBe(record.payload.harvested_at);
  };
  const waitForPause = async (point: string) => {
    for (let i = 0; i < 10 && getHarvestRecoveryFaultSnapshot().pausedAt !== point; i++)
      await flush();
    expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe(point);
    checkpointOwner = render().elements.find(
      (element) => element.type === HarvestRecoveryQaControls,
    )!.props.attempt;
  };
  const unknownPost = () =>
    api.createBatchEvent.mockRejectedValueOnce(
      new ApiFailure(
        'network',
        'https://qa.invalid',
        '/events',
        undefined,
        'TypeError',
        'lost response',
      ),
    );

  beforeEach(() => {
    beginAuthOperation();
    store.clear();
    pending = [];
    checkpointOwner = null;
    writes = [];
    failDelete = false;
    accepted = null;
    onSaved.mockReset();
    mockHarvestSessionUserId = 'user-1';
    Constants.expoConfig = {
      name: 'Agrovix AgOS F-D QA',
      slug: 'agrovix',
      extra: { appVariant: 'fdqa', fdQaFaultInjection: true },
      ios: { bundleIdentifier: 'com.agrovix.agos.fdqa' },
      android: { package: 'com.agrovix.agos.fdqa' },
    };
    process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
    (getCurrentUser as jest.Mock).mockReset().mockResolvedValue({ id: 'user-1' });
    (SecureStore.getItemAsync as jest.Mock)
      .mockReset()
      .mockImplementation(async (key: string) => store.get(key) ?? null);
    (SecureStore.setItemAsync as jest.Mock)
      .mockReset()
      .mockImplementation(async (key: string, value: string) => {
        writes.push(value);
        store.set(key, value);
      });
    (SecureStore.deleteItemAsync as jest.Mock)
      .mockReset()
      .mockImplementation(async (key: string) => {
        if (failDelete) throw new Error('QA delete unavailable');
        store.delete(key);
      });
    api.createBatchEvent.mockReset().mockImplementation(async (_batchId, body, key) => {
      accepted = { key, body };
      return { id: 'qa-event', event_type: 'HARVEST', idempotency_key: key };
    });
    api.getProductionBatch.mockReset().mockImplementation(async (id) => ({ id, state: 'active' }));
    api.getBatchProjections.mockReset().mockResolvedValue({ estimated_remaining_population: 60 });
    api.listBatchEvents.mockReset().mockImplementation(async () => ({
      items: accepted
        ? [
            {
              batch_id: BATCH,
              event_type: 'HARVEST',
              idempotency_key: accepted.key,
              performed_at: accepted.body.performed_at,
              data: accepted.body.data,
            },
          ]
        : [],
      next_cursor: null,
      limit: 25,
    }));
    api.listAllBatchEvents.mockReset().mockImplementation(async (id, operation, isCurrent) => {
      if (isCurrent && !isCurrent()) throw new Error('Stale QA context');
      const page = await api.listBatchEvents(id, {}, operation);
      if (isCurrent && !isCurrent()) throw new Error('Stale QA context');
      return page.items;
    });
    mount();
  });
  afterEach(async () => {
    releaseHarvestRecoveryCheckpoint(checkpointOwner);
    await Promise.allSettled(pending);
    await flush();
    unmount();
    clearMemory();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    Constants.expoConfig = originalConfig;
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    else process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = originalFlag;
  });

  test.each([
    ['after_prepared', 'PREPARED'],
    ['after_posting', 'POSTING'],
  ] as const)(
    '%s prevents dispatch until explicit release, then sends the original identity once',
    async (point, status) => {
      await prepare();
      expect(armHarvestRecoveryFault({ kind: 'checkpoint', point })).toBe(true);
      const submission = press('Submit harvest');
      await waitForPause(point);
      const record = stored();
      expect(record.status).toBe(status);
      expect(store.get(KEY)).toBe(writes[writes.length - 1]);
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      // The in-flight guard must reject a repeated handler call even before busy UI is set.
      const repeated = button('Submit harvest');
      if (repeated) repeated.props.onPress();
      await flush();
      expect(store.get(KEY)).toBe(JSON.stringify(record));
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
      await submission;
      await flush();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expectDispatchIdentity(0, record);
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(store.has(KEY)).toBe(false);
    },
  );

  test.each([
    ['after_accepted', 'ACCEPTED_UNRECONCILED'],
    ['after_reconciled', 'RECONCILED'],
  ] as const)(
    '%s retains accepted state before reconciliation or deletion and never re-posts',
    async (point, status) => {
      await prepare();
      expect(armHarvestRecoveryFault({ kind: 'checkpoint', point })).toBe(true);
      const submission = press('Submit harvest');
      await waitForPause(point);
      const record = stored();
      expect(record.status).toBe(status);
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expectDispatchIdentity(0, record);
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      if (point === 'after_accepted') expect(api.listAllBatchEvents).not.toHaveBeenCalled();
      else expect(api.listAllBatchEvents).toHaveBeenCalledTimes(1);
      expectLocked();
      await flush();
      expect(store.get(KEY)).toBe(JSON.stringify(record));
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
      await submission;
      await flush();
      expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
      expect(store.has(KEY)).toBe(false);
      expect(onSaved).toHaveBeenCalledTimes(1);
    },
  );

  test('cold restoration after an uncertain POST retries the exact payload, timestamps and key', async () => {
    await prepare();
    unknownPost();
    await press('Submit harvest');
    const record = stored();
    expect(record.status).toBe('OUTCOME_UNKNOWN');
    expectDispatchIdentity(0, record);
    expectLocked();
    await restart();
    expect(stored()).toEqual(record);
    expectLocked();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    await press('Retry same harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
    expectDispatchIdentity(1, record);
    for (const value of writes) expect(identity(JSON.parse(value))).toEqual(identity(record));
    expect(onSaved.mock.calls[0][0]).toMatchObject({
      idempotencyKey: record.idempotencyKey,
      payload: record.payload,
      performedAt: record.performedAt,
      createdAt: record.createdAt,
    });
    expect(store.has(KEY)).toBe(false);
  });

  test('accepted recovery stays read-only across cold restoration and explicit reconciliation', async () => {
    await prepare();
    api.listBatchEvents.mockResolvedValue({ items: [], next_cursor: null, limit: 25 });
    await press('Submit harvest');
    const record = stored();
    expect(record.status).toBe('ACCEPTED_UNRECONCILED');
    expectLocked();
    expect(onSaved).not.toHaveBeenCalled();
    await restart();
    expect(stored()).toEqual(record);
    await press('Reconcile previous harvest');
    expect(stored()).toEqual(record);
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    api.listBatchEvents.mockResolvedValue({
      items: [
        {
          batch_id: BATCH,
          event_type: 'HARVEST',
          idempotency_key: record.idempotencyKey,
          performed_at: record.performedAt,
          data: record.payload,
        },
      ],
      next_cursor: null,
      limit: 25,
    });
    await press('Reconcile previous harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(store.has(KEY)).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expectDispatchIdentity(0, record);
  });

  test.each([
    ['after_prepared', 'PREPARED', 'signout'],
    ['after_posting', 'POSTING', 'signout'],
    ['after_prepared', 'PREPARED', 'epoch'],
    ['after_posting', 'POSTING', 'epoch'],
  ] as const)(
    'auth invalidation during %s (%s, %s) prevents dispatch even after release',
    async (point, status, invalidation) => {
      await prepare();
      expect(armHarvestRecoveryFault({ kind: 'checkpoint', point })).toBe(true);
      const submission = press('Submit harvest');
      await waitForPause(point);
      const raw = store.get(KEY);
      expect(stored().status).toBe(status);
      beginAuthOperation();
      if (invalidation === 'signout') mockHarvestSessionUserId = null;
      // No rerender is needed for the auth-operation guard to stop the pending dispatch.
      expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
      await submission;
      await flush();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(store.get(KEY)).toBe(raw);
      await restart();
      expect(api.createBatchEvent).not.toHaveBeenCalled();
      if (invalidation === 'signout') {
        expect(button('Retry same harvest')).toBeUndefined();
        expect(button('Submit harvest')?.props.disabled).toBe(true);
      } else {
        expect(button('Retry same harvest')).toBeDefined();
        expectLocked();
      }
      expect(store.get(KEY)).toBe(raw);
    },
  );

  test('verification-read failure after POSTING persistence retains recoverable original bytes', async () => {
    await prepare();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    const submission = press('Submit harvest');
    await waitForPause('after_prepared');
    const prepared = stored();
    releaseHarvestRecoveryCheckpoint(checkpointOwner);
    await Promise.resolve(); // release consumes the checkpoint before arming the next one-shot fault
    expect(
      armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'verification_read' }),
    ).toBe(true);
    await submission;
    await flush();
    const record = stored();
    // POSTING bytes survived the failed verification; the form then conservatively
    // classifies the unresolved attempt as OUTCOME_UNKNOWN without dispatching.
    expect(writes.map((value) => JSON.parse(value).status)).toEqual([
      'PREPARED',
      'POSTING',
      'OUTCOME_UNKNOWN',
    ]);
    expect(record.status).toBe('OUTCOME_UNKNOWN');
    expect(identity(record)).toEqual(identity(prepared));
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expectLocked();
    await restart();
    expect(stored()).toEqual(record);
    expectLocked();
    await press('Retry same harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expectDispatchIdentity(0, record);
    expect(store.has(KEY)).toBe(false);
  });

  test('failed accepted-record deletion preserves RECONCILED identity until read-only cleanup succeeds', async () => {
    await prepare();
    expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'delete' })).toBe(true);
    await press('Submit harvest');
    const record = stored();
    expect(record.status).toBe('RECONCILED');
    expectLocked();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    // Recovery survives loss of all in-memory write state.
    await restart();
    expect(stored()).toEqual(record);
    await press('Reconcile previous harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(store.has(KEY)).toBe(false);
    expect(getHarvestWriteRecovery(BATCH)).toBeNull();
    expectDispatchIdentity(0, record);
  });

  test('uncertain cleanup after PREPARED verification failure retains durable identity and blocks a new submission', async () => {
    await prepare();
    failDelete = true;
    expect(
      armHarvestRecoveryFault({ kind: 'storage_failure', operation: 'verification_read' }),
    ).toBe(true);
    await press('Submit harvest');
    const raw = store.get(KEY);
    const record = stored();
    expect(record.status).toBe('PREPARED');
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(button('Submit harvest')?.props.disabled).toBe(true);
    expect(render().text).toContain('could not be removed from secure storage');
    await restart();
    expect(store.get(KEY)).toBe(raw);
    expectLocked();
    failDelete = false;
    await press('Retry same harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expectDispatchIdentity(0, record);
    expect(store.has(KEY)).toBe(false);
  });

  test('corrupt batch recovery blocks submission without a POST, write, delete or byte change', async () => {
    const raw = '{"version":2,"userId":"user-1","batchId":';
    store.set(KEY, raw);
    await runMountEffects();
    expect(render().text).toContain('unreadable');
    expect(button('Submit harvest')?.props.disabled).toBe(true);
    expect(button('Retry same harvest')).toBeUndefined();
    // Even a direct handler invocation must fail closed independently of disabled UI.
    await Promise.resolve(button('Submit harvest')!.props.onPress());
    await restart();
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe(raw);
  });
  test('unused acceptance fault expires after backend rejection and cannot affect a subsequent submission', async () => {
    await prepare();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_accepted' })).toBe(true);
    api.createBatchEvent.mockRejectedValueOnce(
      new ApiError(403, 'forbidden', 'https://qa.invalid', '/events'),
    );
    await press('Submit harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(render().text).toContain('do not have permission');
    await press('I confirm 40 individuals');
    await press('Submit harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(store.has(KEY)).toBe(false);
  });

  test('validation rejection cancels an unused fault before a later valid submission', async () => {
    await runMountEffects();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    await press('Submit harvest');
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    const fields = render().elements.filter((element) => element.type === TextInput);
    fields[0].props.onChangeText('40');
    fields[1].props.onChangeText('25.5');
    await press('I confirm 40 individuals');
    await press('Submit harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('explicit disarming during PREPARED leaves the paused mutation locked until release', async () => {
    await prepare();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    const submission = press('Submit harvest');
    await waitForPause('after_prepared');
    const raw = store.get(KEY);
    expect(disarmHarvestRecoveryFault()).toBe(false);
    const repeated = button('Submit harvest');
    if (repeated) repeated.props.onPress();
    await flush();
    expect(store.get(KEY)).toBe(raw);
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(releaseHarvestRecoveryCheckpoint(checkpointOwner)).toBe(true);
    await submission;
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expectDispatchIdentity(0, JSON.parse(raw!));
  });

  test('leaving the form cancels an unused selection before the next submission', async () => {
    await runMountEffects();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    await restart();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    const fields = render().elements.filter((element) => element.type === TextInput);
    fields[0].props.onChangeText('40');
    fields[1].props.onChangeText('25.5');
    await press('I confirm 40 individuals');
    await press('Submit harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('a recovery-blocked submission cancels the unused fault without touching corrupt data', async () => {
    const raw = '{corrupt';
    store.set(KEY, raw);
    await runMountEffects();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    button('Submit harvest')!.props.onPress();
    await flush();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe(raw);
    expect(writes).toEqual([]);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
  test('auth-generation change cancels an idle selection before another submission in the mounted form', async () => {
    await runMountEffects();
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' })).toBe(true);
    beginAuthOperation();
    await runMountEffects();
    expect(getHarvestRecoveryFaultSnapshot()).toEqual({ armed: null, pausedAt: null });
    expect(api.createBatchEvent).not.toHaveBeenCalled();
    const fields = render().elements.filter((element) => element.type === TextInput);
    fields[0].props.onChangeText('40');
    fields[1].props.onChangeText('25.5');
    await press('I confirm 40 individuals');
    await press('Submit harvest');
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
  test.each(['unmount', 'auth'] as const)(
    'stale form A %s cleanup cannot cancel replacement B selection',
    async (cleanup) => {
      await runMountEffects();
      const finishA = beginHarvestRecoveryFaultAttempt();
      const finishB = beginHarvestRecoveryFaultAttempt();
      const fault = { kind: 'storage_failure', operation: 'write' } as const;
      expect(armHarvestRecoveryFault(fault)).toBe(true);
      if (cleanup === 'unmount') unmount();
      else {
        beginAuthOperation();
        await runMountEffects();
      }
      const remaining = getHarvestRecoveryFaultSnapshot();
      finishA();
      const b = createHarvestRecoveryRecord(
        'user-1',
        createHarvestSubmission('cleanup-b', {
          quantity: 40,
          total_weight: 25.5,
          weight_unit: 'kg',
          is_final: false,
        }),
      );
      await expect(persistHarvestRecoveryRecord(b, finishB.identity)).rejects.toMatchObject({
        kind: 'write_failed',
      });
      await persistHarvestRecoveryRecord(b, finishB.identity);
      expect(store.get(harvestRecoveryStorageKey(b.batchId)!)).toBe(JSON.stringify(b));
      finishB();
      expect(remaining).toEqual({ armed: fault, pausedAt: null });
    },
  );
  test('a subsequent form submission can arm its fresh generation without accepting the completed owner', async () => {
    await prepare();
    const controls = () =>
      render().elements.find((element) => element.type === HarvestRecoveryQaControls)!;
    const oldOwner = controls().props.attempt;
    await press('Submit harvest');
    const nextOwner = controls().props.attempt;
    expect(nextOwner).not.toBe(oldOwner);
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' }, oldOwner)).toBe(
      false,
    );
    expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_posting' }, nextOwner)).toBe(
      true,
    );
    const fields = render().elements.filter((element) => element.type === TextInput);
    fields[0].props.onChangeText('40');
    fields[1].props.onChangeText('25.5');
    await press('I confirm 40 individuals');
    const submission = press('Submit harvest');
    await waitForPause('after_posting');
    const current = stored();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(1);
    expect(disarmHarvestRecoveryFault(oldOwner)).toBe(false);
    releaseHarvestRecoveryCheckpoint(checkpointOwner);
    await submission;
    await flush();
    expect(api.createBatchEvent).toHaveBeenCalledTimes(2);
    expectDispatchIdentity(1, current);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });
  const actualFormRelease = () => {
    const controls = render().elements.find(
      (element) => element.type === HarvestRecoveryQaControls,
    )!;
    const tree = HarvestRecoveryQaControls(controls.props);
    return (
      flattenNodes(tree).find(
        (node) =>
          React.isValidElement(node) &&
          node.type === Pressable &&
          textValues(node).includes('Release QA pause'),
      ) as React.ReactElement<any>
    ).props.onPress as () => boolean;
  };

  test('stale actual form release cannot resume a newer checkpoint; owner releases exactly once', async () => {
    await runMountEffects();
    const finishA = beginHarvestRecoveryFaultAttempt();
    const releaseA = actualFormRelease();
    const finishB = beginHarvestRecoveryFaultAttempt();
    await restart();
    const releaseB = actualFormRelease();
    expect(
      armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' }, finishB.identity),
    ).toBe(true);
    const b = createHarvestRecoveryRecord(
      'user-1',
      createHarvestSubmission(BATCH, {
        quantity: 40,
        total_weight: 25.5,
        weight_unit: 'kg',
        is_final: false,
      }),
    );
    let resumed = 0;
    const persistence = persistHarvestRecoveryRecord(b, finishB.identity).then(() => {
      resumed += 1;
    });
    pending.push(persistence);
    try {
      await waitForPause('after_prepared');
      expect(releaseA()).toBe(false);
      await flush();
      expect(resumed).toBe(0);
      expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_prepared');
      expect(store.get(KEY)).toBe(JSON.stringify(b));
      expect(releaseB()).toBe(true);
      expect(releaseB()).toBe(false);
      await persistence;
      expect(resumed).toBe(1);
      expect(api.createBatchEvent).not.toHaveBeenCalled();
    } finally {
      releaseB();
      await persistence;
      finishA();
      finishB();
    }
  });

  test.each(['completion', 'unmount', 'auth'] as const)(
    'stale A %s cleanup cannot release B checkpoint',
    async (cleanup) => {
      await runMountEffects();
      const finishA = beginHarvestRecoveryFaultAttempt();
      const oldCleanups = [...cleanups];
      beginAuthOperation();
      effects = [];
      render();
      const oldAuthEffect = effects[1];
      effects = [];
      const finishB = beginHarvestRecoveryFaultAttempt();
      await restart();
      const releaseB = actualFormRelease();
      expect(
        armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' }, finishB.identity),
      ).toBe(true);
      const b = createHarvestRecoveryRecord(
        'user-1',
        createHarvestSubmission(BATCH, {
          quantity: 40,
          total_weight: 25.5,
          weight_unit: 'kg',
          is_final: false,
        }),
      );
      let resumed = false;
      const persistence = persistHarvestRecoveryRecord(b, finishB.identity).then(() => {
        resumed = true;
      });
      pending.push(persistence);
      try {
        await waitForPause('after_prepared');
        if (cleanup === 'completion') finishA();
        else if (cleanup === 'unmount')
          oldCleanups.forEach((fn) => {
            if (typeof fn === 'function') fn();
          });
        else oldAuthEffect();
        await flush();
        expect(resumed).toBe(false);
        expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_prepared');
        expect(store.get(KEY)).toBe(JSON.stringify(b));
        expect(disarmHarvestRecoveryFault(finishA.identity)).toBe(false);
        expect(releaseB()).toBe(true);
        await persistence;
        expect(resumed).toBe(true);
        expect(api.createBatchEvent).not.toHaveBeenCalled();
      } finally {
        releaseB();
        await persistence;
        finishA();
        finishB();
      }
    },
  );

  test('retained older form handler releases its own pause after supersession without bypassing the mutation queue', async () => {
    await runMountEffects();
    const finishA = beginHarvestRecoveryFaultAttempt();
    const releaseA = actualFormRelease();
    expect(
      armHarvestRecoveryFault({ kind: 'checkpoint', point: 'after_prepared' }, finishA.identity),
    ).toBe(true);
    const a = createHarvestRecoveryRecord(
      'user-1',
      createHarvestSubmission(BATCH, {
        quantity: 40,
        total_weight: 25.5,
        weight_unit: 'kg',
        is_final: false,
      }),
    );
    const persistenceA = persistHarvestRecoveryRecord(a, finishA.identity);
    pending.push(persistenceA);
    await waitForPause('after_prepared');
    const finishB = beginHarvestRecoveryFaultAttempt();
    await restart();
    const releaseB = actualFormRelease();
    const b = createHarvestRecoveryRecord(
      'user-1',
      createHarvestSubmission('older-pause-b', {
        quantity: 20,
        total_weight: 12,
        weight_unit: 'kg',
        is_final: false,
      }),
    );
    let queuedResumed = false;
    const persistenceB = persistHarvestRecoveryRecord(b, finishB.identity).then(() => {
      queuedResumed = true;
    });
    pending.push(persistenceB);
    try {
      expect(releaseB()).toBe(false);
      finishA(); // stale completion must not release the older pause either
      expect(disarmHarvestRecoveryFault(finishA.identity)).toBe(false);
      await flush();
      expect(queuedResumed).toBe(false);
      expect(store.has(harvestRecoveryStorageKey(b.batchId)!)).toBe(false);
      expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe('after_prepared');
      expect(releaseA()).toBe(true);
      expect(releaseA()).toBe(false);
      await persistenceA;
      await persistenceB;
      expect(queuedResumed).toBe(true);
      expect(store.get(KEY)).toBe(JSON.stringify(a));
      expect(store.get(harvestRecoveryStorageKey(b.batchId)!)).toBe(JSON.stringify(b));
      expect(api.createBatchEvent).not.toHaveBeenCalled();
    } finally {
      releaseA();
      await persistenceA;
      await persistenceB;
      finishA();
      finishB();
    }
  });
});
