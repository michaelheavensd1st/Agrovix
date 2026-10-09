import { ApiError, ApiFailure } from '../../lib/api';

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
  siteName?: string;
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
  performedAt?: string;
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
  response?: { status?: number; detail?: unknown; code?: string } | null;
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

export type MortalityDisposalMethod = 'burial' | 'incineration' | 'compost' | 'rendering' | 'other';

export interface MortalityEvidenceInput {
  photos?: string[] | null;
  lab_report_ref?: string | null;
  veterinarian_id?: string | null;
  notes?: string | null;
}

export interface MortalityInput {
  count: number | string | null;
  observed_at: string | null;
  suspected_cause?: string | null;
  disposal_method?: MortalityDisposalMethod | string | null;
  evidence?: MortalityEvidenceInput | null;
}

export interface MortalityPayload extends Record<string, unknown> {
  count: number;
  observed_at: string;
  suspected_cause?: string;
  disposal_method?: MortalityDisposalMethod;
  evidence?: {
    photos?: string[];
    lab_report_ref?: string;
    veterinarian_id?: string;
    notes?: string;
  };
}

export interface StockingInput {
  species_code: string | null;
  quantity: number | string | null;
  average_weight: number | string | null;
  weight_unit?: 'g' | 'kg' | string | null;
  stocked_at: string | null;
  source?: string | null;
  notes?: string | null;
}

export interface StockingPayload extends Record<string, unknown> {
  species_code: string;
  quantity: number;
  average_weight: number;
  weight_unit: 'g' | 'kg';
  stocked_at: string;
  source?: string;
  notes?: string;
}

export type SamplingWeightUnit = 'g' | 'kg';

export interface SamplingInput {
  sample_size: number | string | null;
  average_weight: number | string | null;
  minimum_weight?: number | string | null;
  maximum_weight?: number | string | null;
  weight_unit?: SamplingWeightUnit | string | null;
  estimated_population?: number | string | null;
  notes?: string | null;
  performed_at?: string | null;
}

export interface SamplingPayload extends Record<string, unknown> {
  sample_size: number;
  average_weight: number;
  minimum_weight?: number;
  maximum_weight?: number;
  weight_unit: SamplingWeightUnit;
  estimated_population?: number;
  notes?: string;
}

export type FeedingSubmission = ProductionSubmission<FeedingPayload>;
export type FeedingWriteResult = ProductionWriteResult<FeedingPayload>;
export type MortalitySubmission = ProductionSubmission<MortalityPayload>;
export type MortalityWriteResult = ProductionWriteResult<MortalityPayload>;
export type SamplingSubmission = ProductionSubmission<SamplingPayload>;
export type SamplingWriteResult = ProductionWriteResult<SamplingPayload>;
export type StockingSubmission = ProductionSubmission<StockingPayload>;
export type StockingWriteResult = ProductionWriteResult<StockingPayload>;

export interface TransferInput {
  source_unit_id: string | null;
  destination_unit_id: string | null;
  destination_batch_id: string | null;
  quantity: number | string | null;
  transfer_loss?: number | string | null;
  average_weight?: number | string | null;
  weight_unit?: 'g' | 'kg' | string | null;
  transferred_at: string | null;
  notes?: string | null;
}

export interface TransferPayload extends Record<string, unknown> {
  source_unit_id: string;
  destination_unit_id: string;
  destination_batch_id: string;
  quantity: number;
  transfer_loss: number;
  average_weight?: number;
  weight_unit?: 'g' | 'kg';
  transferred_at: string;
  notes?: string;
}

export type TransferSubmission = ProductionSubmission<TransferPayload>;
export type TransferWriteResult = ProductionWriteResult<TransferPayload>;

export interface HarvestInput {
  quantity: number | string | null;
  total_weight: number | string | null;
  weight_unit?: 'g' | 'kg' | string | null;
  average_weight?: number | string | null;
  notes?: string | null;
  is_final: boolean;
}

export interface HarvestPayload extends Record<string, unknown> {
  harvest_type: 'partial' | 'total';
  is_final: boolean;
  quantity: number;
  total_weight: number;
  weight_unit: 'g' | 'kg';
  harvested_at: string;
  average_weight?: number;
  notes?: string;
}

export type HarvestSubmission = ProductionSubmission<HarvestPayload>;
export type HarvestWriteResult = ProductionWriteResult<HarvestPayload>;

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

export function normalizeProductionEventTime(value: string | null): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const timestamp =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmed,
    );
  if (!timestamp) return null;

  const year = Number(timestamp[1]);
  const month = Number(timestamp[2]);
  const day = Number(timestamp[3]);
  const hour = Number(timestamp[4]);
  const minute = Number(timestamp[5]);
  const second = Number(timestamp[6] ?? 0);
  const fraction = timestamp[7] ?? '';
  const millisecond = Number(`${fraction}000`.slice(0, 3));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  if (
    !timestamp[8] &&
    (parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day ||
      parsed.getHours() !== hour ||
      parsed.getMinutes() !== minute ||
      parsed.getSeconds() !== second ||
      parsed.getMilliseconds() !== millisecond)
  ) {
    return null;
  }
  return parsed.toISOString();
}

