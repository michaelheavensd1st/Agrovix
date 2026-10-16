const mockQaConfig = {
  extra: { appVariant: 'fdqa', fdQaFaultInjection: true },
  ios: { bundleIdentifier: 'com.agrovix.agos.fdqa' },
  android: { package: 'com.agrovix.agos.fdqa' },
};
jest.mock('expo-constants', () => ({
  get expoConfig() {
    return mockQaConfig;
  },
}));
import {
  armHarvestRecoveryFault,
  getHarvestRecoveryFaultSnapshot,
  releaseHarvestRecoveryCheckpoint,
} from './harvest-recovery-fault-injection';
const mockValues = new Map<string, string>();
const mockFaults = {
  failGet: false,
  failSet: false,
  mangleSet: false,
  failDelete: false,
  skipDelete: false,
};
let mockPlatform = 'android';
let mockDeleteGate: Promise<void> | null = null;
let mockNotifyDeleteStarted: (() => void) | null = null;

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatform;
    },
  },
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: async (key: string, value: string) => {
    if (mockFaults.failSet) throw new Error('set failed');
    mockValues.set(key, mockFaults.mangleSet ? `${value} ` : value);
  },
  getItemAsync: async (key: string) => {
    if (mockFaults.failGet) throw new Error('get failed');
    return mockValues.get(key) ?? null;
  },
  deleteItemAsync: async (key: string) => {
    mockNotifyDeleteStarted?.();
    if (mockDeleteGate) await mockDeleteGate;
    if (mockFaults.failDelete) throw new Error('delete failed');
    if (!mockFaults.skipDelete) mockValues.delete(key);
  },
}));
jest.mock('../../lib/api', () => ({ getCurrentUser: jest.fn() }));

import { getCurrentUser } from '../../lib/api';
import {
  corruptDisposableHarvestRecovery,
  createHarvestRecoveryRecord,
  deleteHarvestRecoveryRecord,
  harvestRecoveryStorageKey,
  harvestSubmissionFromRecord,
  HarvestRecoveryStorageError,
  loadHarvestRecovery,
  persistHarvestRecoveryRecord,
  harvestRecoveryPhase,
  transitionHarvestRecoveryRecord,
} from './harvest-recovery-store';
import { createHarvestSubmission } from './production-write';

const BATCH = 'batch-1';
const KEY = `agrovix.harvest_recovery.${BATCH}`;
const submit = (batchId = BATCH, quantity = 40, key?: string) =>
  createHarvestSubmission(
    batchId,
    { quantity, total_weight: 25.5, weight_unit: 'kg', is_final: false },
    key,
  );
const record = (batchId = BATCH, key?: string) =>
  createHarvestRecoveryRecord('user-1', submit(batchId, 40, key));

beforeEach(() => {
  mockValues.clear();
  Object.assign(mockFaults, {
    failGet: false,
    failSet: false,
    mangleSet: false,
    failDelete: false,
    skipDelete: false,
  });
  mockPlatform = 'android';
  mockDeleteGate = null;
  mockNotifyDeleteStarted = null;
  (getCurrentUser as jest.Mock).mockReset().mockResolvedValue({ id: 'user-1' });
});

const kindOf = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    return error instanceof HarvestRecoveryStorageError ? error.kind : 'other';
  }
  return 'none';
};

