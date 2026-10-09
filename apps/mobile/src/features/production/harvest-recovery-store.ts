/**
 * Durable recovery ledger for unresolved HARVEST submissions.
 *
 * One versioned SecureStore record per batch preserves the immutable
 * idempotency key, original timestamp and validated payload across process
 * termination. Every failure mode is fail-closed: unavailable, corrupt,
 * incompatible or foreign records block new HARVEST submissions and are never
 * deleted silently.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getCurrentUser } from '../../lib/api';
import {
  buildHarvestPayload,
  type HarvestPayload,
  type HarvestSubmission,
} from './production-write';

export const HARVEST_RECOVERY_VERSION = 1;
export const HARVEST_RECOVERY_MAX_BYTES = 2048;

export type HarvestRecoveryStatus =
  'PREPARED' | 'POSTING' | 'OUTCOME_UNKNOWN' | 'ACCEPTED_UNRECONCILED';

const UNRESOLVED_STATUSES: readonly HarvestRecoveryStatus[] = [
  'PREPARED',
  'POSTING',
  'OUTCOME_UNKNOWN',
  'ACCEPTED_UNRECONCILED',
];

export interface HarvestRecoveryRecord {
  version: typeof HARVEST_RECOVERY_VERSION;
  userId: string;
  batchId: string;
  idempotencyKey: string;
  performedAt: string;
  payload: HarvestPayload;
  status: HarvestRecoveryStatus;
  createdAt: string;
  updatedAt: string;
}

export type HarvestRecoveryBlockReason =
  'storage_unavailable' | 'identity_unavailable' | 'corrupt' | 'incompatible' | 'invalid_batch';

export type HarvestRecoveryLoad =
  | { kind: 'none'; userId: string }
  | { kind: 'record'; userId: string; record: HarvestRecoveryRecord }
  | { kind: 'foreign' }
  | { kind: 'blocked'; reason: HarvestRecoveryBlockReason };

export type HarvestRecoveryStorageFailure =
  | 'unavailable'
  | 'write_failed'
  | 'verify_failed'
  | 'too_large'
  | 'unresolved_record_exists'
  | 'delete_failed';

export class HarvestRecoveryStorageError extends Error {
  constructor(
    public readonly kind: HarvestRecoveryStorageFailure,
    message: string,
  ) {
    super(message);
    this.name = 'HarvestRecoveryStorageError';
  }
}

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Serialize mutations so a conditional delete cannot race a replacement write.
let recoveryMutationQueue: Promise<void> = Promise.resolve();

function serializeRecoveryMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = recoveryMutationQueue.then(mutation, mutation);
  recoveryMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function harvestRecoveryStorageKey(batchId: string): string | null {
  return KEY_PATTERN.test(batchId) ? `agrovix.harvest_recovery.${batchId}` : null;
}

export function isHarvestRecoveryStorageSupported(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function storageKeyOrThrow(batchId: string): string {
  if (!isHarvestRecoveryStorageSupported()) {
    throw new HarvestRecoveryStorageError(
      'unavailable',
      'Durable recovery storage is not available on this platform.',
    );
  }
  const key = harvestRecoveryStorageKey(batchId);
  if (!key) {
    throw new HarvestRecoveryStorageError('unavailable', 'The batch identity cannot be secured.');
  }
  return key;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

type ParsedRecord =
  | { kind: 'ok'; record: HarvestRecoveryRecord }
  | { kind: 'foreign' }
  | { kind: 'blocked'; reason: 'corrupt' | 'incompatible' };

function parseRecord(raw: string, batchId: string, userId: string): ParsedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'blocked', reason: 'corrupt' };
  }
  if (!isRecordObject(parsed)) return { kind: 'blocked', reason: 'corrupt' };
  if (parsed.version !== HARVEST_RECOVERY_VERSION) {
    return { kind: 'blocked', reason: 'incompatible' };
  }
  if (!isNonEmptyString(parsed.userId)) return { kind: 'blocked', reason: 'corrupt' };
  if (parsed.userId !== userId) return { kind: 'foreign' };

  const { payload } = parsed;
  if (
    parsed.batchId !== batchId ||
    !isNonEmptyString(parsed.idempotencyKey) ||
    !isCanonicalTimestamp(parsed.performedAt) ||
    !isCanonicalTimestamp(parsed.createdAt) ||
    !isCanonicalTimestamp(parsed.updatedAt) ||
    !UNRESOLVED_STATUSES.includes(parsed.status as HarvestRecoveryStatus) ||
    !isRecordObject(payload) ||
    payload.harvested_at !== parsed.performedAt
  ) {
    return { kind: 'blocked', reason: 'corrupt' };
  }

  try {
    const canonical = buildHarvestPayload(
      {
        quantity: payload.quantity as number,
        total_weight: payload.total_weight as number,
        weight_unit: payload.weight_unit as string,
        average_weight: (payload.average_weight as number | undefined) ?? null,
        notes: (payload.notes as string | undefined) ?? null,
        is_final: payload.is_final === true,
      },
      parsed.performedAt,
    );
    if (JSON.stringify(canonical) !== JSON.stringify(payload)) {
      return { kind: 'blocked', reason: 'corrupt' };
    }
  } catch {
    return { kind: 'blocked', reason: 'corrupt' };
  }

  return {
    kind: 'ok',
    record: {
      version: HARVEST_RECOVERY_VERSION,
      userId: parsed.userId,
      batchId,
      idempotencyKey: parsed.idempotencyKey,
      performedAt: parsed.performedAt,
      payload: payload as HarvestPayload,
      status: parsed.status as HarvestRecoveryStatus,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    },
  };
}

export async function resolveHarvestRecoveryUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (!isNonEmptyString(user?.id)) {
    throw new Error('The authenticated user could not be determined.');
  }
  return user.id;
}

export async function loadHarvestRecovery(batchId: string): Promise<HarvestRecoveryLoad> {
  if (!isHarvestRecoveryStorageSupported()) {
    return { kind: 'blocked', reason: 'storage_unavailable' };
  }
  const key = harvestRecoveryStorageKey(batchId);
  if (!key) return { kind: 'blocked', reason: 'invalid_batch' };

  let userId: string;
  try {
    userId = await resolveHarvestRecoveryUserId();
  } catch {
    return { kind: 'blocked', reason: 'identity_unavailable' };
  }

  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(key);
  } catch {
    return { kind: 'blocked', reason: 'storage_unavailable' };
  }
  if (raw === null || raw === undefined) return { kind: 'none', userId };

  const parsed = parseRecord(raw, batchId, userId);
  if (parsed.kind === 'ok') return { kind: 'record', userId, record: parsed.record };
  if (parsed.kind === 'foreign') return { kind: 'foreign' };
  return { kind: 'blocked', reason: parsed.reason };
}

export function createHarvestRecoveryRecord(
  userId: string,
  submission: HarvestSubmission,
  status: HarvestRecoveryStatus = 'PREPARED',
  now: Date = new Date(),
): HarvestRecoveryRecord {
  const timestamp = now.toISOString();
  return {
    version: HARVEST_RECOVERY_VERSION,
    userId,
    batchId: submission.batchId,
    idempotencyKey: submission.idempotencyKey,
    performedAt: submission.performedAt ?? submission.payload.harvested_at,
    payload: submission.payload,
    status,
    createdAt: submission.createdAt,
    updatedAt: timestamp,
  };
}

export function harvestSubmissionFromRecord(record: HarvestRecoveryRecord): HarvestSubmission {
  return {
    batchId: record.batchId,
    payload: record.payload,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
    performedAt: record.performedAt,
    context: { batchId: record.batchId },
  };
}

async function readRaw(key: string): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(key)) ?? null;
  } catch {
    throw new HarvestRecoveryStorageError(
      'unavailable',
      'The recovery record could not be read from secure storage.',
    );
  }
}

function existingKeyOf(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecordObject(parsed) && isNonEmptyString(parsed.idempotencyKey)
      ? parsed.idempotencyKey
      : null;
  } catch {
    return null;
  }
}

/**
 * Persists the record and reads it back. Resolves only when the stored bytes
 * are identical, so the caller may then POST. Never overwrites a record that
 * belongs to a different idempotency key.
 */
