/** @jest-environment node */

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('../secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('token-123'),
  getRefreshToken: jest.fn().mockResolvedValue('refresh-123'),
}));

import { ApiFailure } from '../api';
import {
  createBatchEvent,
  createProductionSite,
  getBatchProjections,
  listBatchEvents,
  listOrganizations,
  listTransferDestinations,
} from '../production-api';

describe('production-api client contract', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  test('rejects malformed 2xx success payloads as application contract failures', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(listOrganizations()).rejects.toMatchObject({
      phase: 'application',
      errorName: 'ApiContractError',
    });
  });

  test('uses authenticated transport and passes the exact opaque cursor through', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          next_cursor: null,
          limit: 25,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const opaqueCursor = 'cursor:opaque+value/with=chars';
    await listBatchEvents('batch-123', { limit: 25, cursor: opaqueCursor, eventType: 'STOCKING' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/batches/batch-123/events');
    expect(url).toContain('cursor=' + encodeURIComponent(opaqueCursor));
    expect(url).toContain('event_type=STOCKING');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-123' });
  });

  test('sends a stable idempotency key and accepts 200 exact replay payloads', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'event-1',
          organization_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          site_id: '33333333-3333-4333-8333-333333333333',
          unit_id: '44444444-4444-4444-8444-444444444444',
          batch_id: 'batch-123',
          event_type: 'STOCKING',
          event_type_version: 1,
          transfer_id: null,
          transfer_role: null,
          performed_by_id: null,
          performed_at: '2026-09-24T10:00:00Z',
          data: { quantity: 1250 },
          attachments: null,
          is_final: false,
          notes: null,
          idempotency_key: 'idem-123',
          created_at: '2026-09-24T10:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const event = await createBatchEvent(
      'batch-123',
      { event_type: 'STOCKING', data: { quantity: 1250 } },
      'idem-123',
    );

    expect(event.idempotency_key).toBe('idem-123');
    expect(event.attachments).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-123');
  });

  test('accepts nullable event attachments and rejects malformed attachment payloads', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'event-null-attachments',
          organization_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          site_id: '33333333-3333-4333-8333-333333333333',
          unit_id: '44444444-4444-4444-8444-444444444444',
          batch_id: 'batch-123',
          event_type: 'STOCKING',
          event_type_version: 1,
          transfer_id: null,
          transfer_role: null,
          performed_by_id: null,
          performed_at: '2026-09-24T10:00:00Z',
          data: { quantity: 1250 },
          attachments: null,
          is_final: false,
          notes: null,
          idempotency_key: 'idem-null-attachments',
          created_at: '2026-09-24T10:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      createBatchEvent(
        'batch-123',
        { event_type: 'STOCKING', data: { quantity: 1250 } },
        'idem-null-attachments',
      ),
    ).resolves.toMatchObject({ attachments: null });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'event-bad-attachments',
          organization_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          site_id: '33333333-3333-4333-8333-333333333333',
          unit_id: '44444444-4444-4444-8444-444444444444',
          batch_id: 'batch-123',
          event_type: 'STOCKING',
          event_type_version: 1,
          transfer_id: null,
          transfer_role: null,
          performed_by_id: null,
          performed_at: '2026-09-24T10:00:00Z',
          data: { quantity: 1250 },
          attachments: 'not-an-array',
          is_final: false,
          notes: null,
          idempotency_key: 'idem-bad-attachments',
          created_at: '2026-09-24T10:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      createBatchEvent(
        'batch-123',
        { event_type: 'STOCKING', data: { quantity: 1250 } },
        'idem-bad-attachments',
      ),
    ).rejects.toMatchObject({ phase: 'application', errorName: 'ApiContractError' });
  });

  test('accepts 201 creation responses and rejects conflicting replay errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'event-2',
          organization_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          site_id: '33333333-3333-4333-8333-333333333333',
          unit_id: '44444444-4444-4444-8444-444444444444',
          batch_id: 'batch-123',
          event_type: 'FEEDING',
          event_type_version: 1,
          transfer_id: null,
          transfer_role: null,
          performed_by_id: null,
          performed_at: '2026-09-24T10:00:00Z',
          data: { quantity: 1.5 },
          attachments: [],
          is_final: false,
          notes: null,
          idempotency_key: 'idem-456',
          created_at: '2026-09-24T10:00:00Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      createBatchEvent('batch-123', { event_type: 'FEEDING', data: { quantity: 1.5 } }, 'idem-456'),
    ).resolves.toMatchObject({ id: 'event-2' });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code: 'idempotency_key_payload_conflict' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      createBatchEvent('batch-123', { event_type: 'FEEDING', data: { quantity: 5 } }, 'idem-456'),
    ).rejects.toMatchObject({ phase: 'http', status: 409 });
  });

  test('supports server-authoritative projections and transfer destinations', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          batch_id: 'batch-123',
          initial_stocked_quantity: 1000,
          cumulative_mortality: 10,
          cumulative_harvest: 0,
          cumulative_transfer_out: 0,
          cumulative_transfer_in: 0,
          estimated_remaining_population: 990,
          latest_average_weight: 2.5,
          weight_unit: 'kg',
          estimated_biomass_kg: 2475,
          total_feed_kg: 12.5,
          survival_rate: 0.99,
          batch_age_days: 14,
          latest_water_quality: { dissolved_oxygen: 8 },
          latest_sampling_at: '2026-09-23T00:00:00Z',
          computed_at: '2026-09-24T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'dest-batch-1', unit_id: 'unit-2', label: 'Destination Unit' },
          { id: 'dest-batch-2', unit_id: 'unit-3', label: 'Second Unit' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const projections = await getBatchProjections('batch-123');
    expect(projections.estimated_remaining_population).toBe(990);

    const transfers = await listTransferDestinations('batch-123');
    expect(transfers[0]).toMatchObject({ id: 'dest-batch-1', label: 'Destination Unit' });
  });

  test('accepts nullable survival rates for empty planned batches and rejects malformed values', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          batch_id: 'batch-empty',
          initial_stocked_quantity: 0,
          cumulative_mortality: 0,
          cumulative_harvest: 0,
          cumulative_transfer_out: 0,
          cumulative_transfer_in: 0,
          estimated_remaining_population: 0,
          latest_average_weight: null,
          weight_unit: 'kg',
          estimated_biomass_kg: 0,
          total_feed_kg: 0,
          survival_rate: null,
          batch_age_days: 0,
          latest_water_quality: null,
          latest_sampling_at: null,
          computed_at: '2026-09-24T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(getBatchProjections('batch-empty')).resolves.toMatchObject({
      survival_rate: null,
      batch_id: 'batch-empty',
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          batch_id: 'batch-bad-survival',
          initial_stocked_quantity: 0,
          cumulative_mortality: 0,
          cumulative_harvest: 0,
          cumulative_transfer_out: 0,
          cumulative_transfer_in: 0,
          estimated_remaining_population: 0,
          latest_average_weight: null,
          weight_unit: 'kg',
          estimated_biomass_kg: 0,
          total_feed_kg: 0,
          survival_rate: 'not-a-number',
          batch_age_days: 0,
          latest_water_quality: null,
          latest_sampling_at: null,
          computed_at: '2026-09-24T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(getBatchProjections('batch-bad-survival')).rejects.toMatchObject({
      phase: 'application',
      errorName: 'ApiContractError',
    });
  });

  test('validates site creation and organization listing payloads at runtime', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'org-1', slug: 'demo-org', name: 'Demo Org' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const orgs = await listOrganizations();
    expect(orgs[0]).toMatchObject({ id: 'org-1' });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'site-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      createProductionSite('farm-1', {
        name: 'Main Site',
        code: 'MAIN',
        description: 'Primary site',
        status: 'active',
      } as any),
    ).resolves.toMatchObject({ id: 'site-1' });
  });

  test('captures contract and application errors from upstream payloads', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(listOrganizations()).rejects.toMatchObject({
      phase: 'http',
      status: 403,
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(listTransferDestinations('missing-batch')).rejects.toMatchObject({
      phase: 'http',
      status: 404,
    });
  });

  test('instance method contract error is thrown for malformed success payloads', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: '123' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(listBatchEvents('batch-123', { limit: 20 })).rejects.toBeInstanceOf(ApiFailure);
  });
});
