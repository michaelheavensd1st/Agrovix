import { ApiFailure, authenticatedRequest } from './api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function contractFailure(path: string, reason: string, status?: number): never {
  throw new ApiFailure(
    'application',
    'http://localhost:8000/api',
    path,
    status,
    'ApiContractError',
    reason,
  );
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected object contract.`,
    );
  }
  return value;
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected array contract.`,
    );
  }
  return value;
}

function isOrganization(value: unknown): value is { id: string; slug: string; name: string } {
  if (!isRecord(value)) return false;
  return isOpaqueId(value.id) && isNonEmptyString(value.slug) && isNonEmptyString(value.name);
}

function isBatchEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!isOpaqueId(value.id)) return false;
  if (!isNonEmptyString(value.batch_id)) return false;
  if (!isNonEmptyString(value.event_type)) return false;
  if (!isFiniteNumber(value.event_type_version)) return false;
  if (!isNonEmptyString(value.performed_at)) return false;
  if (!isNonEmptyString(value.created_at)) return false;
  if (value.attachments !== null && !Array.isArray(value.attachments)) return false;
  if (!isRecord(value.data)) return false;
  return true;
}

function isProjection(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.batch_id) &&
    isFiniteNumber(value.initial_stocked_quantity) &&
    isFiniteNumber(value.estimated_remaining_population) &&
    (value.survival_rate === null || isFiniteNumber(value.survival_rate))
  );
}

function isTransferDestination(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) && (isNonEmptyString(value.label) || isNonEmptyString(value.unit_id))
  );
}

const PRODUCTION_SITE_STATUSES = new Set(['active', 'maintenance', 'closed']);
const PRODUCTION_UNIT_STATUSES = new Set(['active', 'maintenance', 'closed']);
const PRODUCTION_BATCH_STATES = new Set([
  'planned',
  'stocked',
  'active',
  'harvested',
  'closed',
  'suspended',
  'cancelled',
  'failed',
]);

const isCanonicalEnumValue = (value: unknown, allowed: ReadonlySet<string>): value is string =>
  typeof value === 'string' && allowed.has(value);

function isProductionSite(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return isOpaqueId(value.id);
}

function isProductionSiteDetail(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isOpaqueId(value.id) &&
    isOpaqueId(value.farm_id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.code) &&
    (value.description === null || typeof value.description === 'string') &&
    (value.address === null || typeof value.address === 'string') &&
    (value.latitude === null || isFiniteNumber(value.latitude)) &&
    (value.longitude === null || isFiniteNumber(value.longitude)) &&
    (value.timezone === null || typeof value.timezone === 'string') &&
    (value.manager_id === null || isOpaqueId(value.manager_id)) &&
    (value.capacity === null || isFiniteNumber(value.capacity)) &&
    isCanonicalEnumValue(value.status, PRODUCTION_SITE_STATUSES) &&
    (value.metadata_json === null || isRecord(value.metadata_json)) &&
    typeof value.is_default === 'boolean' &&
    typeof value.is_active === 'boolean' &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at)
  );
}

function isFarm(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isOpaqueId(value.id) &&
    isOpaqueId(value.organization_id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.code) &&
    (value.address === null || typeof value.address === 'string') &&
    (value.timezone === null || typeof value.timezone === 'string') &&
    typeof value.is_active === 'boolean' &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at)
  );
}

function isProductionUnitType(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isOpaqueId(value.id) &&
    (value.organization_id === null || isOpaqueId(value.organization_id)) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.display_name) &&
    (value.plural_name === null || typeof value.plural_name === 'string') &&
    (value.vertical === null || typeof value.vertical === 'string') &&
    (value.description === null || typeof value.description === 'string') &&
    (value.category === null || typeof value.category === 'string') &&
    typeof value.is_system === 'boolean' &&
    (value.metadata_json === null || isRecord(value.metadata_json)) &&
    isNonEmptyString(value.created_at)
  );
}

function isProductionUnit(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isOpaqueId(value.id) &&
    isOpaqueId(value.site_id) &&
    isOpaqueId(value.unit_type_id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.code) &&
    (value.capacity === null || isFiniteNumber(value.capacity)) &&
    isCanonicalEnumValue(value.status, PRODUCTION_UNIT_STATUSES) &&
    (value.metadata_json === null || isRecord(value.metadata_json)) &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at)
  );
}

function isProductionBatch(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isOpaqueId(value.id) &&
    isOpaqueId(value.unit_id) &&
    isNonEmptyString(value.code) &&
    isCanonicalEnumValue(value.state, PRODUCTION_BATCH_STATES) &&
    (value.species === null || typeof value.species === 'string') &&
    (value.planned_at === null || isNonEmptyString(value.planned_at)) &&
    (value.stocked_at === null || isNonEmptyString(value.stocked_at)) &&
    (value.harvested_at === null || isNonEmptyString(value.harvested_at)) &&
    (value.closed_at === null || isNonEmptyString(value.closed_at)) &&
    (value.expected_quantity === null || isFiniteNumber(value.expected_quantity)) &&
    (value.actual_quantity === null || isFiniteNumber(value.actual_quantity)) &&
    (value.notes === null || typeof value.notes === 'string') &&
    (value.metadata_json === null || isRecord(value.metadata_json)) &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at)
  );
}

