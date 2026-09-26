import { ApiFailure } from '../../lib/api';

export const WATER_QUALITY_CANONICAL_UNITS = {
  temperature: 'C',
  dissolved_oxygen: 'mg_l',
  ammonia: 'mg_l',
  nitrite: 'mg_l',
  turbidity: 'NTU',
} as const;

export const WATER_QUALITY_BOUNDS = {
  temperature: [-5, 60],
  ph: [0, 14],
  dissolved_oxygen: [0, 30],
  ammonia: [0, 100],
  nitrite: [0, 100],
  turbidity: [0, 1000],
} as const;

export type WaterQualityMeasurementKey =
  'temperature' | 'ph' | 'dissolved_oxygen' | 'ammonia' | 'nitrite' | 'turbidity';

export type WaterQualityMeasurementInput = Partial<
  Record<WaterQualityMeasurementKey, number | string | null>
> & {
  measured_at?: string | null;
};

export interface WaterQualityWriteContext {
  batchId: string;
  batchName?: string;
  farmName?: string;
  unitName?: string;
}

export interface WaterQualityPayload {
  temperature?: number;
  ph?: number;
  dissolved_oxygen?: number;
  ammonia?: number;
  nitrite?: number;
  turbidity?: number;
  measurement_units: {
    temperature: string;
    dissolved_oxygen: string;
    ammonia: string;
    nitrite: string;
    turbidity: string;
  };
  measured_at: string;
}

export interface WaterQualitySubmission {
  batchId: string;
  payload: WaterQualityPayload;
  idempotencyKey: string;
  createdAt: string;
  context: WaterQualityWriteContext;
}

export type WaterQualityWriteOutcome =
  'accepted' | 'rejected' | 'outcome_unknown' | 'reconciliation_failed' | 'write_failed';

export interface WaterQualityWriteResult {
  outcome: WaterQualityWriteOutcome;
  submission: WaterQualitySubmission;
  retrySubmission: WaterQualitySubmission | null;
  posted: boolean;
  reconciled: boolean;
  reconciliation?: WaterQualityReconciliationData;
  response?: { status?: number; detail?: unknown } | null;
  error?: Error | null;
}

export interface WaterQualityReconciliationData {
  batch: Record<string, unknown>;
  projection: Record<string, unknown>;
  events: Record<string, unknown>[];
}

const WATER_QUALITY_FIELDS: readonly WaterQualityMeasurementKey[] = [
  'temperature',
  'ph',
  'dissolved_oxygen',
  'ammonia',
  'nitrite',
  'turbidity',
];

const WATER_QUALITY_WRITE_LEDGER = new Map<string, WaterQualityWriteResult>();
const WATER_QUALITY_WRITE_IN_FLIGHT = new Map<
  string,
  { submission: WaterQualitySubmission; promise: Promise<WaterQualityWriteResult> }
>();