async function persistHarvestRecoveryRecordUnlocked(record: HarvestRecoveryRecord): Promise<void> {
  const key = storageKeyOrThrow(record.batchId);
  const serialized = JSON.stringify(record);
  if (utf8Length(serialized) > HARVEST_RECOVERY_MAX_BYTES) {
    throw new HarvestRecoveryStorageError(
      'too_large',
      'The harvest record is too large to secure for recovery. Shorten the notes.',
    );
  }
  const existing = await readRaw(key);
  if (existing !== null && existingKeyOf(existing) !== record.idempotencyKey) {
    throw new HarvestRecoveryStorageError(
      'unresolved_record_exists',
      'An unresolved harvest recovery record already exists for this batch.',
    );
  }
  try {
    await SecureStore.setItemAsync(key, serialized, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    throw new HarvestRecoveryStorageError(
      'write_failed',
      'The recovery record could not be saved to secure storage.',
    );
  }
  const readBack = await readRaw(key);
  if (readBack !== serialized) {
    throw new HarvestRecoveryStorageError(
      'verify_failed',
      'The saved recovery record could not be verified.',
    );
  }
}

export function persistHarvestRecoveryRecord(record: HarvestRecoveryRecord): Promise<void> {
  return serializeRecoveryMutation(() => persistHarvestRecoveryRecordUnlocked(record));
}

/**
 * Deletes the batch's record only when it still carries the given idempotency
 * key, and confirms it is gone. A different key's record is never touched.
 */
async function deleteHarvestRecoveryRecordUnlocked(
  batchId: string,
  idempotencyKey: string,
  expectedRecord?: HarvestRecoveryRecord,
  canDelete: () => boolean = () => true,
): Promise<void> {
  const key = storageKeyOrThrow(batchId);
  if (!canDelete()) {
    throw new HarvestRecoveryStorageError(
      'delete_failed',
      'The recovery owner is no longer active.',
    );
  }
  const existing = await readRaw(key);
  if (existing === null) return;
  if (existingKeyOf(existing) !== idempotencyKey) {
    throw new HarvestRecoveryStorageError(
      'unresolved_record_exists',
      'The stored recovery record belongs to a different submission and was not deleted.',
    );
  }
  if (expectedRecord && existing !== JSON.stringify(expectedRecord)) {
    throw new HarvestRecoveryStorageError(
      'unresolved_record_exists',
      'The stored recovery record no longer matches the submission being reconciled.',
    );
  }
  if (!canDelete()) {
    throw new HarvestRecoveryStorageError(
      'delete_failed',
      'The recovery owner is no longer active.',
    );
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    throw new HarvestRecoveryStorageError(
      'delete_failed',
      'The recovery record could not be deleted from secure storage.',
    );
  }
  if ((await readRaw(key)) !== null) {
    throw new HarvestRecoveryStorageError(
      'delete_failed',
      'The recovery record is still present after deletion.',
    );
  }
}

export function deleteHarvestRecoveryRecord(
  batchId: string,
  idempotencyKey: string,
  expectedRecord?: HarvestRecoveryRecord,
  canDelete: () => boolean = () => true,
): Promise<void> {
  return serializeRecoveryMutation(() =>
    deleteHarvestRecoveryRecordUnlocked(batchId, idempotencyKey, expectedRecord, canDelete),
  );
}
