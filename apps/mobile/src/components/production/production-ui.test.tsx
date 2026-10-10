import React from 'react';

jest.mock('react', () => {
  const React = jest.requireActual('react');
  return {
    ...React,
    useCallback: jest.fn((callback: unknown) => callback),
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
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    batchId: 'batch-refresh',
    batchName: 'B-009',
    farmName: 'North Farm',
    siteName: 'Site 09',
    unitName: 'Pond 09',
  }),
}));

import { Pressable } from 'react-native';
import ProductionBatchDetailScreen from '../../../app/production/batches/[batchId]';
import { FeedingForm } from './feeding-form';
import { HarvestForm } from './harvest-form';
import { MortalityForm } from './mortality-form';
import { SamplingForm } from './sampling-form';
import { StockingForm } from './stocking-form';
import { TransferForm } from './transfer-form';
import {
  clearTransferWriteRecovery,
  getTransferWriteRecovery,
  reconcileTransferWrite,
  reconcileHarvestWrite,
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