describe('harvest recovery store', () => {
  test('FC legacy PREPARED remains possibly sent and is not rewritten on load', async () => {
    const legacy = { ...record(), version: 1, status: 'PREPARED' };
    mockValues.set(KEY, JSON.stringify(legacy));
    const loaded = await loadHarvestRecovery(BATCH);
    expect(loaded.kind === 'record' && harvestRecoveryPhase(loaded.record)).toBe('OUTCOME_UNKNOWN');
    expect(mockValues.get(KEY)).toBe(JSON.stringify(legacy));
  });

  test('FC transitions preserve immutable identity and cold restart phases', async () => {
    let current = record();
    await persistHarvestRecoveryRecord(current);
    for (const status of [
      'POSTING',
      'OUTCOME_UNKNOWN',
      'POSTING',
      'ACCEPTED_UNRECONCILED',
      'RECONCILED',
    ] as const) {
      const next = await transitionHarvestRecoveryRecord(current, status, () => true);
      expect({ ...next, status: current.status, updatedAt: current.updatedAt }).toEqual(current);
      const loaded = await loadHarvestRecovery(BATCH);
      expect(loaded).toEqual({ kind: 'record', userId: 'user-1', record: next });
      current = next;
    }
    await expect(transitionHarvestRecoveryRecord(current, 'POSTING', () => true)).rejects.toThrow();
    expect(mockValues.get(KEY)).toBe(JSON.stringify(current));
  });

  test('FC failed or stale conditional transitions retain the original record', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    mockFaults.failSet = true;
    await expect(
      transitionHarvestRecoveryRecord(original, 'POSTING', () => true),
    ).rejects.toThrow();
    expect(mockValues.get(KEY)).toBe(JSON.stringify(original));
    mockFaults.failSet = false;
    await expect(
      transitionHarvestRecoveryRecord(original, 'POSTING', () => false),
    ).rejects.toThrow();
    const replacement = { ...original, userId: 'other' };
    mockValues.set(KEY, JSON.stringify(replacement));
    await expect(
      transitionHarvestRecoveryRecord(original, 'POSTING', () => true),
    ).rejects.toThrow();
    expect(mockValues.get(KEY)).toBe(JSON.stringify(replacement));
  });

  test('builds a scoped storage key and rejects unsafe batch ids', () => {
    expect(harvestRecoveryStorageKey(BATCH)).toBe(KEY);
    expect(harvestRecoveryStorageKey('a/b')).toBeNull();
    expect(harvestRecoveryStorageKey('')).toBeNull();
  });

  test('persists a verified record and loads it back identically', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    const loaded = await loadHarvestRecovery(BATCH);
    expect(loaded).toEqual({ kind: 'record', userId: 'user-1', record: original });
    if (loaded.kind !== 'record') throw new Error('expected record');
    const restored = harvestSubmissionFromRecord(loaded.record);
    expect(restored.idempotencyKey).toBe(original.idempotencyKey);
    expect(restored.performedAt).toBe(original.performedAt);
    expect(restored.payload).toEqual(original.payload);
  });

  test('loads none when nothing is stored', async () => {
    expect(await loadHarvestRecovery(BATCH)).toEqual({ kind: 'none', userId: 'user-1' });
  });

  test('reports write failure', async () => {
    mockFaults.failSet = true;
    expect(await kindOf(persistHarvestRecoveryRecord(record()))).toBe('write_failed');
  });

  test('reports read-back mismatch', async () => {
    mockFaults.mangleSet = true;
    expect(await kindOf(persistHarvestRecoveryRecord(record()))).toBe('verify_failed');
  });

  test('refuses oversized records', async () => {
    const oversized = { ...record(), payload: { ...record().payload, notes: 'é'.repeat(2500) } };
    expect(await kindOf(persistHarvestRecoveryRecord(oversized))).toBe('too_large');
    expect(mockValues.size).toBe(0);
  });

  test('refuses to overwrite an unresolved record with a different key', async () => {
    await persistHarvestRecoveryRecord(record());
    const before = mockValues.get(KEY);
    expect(await kindOf(persistHarvestRecoveryRecord(record()))).toBe('unresolved_record_exists');
    expect(mockValues.get(KEY)).toBe(before);
  });

  test('rewriting the same key is idempotent and a different key is still refused', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    await persistHarvestRecoveryRecord(original);
    const loaded = await loadHarvestRecovery(BATCH);
    expect(loaded.kind === 'record' && loaded.record.idempotencyKey).toBe(original.idempotencyKey);
  });

  test('fails closed on web and invalid batch ids', async () => {
    mockPlatform = 'web';
    expect(await loadHarvestRecovery(BATCH)).toEqual({
      kind: 'blocked',
      reason: 'storage_unavailable',
    });
    expect(await kindOf(persistHarvestRecoveryRecord(record()))).toBe('unavailable');
    mockPlatform = 'ios';
    expect(await loadHarvestRecovery('a/b')).toEqual({ kind: 'blocked', reason: 'invalid_batch' });
  });

  test('blocks when storage cannot be read or the user is unknown', async () => {
    mockFaults.failGet = true;
    expect((await loadHarvestRecovery(BATCH)).kind).toBe('blocked');
    mockFaults.failGet = false;
    (getCurrentUser as jest.Mock).mockRejectedValue(new Error('offline'));
    expect(await loadHarvestRecovery(BATCH)).toEqual({
      kind: 'blocked',
      reason: 'identity_unavailable',
    });
  });

  test('blocks corrupt, incompatible and tampered records without deleting them', async () => {
    const good = JSON.parse(JSON.stringify(record()));
    const cases: Array<[string, string, string]> = [
      ['not json', '{bad', 'corrupt'],
      ['array', '[]', 'corrupt'],
      ['version', JSON.stringify({ ...good, version: 99 }), 'incompatible'],
      ['batch', JSON.stringify({ ...good, batchId: 'other' }), 'corrupt'],
      ['status', JSON.stringify({ ...good, status: 'INVALID' }), 'corrupt'],
      [
        'harvested_at',
        JSON.stringify({
          ...good,
          payload: { ...good.payload, harvested_at: '2020-01-01T00:00:00.000Z' },
        }),
        'corrupt',
      ],
      [
        'payload order',
        JSON.stringify({
          ...good,
          payload: Object.fromEntries(Object.entries(good.payload).reverse()),
        }),
        'corrupt',
      ],
      [
        'payload value',
        JSON.stringify({ ...good, payload: { ...good.payload, quantity: -1 } }),
        'corrupt',
      ],
    ];
    for (const [, raw, reason] of cases) {
      mockValues.set(KEY, raw);
      expect(await loadHarvestRecovery(BATCH)).toEqual({ kind: 'blocked', reason });
      expect(mockValues.get(KEY)).toBe(raw);
    }
  });

  test('a different user gets foreign and no payload', async () => {
    await persistHarvestRecoveryRecord(record());
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-2' });
    const loaded = await loadHarvestRecovery(BATCH);
    expect(loaded).toEqual({ kind: 'foreign' });
    expect(mockValues.has(KEY)).toBe(true);
  });

  test('records are isolated per batch', async () => {
    await persistHarvestRecoveryRecord(record());
    expect(await loadHarvestRecovery('batch-2')).toEqual({ kind: 'none', userId: 'user-1' });
  });

  test('deletes only the matching key and verifies removal', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    expect(await kindOf(deleteHarvestRecoveryRecord(BATCH, 'different-key'))).toBe(
      'unresolved_record_exists',
    );
    expect(mockValues.has(KEY)).toBe(true);
    await deleteHarvestRecoveryRecord(BATCH, original.idempotencyKey);
    expect(mockValues.has(KEY)).toBe(false);
  });

  test('does not delete a replaced record even when it reuses the original key', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    const replacement = {
      ...record(),
      userId: 'user-2',
      payload: { ...original.payload, quantity: 60 },
    };
    mockValues.set(KEY, JSON.stringify(replacement));

    expect(
      await kindOf(deleteHarvestRecoveryRecord(BATCH, original.idempotencyKey, original)),
    ).toBe('unresolved_record_exists');
    expect(mockValues.get(KEY)).toBe(JSON.stringify(replacement));
  });

  test('a replacement write waits for an active conditional deletion', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    let releaseDelete!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    mockDeleteGate = deletionGate;
    mockNotifyDeleteStarted = announceStarted;
    const deletion = deleteHarvestRecoveryRecord(BATCH, original.idempotencyKey, original);
    await started;

    const replacement = record(BATCH, 'replacement-key');
    const persistence = persistHarvestRecoveryRecord(replacement);
    releaseDelete();
    await deletion;
    await persistence;

    expect(mockValues.get(KEY)).toBe(JSON.stringify(replacement));
  });

  test('a queued deletion rechecks ownership before touching storage', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    let allowDelete = true;
    let releaseQueue!: () => void;
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    mockDeleteGate = queueGate;
    const deletion = deleteHarvestRecoveryRecord(
      BATCH,
      original.idempotencyKey,
      original,
      () => allowDelete,
    );
    await Promise.resolve();
    allowDelete = false;
    releaseQueue();

    expect(await kindOf(deletion)).toBe('delete_failed');
    expect(mockValues.get(KEY)).toBe(JSON.stringify(original));
  });

  test('reports delete failure and unverified removal', async () => {
    const original = record();
    await persistHarvestRecoveryRecord(original);
    mockFaults.failDelete = true;
    expect(await kindOf(deleteHarvestRecoveryRecord(BATCH, original.idempotencyKey))).toBe(
      'delete_failed',
    );
    mockFaults.failDelete = false;
    mockFaults.skipDelete = true;
    expect(await kindOf(deleteHarvestRecoveryRecord(BATCH, original.idempotencyKey))).toBe(
      'delete_failed',
    );
    expect(mockValues.has(KEY)).toBe(true);
  });
});

