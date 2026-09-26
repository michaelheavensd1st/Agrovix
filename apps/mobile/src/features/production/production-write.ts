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

export interface WaterQualityPayload extends Record<string, unknown> {
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

export interface ProductionSubmission<TPayload extends Record<string, unknown>> {
  batchId: string;
  payload: TPayload;
  idempotencyKey: string;
  createdAt: string;
  context: WaterQualityWriteContext;
}

export type WaterQualitySubmission = ProductionSubmission<WaterQualityPayload>;

export type WaterQualityWriteOutcome =
  'accepted' | 'rejected' | 'outcome_unknown' | 'reconciliation_failed' | 'write_failed';

export interface ProductionWriteResult<TPayload extends Record<string, unknown>> {
  outcome: WaterQualityWriteOutcome;
  submission: ProductionSubmission<TPayload>;
  retrySubmission: ProductionSubmission<TPayload> | null;
  posted: boolean;
  reconciled: boolean;
  reconciliation?: WaterQualityReconciliationData;
  response?: { status?: number; detail?: unknown } | null;
  error?: Error | null;
}

export type WaterQualityWriteResult = ProductionWriteResult<WaterQualityPayload>;

export interface WaterQualityReconciliationData {
  batch: Record<string, unknown>;
  projection: Record<string, unknown>;
  events: Record<string, unknown>[];
}

export type FeedingUnit = 'kg' | 'g';
export type FeedingMethod = 'broadcast' | 'tray' | 'automatic' | 'hand';

export interface FeedingInput {
  feed_item_ref?: string | null;
  feed_description?: string | null;
  quantity: number | string | null;
  unit?: FeedingUnit | string | null;
  feeding_method?: FeedingMethod | string | null;
  feeding_round?: number | string | null;
}

export interface FeedingPayload extends Record<string, unknown> {
  feed_item_ref?: string;
  feed_description?: string;
  quantity: number;
  unit: FeedingUnit;
  feeding_method: FeedingMethod;
  feeding_round?: number;
}

export type FeedingSubmission = ProductionSubmission<FeedingPayload>;
export type FeedingWriteResult = ProductionWriteResult<FeedingPayload>;

const WATER_QUALITY_FIELDS: readonly WaterQualityMeasurementKey[] = [
  'temperature',
  'ph',
  'dissolved_oxygen',
  'ammonia',
  'nitrite',
  'turbidity',
];

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

function readRequiredText(value: string | null | undefined, field: string, maximum: number) {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum)
    throw new Error(`${field} must be at most ${maximum} characters.`);
  return normalized;
}

export function buildFeedingPayload(values: FeedingInput): FeedingPayload {
  const feedItemRef = readRequiredText(values.feed_item_ref, 'feed_item_ref', 128);
  const feedDescription = readRequiredText(values.feed_description, 'feed_description', 255);
  if (!feedItemRef && !feedDescription) {
    throw new Error('A feed item reference or description is required before submit.');
  }

  const quantity = toFiniteNumber(values.quantity);
  if (quantity === null || quantity <= 0) throw new Error('quantity must be greater than zero.');

  const unit = values.unit ?? 'kg';
  if (unit !== 'kg' && unit !== 'g') throw new Error('unit must be kg or g.');
  const feedingMethod = values.feeding_method ?? 'broadcast';
  if (!['broadcast', 'tray', 'automatic', 'hand'].includes(feedingMethod)) {
    throw new Error('feeding_method is invalid.');
  }

  let feedingRound: number | undefined;
  if (
    values.feeding_round !== null &&
    values.feeding_round !== undefined &&
    values.feeding_round !== ''
  ) {
    const parsed = toFiniteNumber(values.feeding_round);
    if (parsed === null || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error('feeding_round must be an integer greater than or equal to one.');
    }
    feedingRound = parsed;
  }

  return {
    ...(feedItemRef ? { feed_item_ref: feedItemRef } : {}),
    ...(feedDescription ? { feed_description: feedDescription } : {}),
    quantity,
    unit,
    feeding_method: feedingMethod as FeedingMethod,
    ...(feedingRound === undefined ? {} : { feeding_round: feedingRound }),
  };
}

export function createFeedingDraftSignature(batchId: string, values: FeedingInput): string {
  return JSON.stringify({
    batchId,
    values: {
      feed_item_ref: values.feed_item_ref?.trim() ?? '',
      feed_description: values.feed_description?.trim() ?? '',
      quantity: values.quantity ?? '',
      unit: values.unit ?? 'kg',
      feeding_method: values.feeding_method ?? 'broadcast',
      feeding_round: values.feeding_round ?? '',
    },
  });
}