function makeOpaqueId(prefix: string): string {
  const cryptoObject = (
    globalThis as typeof globalThis & {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return `${prefix}:${cryptoObject.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return `${prefix}:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function hasActualWaterQualityMeasurement(
  values: Partial<Record<WaterQualityMeasurementKey, number | string | null | undefined>>,
): boolean {
  return WATER_QUALITY_FIELDS.some((field) => toFiniteNumber(values[field]) !== null);
}

function normalizeMeasuredAt(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed}:00Z`;

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(withTimezone)
  ) {
    return null;
  }

  const parsed = new Date(withTimezone);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function enforceMeasurementBound(field: WaterQualityMeasurementKey, value: number): number {
  const [minimum, maximum] = WATER_QUALITY_BOUNDS[field];
  if (value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function createWaterQualityDraftSignature(
  batchId: string,
  values: WaterQualityMeasurementInput,
): string {
  return JSON.stringify({
    batchId,
    values: {
      ...values,
      measured_at: normalizeMeasuredAt(values.measured_at) ?? null,
    },
  });
}

export function buildWaterQualityPayload(
  values: WaterQualityMeasurementInput,
  context: Pick<WaterQualityWriteContext, 'batchId'>,
): WaterQualityPayload {
  const measuredAt = normalizeMeasuredAt(values.measured_at);
  if (!measuredAt) {
    throw new Error('A measured_at timestamp is required for a water-quality record.');
  }

  const payload: Partial<WaterQualityPayload> = {
    measurement_units: {
      temperature: WATER_QUALITY_CANONICAL_UNITS.temperature,
      dissolved_oxygen: WATER_QUALITY_CANONICAL_UNITS.dissolved_oxygen,
      ammonia: WATER_QUALITY_CANONICAL_UNITS.ammonia,
      nitrite: WATER_QUALITY_CANONICAL_UNITS.nitrite,
      turbidity: WATER_QUALITY_CANONICAL_UNITS.turbidity,
    },
    measured_at: measuredAt,
  };

  for (const field of WATER_QUALITY_FIELDS) {
    const numericValue = toFiniteNumber(values[field]);
    if (numericValue !== null) {
      payload[field] = enforceMeasurementBound(field, numericValue);
    }
  }

  if (!hasActualWaterQualityMeasurement(values)) {
    throw new Error('At least one actual water-quality measurement is required before submit.');
  }

  if (!context.batchId || context.batchId.trim().length === 0) {
    throw new Error('A batch target is required for a water-quality submission.');
  }

  return payload as WaterQualityPayload;
}

export function createWaterQualityIdempotencyKey(
  _batchId: string,
  _payload: WaterQualityPayload,
): string {
  return makeOpaqueId('water-quality');
}

export function createWaterQualitySubmission(
  batchId: string,
  values: WaterQualityMeasurementInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): WaterQualitySubmission {
  const normalizedContext: WaterQualityWriteContext = {
    ...(context ?? {}),
    batchId,
  };
  const payload = buildWaterQualityPayload(values, { batchId });
  const key = idempotencyKey ?? createWaterQualityIdempotencyKey(batchId, payload);

  return {
    batchId,
    payload,
    idempotencyKey: key,
    createdAt: new Date().toISOString(),
    context: normalizedContext,
  };
}

export function isSameLogicalSubmission(
  left: WaterQualitySubmission,
  right: WaterQualitySubmission,
): boolean {
  return (
    left.batchId === right.batchId &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

export function resolveWriteOutcome({
  submission,
  status,
  accepted,
  response,
}: {
  submission: WaterQualitySubmission;
  status?: 'network' | 'http' | 'application' | 'unknown' | 'accepted';
  accepted?: boolean;
  response?: { status?: number; detail?: unknown } | null;
}): WaterQualityWriteResult {
  const statusCode = typeof response?.status === 'number' ? response.status : undefined;

  if (status === 'network' || status === 'unknown' || (!accepted && statusCode === undefined)) {
    return {
      outcome: 'outcome_unknown',
      submission,
      retrySubmission: submission,
      posted: false,
      reconciled: false,
      response: response ?? null,
    };
  }

  if (accepted === true || status === 'accepted' || statusCode === 200 || statusCode === 201) {
    return {
      outcome: 'accepted',
      submission,
      retrySubmission: null,
      posted: true,
      reconciled: false,
      response: response ?? null,
    };
  }

  if (statusCode === 409 || statusCode === 422) {
    return {
      outcome: 'rejected',
      submission,
      retrySubmission: null,
      posted: false,
      reconciled: false,
      response: response ?? null,
    };
  }

  return {
    outcome: 'write_failed',
    submission,
    retrySubmission: null,
    posted: false,
    reconciled: false,
    response: response ?? null,
  };
}

function classifyWriteFailure(
  error: unknown,
  submission: WaterQualitySubmission,
): WaterQualityWriteResult {
  if (!(error instanceof ApiFailure)) {
    return {
      outcome: 'outcome_unknown',
      submission,
      retrySubmission: submission,
      posted: false,
      reconciled: false,
      response: null,
      error: error instanceof Error ? error : new Error('Write outcome is uncertain.'),
    };
  }

  const response = {
    status: error.status,
    detail: error.safeMessage,
  };

  if (error.phase === 'network') {
    return {
      outcome: 'outcome_unknown',
      submission,
      retrySubmission: submission,
      posted: false,
      reconciled: false,
      response,
      error,
    };
  }

  if (error.phase === 'http' && (error.status === 409 || error.status === 422)) {
    return {
      outcome: 'rejected',
      submission,
      retrySubmission: null,
      posted: false,
      reconciled: false,
      response,
      error,
    };
  }

  if (error.phase === 'http' || error.phase === 'application') {
    return {
      outcome: 'write_failed',
      submission,
      retrySubmission: null,
      posted: false,
      reconciled: false,
      response,
      error,
    };
  }

  return {
    outcome: 'outcome_unknown',
    submission,
    retrySubmission: submission,
    posted: false,
    reconciled: false,
    response,
    error,
  };
}

async function performWaterQualityWrite(
  {
    context,
    post,
    readAll,
  }: {
    context: WaterQualityWriteContext;
    post: (
      batchId: string,
      eventType: 'WATER_QUALITY',
      data: Record<string, unknown>,
      key: string,
    ) => Promise<Record<string, unknown>>;
    readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
  },
  submission: WaterQualitySubmission,
): Promise<WaterQualityWriteResult> {
  const prior = WATER_QUALITY_WRITE_LEDGER.get(submission.idempotencyKey);
  if (prior && prior.posted && prior.outcome !== 'rejected' && prior.outcome !== 'write_failed') {
    try {
      const reconciliation = await readAll(context.batchId);
      const replay = {
        ...prior,
        outcome: 'accepted',
        retrySubmission: null,
        posted: true,
        reconciled: true,
        reconciliation,
        response: prior.response ?? null,
        error: null,
      } satisfies WaterQualityWriteResult;
      WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, replay);
      return replay;
    } catch (error) {
      const replayFailed: WaterQualityWriteResult = {
        outcome: 'reconciliation_failed',
        submission: prior.submission,
        retrySubmission: prior.submission,
        posted: true,
        reconciled: false,
        response: prior.response ?? null,
        error: error instanceof Error ? error : new Error('Reconciliation failed.'),
      };
      WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, replayFailed);
      return replayFailed;
    }
  }

  try {
    const writeResponse = await post(
      context.batchId,
      'WATER_QUALITY',
      submission.payload as unknown as Record<string, unknown>,
      submission.idempotencyKey,
    );
    const status = typeof writeResponse.status === 'number' ? writeResponse.status : undefined;
    const response = {
      ...(status === undefined ? {} : { status }),
      ...('detail' in writeResponse ? { detail: writeResponse.detail } : {}),
    };

    if (status === 409 || status === 422) {
      const result: WaterQualityWriteResult = {
        outcome: 'rejected',
        submission,
        retrySubmission: null,
        posted: false,
        reconciled: false,
        response,
      };
      WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    }

    try {
      const reconciliation = await readAll(context.batchId);
      const result: WaterQualityWriteResult = {
        outcome: 'accepted',
        submission,
        retrySubmission: null,
        posted: true,
        reconciled: true,
        reconciliation,
        response,
      };
      WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    } catch (error) {
      const result: WaterQualityWriteResult = {
        outcome: 'reconciliation_failed',
        submission,
        retrySubmission: submission,
        posted: true,
        reconciled: false,
        response,
        error: error instanceof Error ? error : new Error('Reconciliation failed.'),
      };
      WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    }
  } catch (error) {
    const result = classifyWriteFailure(error, submission);
    WATER_QUALITY_WRITE_LEDGER.set(submission.idempotencyKey, result);
    return result;
  }
}

export function reconcileWaterQualityWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: WaterQualityMeasurementInput;
  idempotencyKey: string;
  submission?: WaterQualitySubmission;
  post: (
    batchId: string,
    eventType: 'WATER_QUALITY',
    data: Record<string, unknown>,
    key: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<WaterQualityWriteResult> {
  const normalizedPayload = buildWaterQualityPayload(payload, { batchId: context.batchId });
  const submission =
    preservedSubmission ??
    createWaterQualitySubmission(context.batchId, payload, idempotencyKey, context);

  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved water-quality submission does not match the current intent.');
  }
  const pending = WATER_QUALITY_WRITE_IN_FLIGHT.get(submission.idempotencyKey);

  if (pending) {
    if (isSameLogicalSubmission(pending.submission, submission)) {
      return pending.promise;
    }

    return Promise.resolve({
      outcome: 'write_failed',
      submission,
      retrySubmission: null,
      posted: false,
      reconciled: false,
      response: null,
      error: new Error('The idempotency key is already in flight for a different submission.'),
    });
  }

  const promise = Promise.resolve().then(() =>
    performWaterQualityWrite({ context, post, readAll }, submission),
  );
  const reservation = { submission, promise };
  WATER_QUALITY_WRITE_IN_FLIGHT.set(submission.idempotencyKey, reservation);

  const releaseReservation = () => {
    if (WATER_QUALITY_WRITE_IN_FLIGHT.get(submission.idempotencyKey) === reservation) {
      WATER_QUALITY_WRITE_IN_FLIGHT.delete(submission.idempotencyKey);
    }
  };
  void promise.then(releaseReservation, releaseReservation);

  return promise;
}
