/** @jest-environment node */

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiUrl: 'http://localhost:8000/api' } },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('./secure-storage', () => ({
  setTokens: jest.fn(),
  clearTokens: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('token-123'),
  getRefreshToken: jest.fn().mockResolvedValue('refresh-123'),
}));

import { createBatchEvent } from './production-api';

describe('production event request timestamps', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'event-1',
          organization_id: '11111111-1111-4111-8111-111111111111',
          farm_id: '22222222-2222-4222-8222-222222222222',
          site_id: '33333333-3333-4333-8333-333333333333',
          unit_id: '44444444-4444-4444-8444-444444444444',
          batch_id: 'batch-123',
          event_type: 'SAMPLING',
          event_type_version: 2,
          transfer_id: null,
          transfer_role: null,
          performed_by_id: null,
          performed_at: '2026-10-02T08:30:00.000Z',
          data: { sample_size: 30, average_weight: 4.8, weight_unit: 'g' },
          attachments: null,
          is_final: false,
          notes: null,
          created_at: '2026-10-02T08:31:00.000Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  test('sends performed_at at the event envelope top level', async () => {
    const performedAt = '2026-10-02T08:30:00.000Z';
    await createBatchEvent(
      'batch-123',
      { event_type: 'SAMPLING', performed_at: performedAt, data: { sample_size: 30 } },
      'sampling-key',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      event_type: 'SAMPLING',
      performed_at: performedAt,
      data: { sample_size: 30 },
    });
  });

  test('omits performed_at for existing callers that do not supply it', async () => {
    await createBatchEvent(
      'batch-123',
      { event_type: 'FEEDING', data: { quantity: 1 } },
      'feed-key',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      event_type: 'FEEDING',
      data: { quantity: 1 },
    });
  });
});