export function createFeedingSubmission(
  batchId: string,
  values: FeedingInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): FeedingSubmission {
  const payload = buildFeedingPayload(values);
  return {
    batchId,
    payload,
    idempotencyKey: idempotencyKey ?? makeOpaqueId('feeding'),
    createdAt: new Date().toISOString(),
    context: { ...(context ?? {}), batchId },
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

type ProductionEventType = 'WATER_QUALITY' | 'FEEDING';
const PRODUCTION_WRITE_LEDGER = new Map<string, ProductionWriteResult<any>>();
const PRODUCTION_WRITE_IN_FLIGHT = new Map<
  string,
  { submission: ProductionSubmission<any>; promise: Promise<ProductionWriteResult<any>> }
>();

function isSameProductionSubmission(
  left: ProductionSubmission<any>,
  right: ProductionSubmission<any>,
): boolean {
  return (
    left.batchId === right.batchId &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

function classifyWriteFailure<TPayload extends Record<string, unknown>>(
  error: unknown,
  submission: ProductionSubmission<TPayload>,
): ProductionWriteResult<TPayload> {
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

async function performProductionWrite<TPayload extends Record<string, unknown>>(
  {
    context,
    eventType,
    post,
    readAll,
  }: {
    context: WaterQualityWriteContext;
    eventType: ProductionEventType;
    post: (
      batchId: string,
      eventType: ProductionEventType,
      data: Record<string, unknown>,
      key: string,
    ) => Promise<Record<string, unknown>>;
    readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
  },
  submission: ProductionSubmission<TPayload>,
): Promise<ProductionWriteResult<TPayload>> {
  const prior = PRODUCTION_WRITE_LEDGER.get(submission.idempotencyKey);
  if (prior && prior.posted && prior.outcome !== 'rejected' && prior.outcome !== 'write_failed') {
    try {
      const reconciliation = await readAll(context.batchId);
      const replay: ProductionWriteResult<TPayload> = {
        ...prior,
        outcome: 'accepted',
        retrySubmission: null,
        posted: true,
        reconciled: true,
        reconciliation,
        response: prior.response ?? null,
        error: null,
      } satisfies WaterQualityWriteResult;
      PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, replay);
      return replay;
    } catch (error) {
      const replayFailed: ProductionWriteResult<TPayload> = {
        ...prior,
        outcome: 'reconciliation_failed',
        submission,
        retrySubmission: submission,
        posted: true,
        reconciled: false,
        response: prior.response ?? null,
        error: error instanceof Error ? error : new Error('Reconciliation failed.'),
      };
      PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, replayFailed);
      return replayFailed;
    }
  }

  try {
    const writeResponse = await post(
      context.batchId,
      eventType,
      submission.payload,
      submission.idempotencyKey,
    );
    const status = typeof writeResponse.status === 'number' ? writeResponse.status : undefined;
    const response = {
      ...(status === undefined ? {} : { status }),
      ...('detail' in writeResponse ? { detail: writeResponse.detail } : {}),
    };

    if (status === 409 || status === 422) {
      const result: ProductionWriteResult<TPayload> = {
        outcome: 'rejected',
        submission,
        retrySubmission: null,
        posted: false,
        reconciled: false,
        response,
      };
      PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    }

    try {
      const reconciliation = await readAll(context.batchId);
      const result: ProductionWriteResult<TPayload> = {
        outcome: 'accepted',
        submission,
        retrySubmission: null,
        posted: true,
        reconciled: true,
        reconciliation,
        response,
      };
      PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    } catch (error) {
      const result: ProductionWriteResult<TPayload> = {
        outcome: 'reconciliation_failed',
        submission,
        retrySubmission: submission,
        posted: true,
        reconciled: false,
        response,
        error: error instanceof Error ? error : new Error('Reconciliation failed.'),
      };
      PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, result);
      return result;
    }
  } catch (error) {
    const result = classifyWriteFailure(error, submission);
    PRODUCTION_WRITE_LEDGER.set(submission.idempotencyKey, result);
    return result;
  }
}

export function reconcileProductionWrite<TPayload extends Record<string, unknown>>({
  context,
  eventType,
  submission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  eventType: ProductionEventType;
  submission: ProductionSubmission<TPayload>;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<ProductionWriteResult<TPayload>> {
  const pending = PRODUCTION_WRITE_IN_FLIGHT.get(submission.idempotencyKey);

  if (pending) {
    if (isSameProductionSubmission(pending.submission, submission)) {
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
    performProductionWrite({ context, eventType, post, readAll }, submission),
  );
  const reservation = { submission, promise };
  PRODUCTION_WRITE_IN_FLIGHT.set(submission.idempotencyKey, reservation);

  const releaseReservation = () => {
    if (PRODUCTION_WRITE_IN_FLIGHT.get(submission.idempotencyKey) === reservation) {
      PRODUCTION_WRITE_IN_FLIGHT.delete(submission.idempotencyKey);
    }
  };
  void promise.then(releaseReservation, releaseReservation);

  return promise;
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
    eventType: ProductionEventType,
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
  return reconcileProductionWrite({
    context,
    eventType: 'WATER_QUALITY',
    submission,
    post,
    readAll,
  });
}

export function reconcileFeedingWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: FeedingInput;
  idempotencyKey: string;
  submission?: FeedingSubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<FeedingWriteResult> {
  const normalizedPayload = buildFeedingPayload(payload);
  const submission =
    preservedSubmission ??
    createFeedingSubmission(context.batchId, payload, idempotencyKey, context);
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved feeding submission does not match the current intent.');
  }
  return reconcileProductionWrite({
    context,
    eventType: 'FEEDING',
    submission,
    post,
    readAll,
  });
}