function isBatchEventListResponse(
  value: unknown,
): value is { items: unknown[]; next_cursor: string | null; limit: number } {
  if (!isRecord(value)) return false;
  const items = Array.isArray(value.items) ? value.items : undefined;
  const nextCursor = value.next_cursor;
  const limit = value.limit;
  return (
    Array.isArray(items) &&
    (nextCursor === null || typeof nextCursor === 'string') &&
    typeof limit === 'number' &&
    Number.isFinite(limit) &&
    limit > 0
  );
}

export async function listOrganizations(): Promise<
  Array<{ id: string; slug: string; name: string }>
> {
  const path = '/v1/organizations';
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const organizations = assertArray(body, path);
  const items = organizations.map((item) => {
    const record = assertRecord(item, path);
    if (!isOrganization(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected organization contract.`,
      );
    }
    return record;
  });
  return items as Array<{ id: string; slug: string; name: string }>;
}

export async function listFarms(organizationId: string): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/farms`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const farms = assertArray(body, path);
  return farms.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isFarm(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected farm contract.`,
      );
    }
    return record;
  });
}

export async function listProductionSites(farmId: string): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/farms/${encodeURIComponent(farmId)}/sites`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const sites = assertArray(body, path);
  return sites.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isProductionSiteDetail(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected site contract.`,
      );
    }
    return record;
  });
}

export async function listProductionUnitTypes(
  organizationId: string,
): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/production-unit-types?organization_id=${encodeURIComponent(organizationId)}`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const types = assertArray(body, path);
  return types.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isProductionUnitType(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected production-unit-type contract.`,
      );
    }
    return record;
  });
}

export async function listProductionUnits(siteId: string): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/sites/${encodeURIComponent(siteId)}/units`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const units = assertArray(body, path);
  return units.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isProductionUnit(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected unit contract.`,
      );
    }
    return record;
  });
}

export async function listProductionBatches(
  unitId: string,
): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/units/${encodeURIComponent(unitId)}/batches`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const batches = assertArray(body, path);
  return batches.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isProductionBatch(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected batch contract.`,
      );
    }
    return record;
  });
}

export async function getProductionBatch(batchId: string): Promise<Record<string, unknown>> {
  const path = `/v1/batches/${encodeURIComponent(batchId)}`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const record = assertRecord(body, path);
  if (!isProductionBatch(record)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected batch contract.`,
    );
  }
  return record;
}

export async function createProductionSite(
  farmId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const path = `/v1/farms/${encodeURIComponent(farmId)}/sites`;
  const body = await authenticatedRequest<unknown>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const record = assertRecord(body, path);
  if (!isProductionSite(record) || typeof record.id !== 'string') {
    contractFailure(path, `The API response for ${path} did not match the expected site contract.`);
  }
  return { id: record.id as string };
}

export async function listBatchEvents(
  batchId: string,
  options: { limit?: number; cursor?: string; eventType?: string } = {},
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null; limit: number }> {
  const params = new URLSearchParams();
  if (typeof options.limit === 'number') params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.eventType) params.set('event_type', options.eventType);
  const query = params.toString();
  const path = `/v1/batches/${encodeURIComponent(batchId)}/events${query ? `?${query}` : ''}`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const record = assertRecord(body, path);
  if (!isBatchEventListResponse(record)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected batch-event list contract.`,
    );
  }
  const items = record.items.map((entry) => {
    const item = assertRecord(entry, path);
    if (!isBatchEvent(item)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected event contract.`,
      );
    }
    return item;
  });
  return { items, next_cursor: record.next_cursor, limit: record.limit };
}

export async function createBatchEvent(
  batchId: string,
  payload: { event_type: string; data?: Record<string, unknown> },
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const path = `/v1/batches/${encodeURIComponent(batchId)}/events`;
  const body = await authenticatedRequest<unknown>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload),
  });
  const record = assertRecord(body, path);
  if (!isBatchEvent(record)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected event contract.`,
    );
  }
  if (
    idempotencyKey &&
    record.idempotency_key !== undefined &&
    record.idempotency_key !== idempotencyKey
  ) {
    contractFailure(path, `The API response for ${path} returned an unexpected idempotency key.`);
  }
  return record;
}

export async function getBatchProjections(batchId: string): Promise<Record<string, unknown>> {
  const path = `/v1/batches/${encodeURIComponent(batchId)}/projections`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const record = assertRecord(body, path);
  if (!isProjection(record)) {
    contractFailure(
      path,
      `The API response for ${path} did not match the expected projection contract.`,
    );
  }
  return record;
}

export async function listTransferDestinations(
  batchId: string,
): Promise<Array<Record<string, unknown>>> {
  const path = `/v1/batches/${encodeURIComponent(batchId)}/transfer-destinations`;
  const body = await authenticatedRequest<unknown>(path, { method: 'GET' });
  const destinations = assertArray(body, path);
  return destinations.map((entry) => {
    const record = assertRecord(entry, path);
    if (!isTransferDestination(record)) {
      contractFailure(
        path,
        `The API response for ${path} did not match the expected transfer-destination contract.`,
      );
    }
    return record;
  });
}
