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
  createHarvestRecoveryRecord,
  deleteHarvestRecoveryRecord,
  harvestRecoveryStorageKey,
  harvestSubmissionFromRecord,
  HarvestRecoveryStorageError,
  loadHarvestRecovery,
  persistHarvestRecoveryRecord,
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
      ['status', JSON.stringify({ ...good, status: 'RECONCILED' }), 'corrupt'],
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
