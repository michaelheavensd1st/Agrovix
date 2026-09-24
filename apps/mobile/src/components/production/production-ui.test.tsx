import React from 'react';

jest.mock('react-native', () => {
  const React = jest.requireActual('react');

  return {
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
  };
});

import { Pressable } from 'react-native';
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
});
