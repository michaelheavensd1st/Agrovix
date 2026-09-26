import React from 'react';

jest.mock('react', () => {
  const React = jest.requireActual('react');
  return {
    ...React,
    useEffect: jest.fn(),
    useMemo: jest.fn(),
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
    unitName: 'Pond 09',
  }),
}));

import { Pressable } from 'react-native';
import ProductionBatchDetailScreen from '../../../app/production/batches/[batchId]';
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
      { value: { initial_stocked_quantity: 100, survival_rate: 0.8 } },
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
    } finally {
      jest.restoreAllMocks();
    }
  });
});