describe('F-D integrated storage controls', () => {
  const originalFlag = process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
  beforeEach(() => {
    process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = 'true';
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION;
    else process.env.EXPO_PUBLIC_FD_QA_FAULT_INJECTION = originalFlag;
  });
  test.each(['PREPARED', 'POSTING', 'ACCEPTED_UNRECONCILED', 'RECONCILED'] as const)(
    'pauses after verified %s bytes while preserving identity and mutation lock',
    async (status) => {
      const points = {
        PREPARED: 'after_prepared',
        POSTING: 'after_posting',
        ACCEPTED_UNRECONCILED: 'after_accepted',
        RECONCILED: 'after_reconciled',
      } as const;
      const value = { ...record(), status };
      expect(armHarvestRecoveryFault({ kind: 'checkpoint', point: points[status] })).toBe(true);
      let completed = false;
      const pending = persistHarvestRecoveryRecord(value).then(() => {
        completed = true;
      });
      for (let i = 0; i < 30 && !getHarvestRecoveryFaultSnapshot().pausedAt; i++)
        await Promise.resolve();
      expect(getHarvestRecoveryFaultSnapshot().pausedAt).toBe(points[status]);
      expect(mockValues.get(KEY)).toBe(JSON.stringify(value));
      expect(completed).toBe(false);
      const deletion = deleteHarvestRecoveryRecord(BATCH, value.idempotencyKey, value);
      await Promise.resolve();
      expect(mockValues.has(KEY)).toBe(true);
      expect(releaseHarvestRecoveryCheckpoint()).toBe(true);
      await pending;
      await deletion;
      expect(mockValues.has(KEY)).toBe(false);
    },
  );
  test.each(['read', 'write', 'verification_read', 'delete'] as const)(
    'injects one %s failure and retains fail-closed semantics',
    async (operation) => {
      const value = record();
      if (operation === 'delete') await persistHarvestRecoveryRecord(value);
      expect(armHarvestRecoveryFault({ kind: 'storage_failure', operation })).toBe(true);
      const action =
        operation === 'delete'
          ? deleteHarvestRecoveryRecord(BATCH, value.idempotencyKey, value)
          : persistHarvestRecoveryRecord(value);
      expect(await kindOf(action)).not.toBe('none');
      expect(getHarvestRecoveryFaultSnapshot().armed).toBeNull();
      if (operation === 'delete' || operation === 'verification_read')
        expect(mockValues.get(KEY)).toBe(JSON.stringify(value));
      await persistHarvestRecoveryRecord(value);
      expect(mockValues.get(KEY)).toBe(JSON.stringify(value));
    },
  );
  test('corrupts only an empty disposable namespace and never replaces an occupied slot', async () => {
    const value = record();
    await persistHarvestRecoveryRecord(value);
    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(true);
    expect(await corruptDisposableHarvestRecovery()).toBe(true);
    expect(mockValues.get(KEY)).toBe(JSON.stringify(value));
    expect(mockValues.get('agrovix.fdqa.disposable.harvest_recovery')).toBe('{');
    expect(armHarvestRecoveryFault({ kind: 'corrupt_empty_record' })).toBe(true);
    expect(await corruptDisposableHarvestRecovery()).toBe(false);
  });
});
