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
  if (!Array.isArray(value.attachments)) return false;
  if (!isRecord(value.data)) return false;
  return true;
}

function isProjection(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.batch_id) &&
    isFiniteNumber(value.initial_stocked_quantity) &&
    isFiniteNumber(value.estimated_remaining_population) &&
    isFiniteNumber(value.survival_rate)
  );
}

function isTransferDestination(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) && (isNonEmptyString(value.label) || isNonEmptyString(value.unit_id))
  );
}

function isProductionSite(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return isOpaqueId(value.id);
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