export function normalizeMortalityObservedAt(value: string | null): string | null {
  return normalizeProductionEventTime(value);
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

export function buildMortalityPayload(values: MortalityInput): MortalityPayload {
  const count = toFiniteNumber(values.count);
  if (count === null || !Number.isInteger(count) || count < 1) {
    throw new Error('count must be a positive integer.');
  }

  const observedAt = normalizeMortalityObservedAt(values.observed_at);
  if (!observedAt) throw new Error('A valid observed_at timestamp is required.');

  const suspectedCause = readRequiredText(values.suspected_cause, 'suspected_cause', 255);
  const disposalMethod = values.disposal_method ?? undefined;
  if (
    disposalMethod !== undefined &&
    disposalMethod !== null &&
    !['burial', 'incineration', 'compost', 'rendering', 'other'].includes(disposalMethod)
  ) {
    throw new Error('disposal_method is invalid.');
  }

  const evidenceInput = values.evidence ?? undefined;
  let evidence: MortalityPayload['evidence'];
  if (evidenceInput) {
    const labReportRef = readRequiredText(
      evidenceInput.lab_report_ref,
      'evidence.lab_report_ref',
      255,
    );
    const veterinarianId = readRequiredText(
      evidenceInput.veterinarian_id,
      'evidence.veterinarian_id',
      255,
    );
    const evidenceNotes = readRequiredText(evidenceInput.notes, 'evidence.notes', 1000);
    if (
      evidenceInput.photos !== undefined &&
      evidenceInput.photos !== null &&
      (!Array.isArray(evidenceInput.photos) ||
        evidenceInput.photos.some((photo) => typeof photo !== 'string'))
    ) {
      throw new Error('evidence.photos must be a list of strings.');
    }
    const photos = evidenceInput.photos?.filter((photo) => photo.trim().length > 0);
    if (photos?.length || labReportRef || veterinarianId || evidenceNotes) {
      evidence = {
        ...(photos?.length ? { photos } : {}),
        ...(labReportRef ? { lab_report_ref: labReportRef } : {}),
        ...(veterinarianId ? { veterinarian_id: veterinarianId } : {}),
        ...(evidenceNotes ? { notes: evidenceNotes } : {}),
      };
    }
  }

  return {
    count,
    observed_at: observedAt,
    ...(suspectedCause ? { suspected_cause: suspectedCause } : {}),
    ...(disposalMethod ? { disposal_method: disposalMethod as MortalityDisposalMethod } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function createMortalityDraftSignature(batchId: string, values: MortalityInput): string {
  return JSON.stringify({
    batchId,
    normalizedObservedAt: normalizeMortalityObservedAt(values.observed_at),
    values: {
      count: values.count ?? '',
      observed_at: values.observed_at ?? '',
      suspected_cause: values.suspected_cause?.trim() ?? '',
      disposal_method: values.disposal_method ?? '',
      evidence: {
        photos: values.evidence?.photos ?? [],
        lab_report_ref: values.evidence?.lab_report_ref?.trim() ?? '',
        veterinarian_id: values.evidence?.veterinarian_id?.trim() ?? '',
        notes: values.evidence?.notes?.trim() ?? '',
      },
    },
  });
}

export function createMortalitySubmission(
  batchId: string,
  values: MortalityInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): MortalitySubmission {
  const payload = buildMortalityPayload(values);
  return {
    batchId,
    payload,
    idempotencyKey: idempotencyKey ?? makeOpaqueId('mortality'),
    createdAt: new Date().toISOString(),
    context: { ...(context ?? {}), batchId },
    performedAt: payload.observed_at,
  };
}

export function buildSamplingPayload(values: SamplingInput): SamplingPayload {
  const sampleSize = toFiniteNumber(values.sample_size);
  if (sampleSize === null || !Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new Error('sample_size must be a positive integer.');
  }

  const averageWeight = toFiniteNumber(values.average_weight);
  if (averageWeight === null || averageWeight < 0) {
    throw new Error('average_weight must be zero or greater.');
  }

  let minimumWeight: number | undefined;
  if (
    values.minimum_weight !== null &&
    values.minimum_weight !== undefined &&
    values.minimum_weight !== ''
  ) {
    const parsed = toFiniteNumber(values.minimum_weight);
    if (parsed === null || parsed < 0) throw new Error('minimum_weight must be zero or greater.');
    minimumWeight = parsed;
  }

  let maximumWeight: number | undefined;
  if (
    values.maximum_weight !== null &&
    values.maximum_weight !== undefined &&
    values.maximum_weight !== ''
  ) {
    const parsed = toFiniteNumber(values.maximum_weight);
    if (parsed === null || parsed < 0) throw new Error('maximum_weight must be zero or greater.');
    maximumWeight = parsed;
  }

  if (minimumWeight !== undefined && minimumWeight > averageWeight) {
    throw new Error('minimum_weight cannot exceed average_weight.');
  }
  if (maximumWeight !== undefined && maximumWeight < averageWeight) {
    throw new Error('maximum_weight cannot be below average_weight.');
  }
  if (minimumWeight !== undefined && maximumWeight !== undefined && minimumWeight > maximumWeight) {
    throw new Error('minimum_weight cannot exceed maximum_weight.');
  }

  const weightUnit = values.weight_unit ?? 'g';
  if (weightUnit !== 'g' && weightUnit !== 'kg') {
    throw new Error('weight_unit must be g or kg.');
  }

  let estimatedPopulation: number | undefined;
  if (
    values.estimated_population !== null &&
    values.estimated_population !== undefined &&
    values.estimated_population !== ''
  ) {
    const parsed = toFiniteNumber(values.estimated_population);
    if (parsed === null || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error('estimated_population must be an integer zero or greater.');
    }
    estimatedPopulation = parsed;
  }

  const notes = readRequiredText(values.notes, 'notes', 1000);

  return {
    sample_size: sampleSize,
    average_weight: averageWeight,
    ...(minimumWeight === undefined ? {} : { minimum_weight: minimumWeight }),
    ...(maximumWeight === undefined ? {} : { maximum_weight: maximumWeight }),
    weight_unit: weightUnit as SamplingWeightUnit,
    ...(estimatedPopulation === undefined ? {} : { estimated_population: estimatedPopulation }),
    ...(notes ? { notes } : {}),
  };
}

export function createSamplingDraftSignature(batchId: string, values: SamplingInput): string {
  return JSON.stringify({
    batchId,
    performedAt: normalizeProductionEventTime(values.performed_at ?? null),
    values: {
      sample_size: values.sample_size ?? '',
      average_weight: values.average_weight ?? '',
      minimum_weight: values.minimum_weight ?? '',
      maximum_weight: values.maximum_weight ?? '',
      weight_unit: values.weight_unit ?? 'g',
      estimated_population: values.estimated_population ?? '',
      notes: values.notes?.trim() ?? '',
    },
  });
}

export function createSamplingSubmission(
  batchId: string,
  values: SamplingInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): SamplingSubmission {
  const performedAt = normalizeProductionEventTime(values.performed_at ?? new Date().toISOString());
  if (!performedAt) throw new Error('A valid sampling observation time is required.');
  return {
    batchId,
    payload: buildSamplingPayload(values),
    idempotencyKey: idempotencyKey ?? makeOpaqueId('sampling'),
    createdAt: new Date().toISOString(),
    context: { ...(context ?? {}), batchId },
    performedAt,
  };
}

export function buildStockingPayload(values: StockingInput): StockingPayload {
  const speciesCode = readRequiredText(values.species_code, 'species_code', 64);
  if (!speciesCode) throw new Error('species_code is required.');

  const quantity = toFiniteNumber(values.quantity);
  if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer.');
  }

  const averageWeight = toFiniteNumber(values.average_weight);
  if (averageWeight === null || averageWeight < 0) {
    throw new Error('average_weight must be zero or greater.');
  }

  const weightUnit = values.weight_unit ?? 'g';
  if (weightUnit !== 'g' && weightUnit !== 'kg') {
    throw new Error('weight_unit must be g or kg.');
  }

  const physicalStockedAt = normalizeProductionEventTime(values.stocked_at);
  if (!physicalStockedAt) throw new Error('A valid physical stocking time is required.');

  const source = readRequiredText(values.source, 'source', 255);
  const notes = readRequiredText(values.notes, 'notes', 1000);

  return {
    species_code: speciesCode,
    quantity,
    average_weight: averageWeight,
    weight_unit: weightUnit,
    stocked_at: physicalStockedAt,
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function createStockingDraftSignature(batchId: string, values: StockingInput): string {
  return JSON.stringify({
    batchId,
    values: {
      species_code: values.species_code?.trim() ?? '',
      quantity: values.quantity ?? '',
      average_weight: values.average_weight ?? '',
      weight_unit: values.weight_unit ?? 'g',
      stocked_at: normalizeProductionEventTime(values.stocked_at),
      source: values.source?.trim() ?? '',
      notes: values.notes?.trim() ?? '',
    },
  });
}

export function createStockingSubmission(
  batchId: string,
  values: StockingInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): StockingSubmission {
  return {
    batchId,
    payload: buildStockingPayload(values),
    idempotencyKey: idempotencyKey ?? makeOpaqueId('stocking'),
    createdAt: new Date().toISOString(),
    context: { ...(context ?? {}), batchId },
  };
}

const TRANSFER_FUTURE_TOLERANCE_MS = 60_000;

export function buildTransferPayload(
  values: TransferInput,
  now: number = Date.now(),
): TransferPayload {
  const sourceUnitId = readRequiredText(values.source_unit_id, 'source_unit_id', 64);
  if (!sourceUnitId) throw new Error('The source unit is required.');
  const destinationUnitId = readRequiredText(values.destination_unit_id, 'destination_unit_id', 64);
  const destinationBatchId = readRequiredText(
    values.destination_batch_id,
    'destination_batch_id',
    64,
  );
  if (!destinationUnitId || !destinationBatchId) {
    throw new Error('Select a destination from the server-provided eligible destinations.');
  }
  if (destinationUnitId === sourceUnitId) {
    throw new Error('The destination unit must differ from the source unit.');
  }

  const quantity = toFiniteNumber(values.quantity);
  if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer.');
  }
  const transferLoss = toFiniteNumber(values.transfer_loss ?? 0);
  if (transferLoss === null || !Number.isInteger(transferLoss) || transferLoss < 0) {
    throw new Error('transfer_loss must be zero or a positive integer.');
  }

  const rawWeight = values.average_weight;
  const hasWeight =
    rawWeight !== null && rawWeight !== undefined && String(rawWeight).trim() !== '';
  let averageWeight: number | undefined;
  let weightUnit: 'g' | 'kg' | undefined;
  if (hasWeight) {
    const parsed = toFiniteNumber(rawWeight);
    if (parsed === null || parsed < 0) throw new Error('average_weight must be zero or greater.');
    averageWeight = parsed;
    const unit = values.weight_unit || 'g';
    if (unit !== 'g' && unit !== 'kg') throw new Error('weight_unit must be g or kg.');
    weightUnit = unit;
  }

  const transferredAt = normalizeProductionEventTime(values.transferred_at);
  if (!transferredAt) throw new Error('A valid physical transfer time is required.');
  if (Date.parse(transferredAt) > now + TRANSFER_FUTURE_TOLERANCE_MS) {
    throw new Error('The physical transfer time cannot be in the future.');
  }

  const notes = readRequiredText(values.notes, 'notes', 1000);

  return {
    source_unit_id: sourceUnitId,
    destination_unit_id: destinationUnitId,
    destination_batch_id: destinationBatchId,
    quantity,
    transfer_loss: transferLoss,
    ...(averageWeight === undefined ? {} : { average_weight: averageWeight }),
    ...(weightUnit === undefined ? {} : { weight_unit: weightUnit }),
    transferred_at: transferredAt,
    ...(notes ? { notes } : {}),
  };
}

export function createTransferDraftSignature(batchId: string, values: TransferInput): string {
  return JSON.stringify({
    batchId,
    values: {
      source_unit_id: values.source_unit_id?.trim() ?? '',
      destination_unit_id: values.destination_unit_id?.trim() ?? '',
      destination_batch_id: values.destination_batch_id?.trim() ?? '',
      quantity: values.quantity ?? '',
      transfer_loss: values.transfer_loss ?? '',
      average_weight: values.average_weight ?? '',
      weight_unit: values.weight_unit ?? 'g',
      transferred_at: normalizeProductionEventTime(values.transferred_at),
      notes: values.notes?.trim() ?? '',
    },
  });
}

export function createTransferSubmission(
  batchId: string,
  values: TransferInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
): TransferSubmission {
  return {
    batchId,
    payload: buildTransferPayload(values),
    idempotencyKey: idempotencyKey ?? makeOpaqueId('transfer'),
    createdAt: new Date().toISOString(),
    context: { ...(context ?? {}), batchId },
  };
}

export function buildHarvestPayload(values: HarvestInput, harvestedAt: string): HarvestPayload {
  const quantity = toFiniteNumber(values.quantity);
  if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer.');
  }

  const totalWeight = toFiniteNumber(values.total_weight);
  if (totalWeight === null || totalWeight <= 0) {
    throw new Error('total_weight must be greater than zero.');
  }

  const weightUnit = values.weight_unit ?? 'kg';
  if (weightUnit !== 'g' && weightUnit !== 'kg') {
    throw new Error('weight_unit must be g or kg.');
  }

  const canonicalHarvestedAt = normalizeProductionEventTime(harvestedAt);
  if (!canonicalHarvestedAt) throw new Error('A valid harvest time is required.');

  const rawAverage = values.average_weight;
  const hasAverage =
    rawAverage !== null &&
    rawAverage !== undefined &&
    !(typeof rawAverage === 'string' && rawAverage.trim().length === 0);
  const averageWeight = hasAverage ? toFiniteNumber(rawAverage) : null;
  if (hasAverage && (averageWeight === null || averageWeight <= 0)) {
    throw new Error('average_weight must be greater than zero.');
  }

  const notes = readRequiredText(values.notes, 'notes', 1000);

  return {
    harvest_type: values.is_final ? 'total' : 'partial',
    is_final: values.is_final,
    quantity,
    total_weight: totalWeight,
    weight_unit: weightUnit,
    harvested_at: canonicalHarvestedAt,
    ...(averageWeight !== null ? { average_weight: averageWeight } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function createHarvestDraftSignature(
  batchId: string,
  values: HarvestInput,
  projectedRemaining?: number | null,
): string {
  return JSON.stringify({
    batchId,
    values: {
      is_final: values.is_final,
      quantity: values.quantity ?? '',
      total_weight: values.total_weight ?? '',
      weight_unit: values.weight_unit ?? 'kg',
      average_weight: values.average_weight ?? '',
      notes: values.notes?.trim() ?? '',
    },
    projectedRemaining: values.is_final ? (projectedRemaining ?? null) : null,
  });
}

export function createHarvestSubmission(
  batchId: string,
  values: HarvestInput,
  idempotencyKey?: string,
  context?: Partial<WaterQualityWriteContext>,
  now: Date = new Date(),
): HarvestSubmission {
  const harvestedAt = now.toISOString();
  return {
    batchId,
    payload: buildHarvestPayload(values, harvestedAt),
    idempotencyKey: idempotencyKey ?? makeOpaqueId('harvest'),
    createdAt: harvestedAt,
    performedAt: harvestedAt,
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

type ProductionEventType =
  'WATER_QUALITY' | 'FEEDING' | 'MORTALITY' | 'SAMPLING' | 'STOCKING' | 'TRANSFER' | 'HARVEST';
const PRODUCTION_WRITE_LEDGER = new Map<string, ProductionWriteResult<any>>();
export interface ProductionEventWriteRecovery {
  submission: ProductionSubmission<any>;
  inFlight: boolean;
  promise: Promise<ProductionWriteResult<any>> | null;
  retryOutcome?: 'accepted' | 'outcome_unknown' | 'reconciliation_failed';
}

export type MortalityWriteRecovery = ProductionEventWriteRecovery;
export type SamplingWriteRecovery = ProductionEventWriteRecovery;
export type StockingWriteRecovery = ProductionEventWriteRecovery;
export type TransferWriteRecovery = ProductionEventWriteRecovery;
export type HarvestWriteRecovery = ProductionEventWriteRecovery;

const PRODUCTION_EVENT_WRITE_RECOVERY = new Map<string, ProductionEventWriteRecovery>();
const PRODUCTION_WRITE_IN_FLIGHT = new Map<
  string,
  { submission: ProductionSubmission<any>; promise: Promise<ProductionWriteResult<any>> }
>();

function productionEventRecoveryKey(eventType: ProductionEventType, batchId: string): string {
  return JSON.stringify([eventType, batchId]);
}

export function getProductionEventWriteRecovery(
  eventType: ProductionEventType,
  batchId: string,
): ProductionEventWriteRecovery | null {
  return (
    PRODUCTION_EVENT_WRITE_RECOVERY.get(productionEventRecoveryKey(eventType, batchId)) ?? null
  );
}

export function clearProductionEventWriteRecovery(
  eventType: ProductionEventType,
  batchId: string,
  idempotencyKey: string,
): void {
  const key = productionEventRecoveryKey(eventType, batchId);
  const recovery = PRODUCTION_EVENT_WRITE_RECOVERY.get(key);
  if (recovery?.submission.idempotencyKey === idempotencyKey && !recovery.inFlight) {
    PRODUCTION_EVENT_WRITE_RECOVERY.delete(key);
  }
}

export function getMortalityWriteRecovery(batchId: string): MortalityWriteRecovery | null {
  return getProductionEventWriteRecovery('MORTALITY', batchId);
}

export function clearMortalityWriteRecovery(batchId: string, idempotencyKey: string): void {
  clearProductionEventWriteRecovery('MORTALITY', batchId, idempotencyKey);
}

export function getSamplingWriteRecovery(batchId: string): SamplingWriteRecovery | null {
  return getProductionEventWriteRecovery('SAMPLING', batchId);
}

export function clearSamplingWriteRecovery(batchId: string, idempotencyKey: string): void {
  clearProductionEventWriteRecovery('SAMPLING', batchId, idempotencyKey);
}

export function getStockingWriteRecovery(batchId: string): StockingWriteRecovery | null {
  return getProductionEventWriteRecovery('STOCKING', batchId);
}

export function clearStockingWriteRecovery(batchId: string, idempotencyKey: string): void {
  clearProductionEventWriteRecovery('STOCKING', batchId, idempotencyKey);
}

export function getTransferWriteRecovery(batchId: string): TransferWriteRecovery | null {
  return getProductionEventWriteRecovery('TRANSFER', batchId);
}

export function clearTransferWriteRecovery(batchId: string, idempotencyKey: string): void {
  clearProductionEventWriteRecovery('TRANSFER', batchId, idempotencyKey);
}

export function getHarvestWriteRecovery(batchId: string): HarvestWriteRecovery | null {
  return getProductionEventWriteRecovery('HARVEST', batchId);
}

export function clearHarvestWriteRecovery(batchId: string, idempotencyKey: string): void {
  clearProductionEventWriteRecovery('HARVEST', batchId, idempotencyKey);
}

/**
 * Registers a submission restored from durable storage so it flows through the
 * existing same-key recovery path. Never replaces a different unresolved entry.
 */
export function restoreHarvestWriteRecovery(
  submission: HarvestSubmission,
  retryOutcome: 'outcome_unknown' | 'reconciliation_failed' = 'outcome_unknown',
): boolean {
  const key = productionEventRecoveryKey('HARVEST', submission.batchId);
  const existing = PRODUCTION_EVENT_WRITE_RECOVERY.get(key);
  if (existing) return isSameProductionSubmission(existing.submission, submission);
  PRODUCTION_EVENT_WRITE_RECOVERY.set(key, {
    submission,
    inFlight: false,
    promise: null,
    retryOutcome,
  });
  return true;
}

function isSameProductionSubmission(
  left: ProductionSubmission<any>,
  right: ProductionSubmission<any>,
): boolean {
  return (
    left.batchId === right.batchId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.performedAt === right.performedAt &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

function reconcileProductionEventWrite<TPayload extends Record<string, unknown>>({
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
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<ProductionWriteResult<TPayload>> {
  const recoveryKey = productionEventRecoveryKey(eventType, context.batchId);
  const existingRecovery = PRODUCTION_EVENT_WRITE_RECOVERY.get(recoveryKey);
  if (existingRecovery) {
    if (
      existingRecovery.submission.idempotencyKey !== submission.idempotencyKey ||
      !isSameProductionSubmission(existingRecovery.submission, submission)
    ) {
      throw new Error(
        `An unresolved ${eventType} submission must be reconciled before starting another.`,
      );
    }
    if (existingRecovery.inFlight && existingRecovery.promise) {
      return existingRecovery.promise as Promise<ProductionWriteResult<TPayload>>;
    }
  }

  const corePromise = reconcileProductionWrite({
    context,
    eventType,
    submission,
    post,
    readAll,
  });
  const recovery: ProductionEventWriteRecovery = {
    submission,
    inFlight: true,
    promise: null,
  };
  const trackedPromise = corePromise.then(
    (result) => {
      if (PRODUCTION_EVENT_WRITE_RECOVERY.get(recoveryKey) === recovery) {
        if (result.retrySubmission) {
          PRODUCTION_EVENT_WRITE_RECOVERY.set(recoveryKey, {
            submission: result.retrySubmission,
            inFlight: false,
            promise: null,
            retryOutcome:
              result.outcome === 'reconciliation_failed'
                ? 'reconciliation_failed'
                : 'outcome_unknown',
          });
        } else if (
          (eventType === 'SAMPLING' ||
            eventType === 'STOCKING' ||
            eventType === 'TRANSFER' ||
            eventType === 'HARVEST') &&
          result.outcome === 'accepted'
        ) {
          PRODUCTION_EVENT_WRITE_RECOVERY.set(recoveryKey, {
            submission,
            inFlight: false,
            promise: null,
            retryOutcome: 'accepted',
          });
        } else {
          PRODUCTION_EVENT_WRITE_RECOVERY.delete(recoveryKey);
        }
      }
      return result;
    },
    (error: unknown) => {
      if (PRODUCTION_EVENT_WRITE_RECOVERY.get(recoveryKey) === recovery) {
        PRODUCTION_EVENT_WRITE_RECOVERY.set(recoveryKey, {
          submission,
          inFlight: false,
          promise: null,
          retryOutcome: 'outcome_unknown',
        });
      }
      throw error;
    },
  );
  recovery.promise = trackedPromise;
  PRODUCTION_EVENT_WRITE_RECOVERY.set(recoveryKey, recovery);
  return trackedPromise;
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
    ...(error instanceof ApiError && error.code ? { code: error.code } : {}),
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

  if (
    error.phase === 'application' ||
    (error.phase === 'http' &&
      error.status !== undefined &&
      error.status >= 500 &&
      error.status < 600)
  ) {
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

  if (error.phase === 'http') {
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
      performedAt?: string,
    ) => Promise<Record<string, unknown>>;
    readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
  },
  submission: ProductionSubmission<TPayload>,
): Promise<ProductionWriteResult<TPayload>> {
  const prior = PRODUCTION_WRITE_LEDGER.get(submission.idempotencyKey);
  if (prior && !isSameProductionSubmission(prior.submission, submission)) {
    return {
      outcome: 'write_failed',
      submission,
      retrySubmission: null,
      posted: false,
      reconciled: false,
      response: null,
      error: new Error(
        'The idempotency key was already used for a different production submission.',
      ),
    };
  }
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
    const writeResponse =
      submission.performedAt === undefined
        ? await post(context.batchId, eventType, submission.payload, submission.idempotencyKey)
        : await post(
            context.batchId,
            eventType,
            submission.payload,
            submission.idempotencyKey,
            submission.performedAt,
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
    performedAt?: string,
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

export function reconcileMortalityWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: MortalityInput;
  idempotencyKey: string;
  submission?: MortalitySubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<MortalityWriteResult> {
  const normalizedPayload = buildMortalityPayload(payload);
  const submission =
    preservedSubmission ??
    createMortalitySubmission(context.batchId, payload, idempotencyKey, context);
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    submission.performedAt !== normalizedPayload.observed_at ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved mortality submission does not match the current intent.');
  }
  return reconcileProductionEventWrite({
    context,
    eventType: 'MORTALITY',
    submission,
    post,
    readAll,
  });
}

export function reconcileSamplingWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: SamplingInput;
  idempotencyKey: string;
  submission?: SamplingSubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<SamplingWriteResult> {
  const normalizedPayload = buildSamplingPayload(payload);
  const performedAt = normalizeProductionEventTime(
    payload.performed_at ?? preservedSubmission?.performedAt ?? new Date().toISOString(),
  );
  if (!performedAt) throw new Error('A valid sampling observation time is required.');
  const submission =
    preservedSubmission ??
    createSamplingSubmission(
      context.batchId,
      { ...payload, performed_at: performedAt },
      idempotencyKey,
      context,
    );
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    submission.performedAt !== performedAt ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved sampling submission does not match the current intent.');
  }
  return reconcileProductionEventWrite({
    context,
    eventType: 'SAMPLING',
    submission,
    post,
    readAll,
  });
}

export function reconcileStockingWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: StockingInput;
  idempotencyKey: string;
  submission?: StockingSubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<StockingWriteResult> {
  const normalizedPayload = buildStockingPayload(payload);
  const submission =
    preservedSubmission ??
    createStockingSubmission(context.batchId, payload, idempotencyKey, context);
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    submission.performedAt !== undefined ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved stocking submission does not match the current intent.');
  }
  return reconcileProductionEventWrite({
    context,
    eventType: 'STOCKING',
    submission,
    post,
    readAll,
  });
}

export class HarvestReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarvestReconciliationError';
  }
}

function parseReconciliationInstant(value: unknown): { seconds: number; fraction: string } | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || match[0] !== value) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  // Date supplies integral calendar seconds only; fractional digits never pass through it.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const offsetSeconds = (offsetHour * 60 + offsetMinute) * 60;
  return {
    seconds: calendar.getTime() / 1000 - (match[9] === '-' ? -offsetSeconds : offsetSeconds),
    fraction: (match[7] ?? '').replace(/0+$/, ''),
  };
}

function equivalentReconciliationInstants(left: unknown, right: unknown): boolean {
  const leftInstant = parseReconciliationInstant(left);
  const rightInstant = parseReconciliationInstant(right);
  return (
    leftInstant !== null &&
    rightInstant !== null &&
    leftInstant.seconds === rightInstant.seconds &&
    leftInstant.fraction === rightInstant.fraction
  );
}

export function verifyHarvestReconciliation(
  reconciliation: WaterQualityReconciliationData,
  submission: HarvestSubmission,
): void {
  const events = Array.isArray(reconciliation.events) ? reconciliation.events : [];
  const accepted = events.find((event) => {
    const record = event as Record<string, unknown>;
    return record.event_type === 'HARVEST' && record.idempotency_key === submission.idempotencyKey;
  }) as Record<string, unknown> | undefined;
  if (!accepted) {
    throw new HarvestReconciliationError(
      'The accepted HARVEST event was not found in the refreshed timeline.',
    );
  }
  const data =
    typeof accepted.data === 'object' && accepted.data !== null
      ? (accepted.data as Record<string, unknown>)
      : {};
  if (
    data.quantity !== submission.payload.quantity ||
    data.is_final !== submission.payload.is_final ||
    !equivalentReconciliationInstants(data.harvested_at, submission.payload.harvested_at)
  ) {
    throw new HarvestReconciliationError(
      'The accepted HARVEST event does not match the submitted harvest.',
    );
  }
  if (submission.payload.is_final) {
    const state = (reconciliation.batch as Record<string, unknown> | null)?.state;
    if (typeof state !== 'string' || state.toLowerCase() !== 'harvested') {
      throw new HarvestReconciliationError(
        'The final HARVEST was accepted but the batch is not yet HARVESTED in the refreshed state.',
      );
    }
  }
}

export function reconcileHarvestWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readAll,
}: {
  context: WaterQualityWriteContext;
  payload: HarvestInput;
  idempotencyKey: string;
  submission?: HarvestSubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readAll: (batchId: string) => Promise<WaterQualityReconciliationData>;
}): Promise<HarvestWriteResult> {
  const submission =
    preservedSubmission ??
    createHarvestSubmission(context.batchId, payload, idempotencyKey, context);
  const normalizedPayload = buildHarvestPayload(payload, submission.payload.harvested_at);
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    submission.performedAt !== submission.payload.harvested_at ||
    JSON.stringify(submission.payload) !== JSON.stringify(normalizedPayload)
  ) {
    throw new Error('The preserved harvest submission does not match the current intent.');
  }
  return reconcileProductionEventWrite({
    context,
    eventType: 'HARVEST',
    submission,
    post,
    readAll: async (batchId) => {
      const reconciliation = await readAll(batchId);
      verifyHarvestReconciliation(reconciliation, submission);
      return reconciliation;
    },
  });
}

export type TransferReconciliationFailureKind =
  'incomplete_read' | 'integrity_anomaly' | 'pair_mismatch';

export class TransferReconciliationError extends Error {
  constructor(
    public readonly kind: TransferReconciliationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'TransferReconciliationError';
  }
}

export interface TransferEventPage {
  items: Record<string, unknown>[];
  next_cursor: string | null;
}

export interface TransferReaders {
  getBatch: (batchId: string) => Promise<Record<string, unknown>>;
  getProjection: (batchId: string) => Promise<Record<string, unknown>>;
  listEvents: (
    batchId: string,
    options: { limit: number; cursor?: string; eventType?: string },
  ) => Promise<TransferEventPage>;
}

export interface TransferReconciliationData extends WaterQualityReconciliationData {
  destination: WaterQualityReconciliationData;
  transfer_id: string;
}

export function isTransferReconciliation(
  value: WaterQualityReconciliationData | null | undefined,
): value is TransferReconciliationData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'destination' in value &&
    'transfer_id' in value &&
    typeof value.transfer_id === 'string'
  );
}

export const TRANSFER_EVENT_PAGE_LIMIT = 100;
export const TRANSFER_EVENT_MAX_PAGES = 20;
const TRANSFER_DISPLAY_EVENT_LIMIT = 50;

const TRANSFER_CAPTURED_IDS = new Map<string, string>();

function isTransferRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transferEventData(event: Record<string, unknown>): Record<string, unknown> {
  return isTransferRecord(event.data) ? event.data : {};
}

function assertTransferEventMatches(
  event: Record<string, unknown>,
  side: 'out' | 'in',
  batchId: string,
  payload: TransferPayload,
): void {
  const data = transferEventData(event);
  const label = side === 'out' ? 'source OUT' : 'destination IN';
  if (
    event.event_type !== 'TRANSFER' ||
    event.transfer_role !== side ||
    event.batch_id !== batchId
  ) {
    throw new TransferReconciliationError(
      'pair_mismatch',
      `The ${label} transfer event does not match the submitted batch or role.`,
    );
  }
  if (
    data.quantity !== payload.quantity ||
    (data.transfer_loss ?? 0) !== payload.transfer_loss ||
    data.source_unit_id !== payload.source_unit_id ||
    data.destination_unit_id !== payload.destination_unit_id ||
    data.destination_batch_id !== payload.destination_batch_id
  ) {
    throw new TransferReconciliationError(
      'pair_mismatch',
      `The ${label} transfer event quantities or units do not match the submitted transfer.`,
    );
  }
}

async function scanTransferEvents(
  readers: TransferReaders,
  batchId: string,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<{ event: Record<string, unknown> | null; exhausted: boolean }> {
  let cursor: string | undefined;
  for (let page = 0; page < TRANSFER_EVENT_MAX_PAGES; page += 1) {
    const result = await readers.listEvents(batchId, {
      limit: TRANSFER_EVENT_PAGE_LIMIT,
      eventType: 'TRANSFER',
      ...(cursor ? { cursor } : {}),
    });
    const found = result.items.find(
      (event) => isTransferRecord(event) && event.event_type === 'TRANSFER' && predicate(event),
    );
    if (found) return { event: found, exhausted: false };
    if (!result.next_cursor) return { event: null, exhausted: true };
    if (result.next_cursor === cursor) {
      throw new TransferReconciliationError(
        'incomplete_read',
        'The transfer timeline cursor did not advance, so the read is incomplete.',
      );
    }
    cursor = result.next_cursor;
  }
  return { event: null, exhausted: false };
}

async function readTransferSide(
  readers: TransferReaders,
  batchId: string,
): Promise<WaterQualityReconciliationData> {
  const [batch, projection, eventPage] = await Promise.all([
    readers.getBatch(batchId),
    readers.getProjection(batchId),
    readers.listEvents(batchId, { limit: TRANSFER_DISPLAY_EVENT_LIMIT }),
  ]);
  return { batch, projection, events: eventPage.items };
}

// TRANSFER verification confirms the server-recorded atomic OUT/IN event pair and retrieves
// authoritative projections. It does not independently establish projection deltas under
// concurrent production activity.
async function reconcileTransferPair(
  readers: TransferReaders,
  submission: TransferSubmission,
): Promise<TransferReconciliationData> {
  const sourceBatchId = submission.batchId;
  const destinationBatchId = submission.payload.destination_batch_id;
  const [source, destination] = await Promise.all([
    readTransferSide(readers, sourceBatchId),
    readTransferSide(readers, destinationBatchId),
  ]);

  const capturedId = TRANSFER_CAPTURED_IDS.get(submission.idempotencyKey);
  const outScan = await scanTransferEvents(
    readers,
    sourceBatchId,
    (event) => event.transfer_role === 'out' && event.idempotency_key === submission.idempotencyKey,
  );
  if (!outScan.event) {
    throw new TransferReconciliationError(
      outScan.exhausted ? 'integrity_anomaly' : 'incomplete_read',
      outScan.exhausted
        ? 'INTEGRITY ANOMALY: the source timeline was fully read and contains no OUT event for this transfer. Do not submit a new transfer; escalate to an administrator.'
        : 'The source transfer timeline could not be fully read, so the OUT event is unconfirmed.',
    );
  }
  assertTransferEventMatches(outScan.event, 'out', sourceBatchId, submission.payload);
  const transferId = outScan.event.transfer_id;
  if (typeof transferId !== 'string' || transferId.length === 0) {
    throw new TransferReconciliationError(
      'pair_mismatch',
      'The source OUT event has no transfer_id.',
    );
  }
  if (capturedId !== undefined && capturedId !== transferId) {
    throw new TransferReconciliationError(
      'pair_mismatch',
      'The source OUT event transfer_id differs from the transfer_id returned by the server.',
    );
  }

  const inScan = await scanTransferEvents(
    readers,
    destinationBatchId,
    (event) => event.transfer_id === transferId && event.transfer_role === 'in',
  );
  if (!inScan.event) {
    throw new TransferReconciliationError(
      inScan.exhausted ? 'integrity_anomaly' : 'incomplete_read',
      inScan.exhausted
        ? 'INTEGRITY ANOMALY: the destination timeline was fully read and has no IN event paired with this transfer. Do not submit a new transfer; escalate to an administrator.'
        : 'The destination transfer timeline could not be fully read, so the IN event is unconfirmed.',
    );
  }
  assertTransferEventMatches(inScan.event, 'in', destinationBatchId, submission.payload);
  if (inScan.event.transfer_id !== transferId) {
    throw new TransferReconciliationError('pair_mismatch', 'The IN and OUT transfer ids differ.');
  }
  return { ...source, destination, transfer_id: transferId };
}

export function reconcileTransferWrite({
  context,
  payload,
  idempotencyKey,
  submission: preservedSubmission,
  post,
  readers,
}: {
  context: WaterQualityWriteContext;
  payload: TransferInput;
  idempotencyKey: string;
  submission?: TransferSubmission;
  post: (
    batchId: string,
    eventType: ProductionEventType,
    data: Record<string, unknown>,
    key: string,
    performedAt?: string,
  ) => Promise<Record<string, unknown>>;
  readers: TransferReaders;
}): Promise<TransferWriteResult> {
  const submission =
    preservedSubmission ??
    createTransferSubmission(context.batchId, payload, idempotencyKey, context);
  if (
    submission.batchId !== context.batchId ||
    submission.idempotencyKey !== idempotencyKey ||
    submission.performedAt !== undefined ||
    JSON.stringify(submission.payload) !==
      JSON.stringify(buildTransferPayload(payload, Number.POSITIVE_INFINITY))
  ) {
    throw new Error('The preserved transfer submission does not match the current intent.');
  }
  return reconcileProductionEventWrite({
    context,
    eventType: 'TRANSFER',
    submission,
    post: async (batchId, eventType, data, key, performedAt) => {
      const response = await post(batchId, eventType, data, key, performedAt);
      if (typeof response.transfer_id !== 'string' || response.transfer_id.length === 0) {
        throw new TransferReconciliationError(
          'pair_mismatch',
          'The server response did not include a transfer_id.',
        );
      }
      TRANSFER_CAPTURED_IDS.set(key, response.transfer_id);
      return response;
    },
    readAll: () => reconcileTransferPair(readers, submission),
  }) as Promise<TransferWriteResult>;
}
