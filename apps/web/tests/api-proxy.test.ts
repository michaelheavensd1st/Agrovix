import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUpstreamUrl, normalizeProxyTarget, proxyApiRequest } from '@/lib/api-proxy';

const TARGET = 'https://api.example.test';

function context(path: string[] = []) {
  return { params: Promise.resolve({ path }) };
}

function request(path = '/api-proxy/v1/items', init: RequestInit = {}) {
  return new Request(`https://web.example.test${path}`, init);
}

function upstreamResponse(
  body: BodyInit | null,
  init: ResponseInit = {},
  cookies: string[] = [],
) {
  const response = new Response(body, init);
  Object.defineProperty(response.headers, 'getSetCookie', { value: () => cookies });
  return response;
}

function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [];
}

describe('API proxy target and path validation', () => {
  it.each([
    [undefined, 'http://127.0.0.1:8000'],
    ['http://api:8000/', 'http://api:8000'],
    ['http://api:8000///', 'http://api:8000'],
    [TARGET, TARGET],
  ])('normalizes %j', (value, expected) => {
    expect(normalizeProxyTarget(value)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    ' https://api.example.test',
    '/api',
    'ftp://api.example.test',
    'https://api.example.test/api',
    'https://user:secret@api.example.test',
    'https://api.example.test?debug=1',
    'https://api.example.test#fragment',
  ])('rejects invalid target %j', (value) => {
    expect(() => normalizeProxyTarget(value)).toThrow(/API_PROXY_TARGET/);
  });

  it('maps the browser path to /api and preserves duplicate query parameters', () => {
    const upstream = buildUpstreamUrl(
      request('/api-proxy/v1/items?tag=a&tag=b&empty='),
      ['v1', 'items'],
      TARGET,
    );
    expect(upstream.href).toBe(`${TARGET}/api/v1/items?tag=a&tag=b&empty=`);
  });

  it.each([
    [['..'], '/api-proxy/..'],
    [['.'], '/api-proxy/.'],
    [['a/b'], '/api-proxy/a%2Fb'],
    [['a\\b'], '/api-proxy/a%5Cb'],
    [['bad\u0000path'], '/api-proxy/bad'],
  ])('rejects malformed segment %j', (segments, url) => {
    expect(() => buildUpstreamUrl(request(url), segments, TARGET)).toThrow('Malformed proxy path');
  });

  it.each(['/api-proxy/a%2fb', '/api-proxy/a%5Cb'])(
    'rejects encoded path separators in %s',
    (url) => {
      expect(() => buildUpstreamUrl(request(url), ['a', 'b'], TARGET)).toThrow(
        'Malformed proxy path',
      );
    },
  );
});

describe('API proxy transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.API_PROXY_TARGET;
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'forwards %s',
    async (method) => {
      process.env.API_PROXY_TARGET = TARGET;
      const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const hasBody = !['GET', 'HEAD'].includes(method);

      await proxyApiRequest(
        request('/api-proxy/v1/items', {
          method,
          body: hasBody ? new Uint8Array([1, 2, 3]) : undefined,
        }),
        context(['v1', 'items']),
      );

      expect(fetchMock.mock.calls[0][1].method).toBe(method);
      if (hasBody) expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(ReadableStream);
      else expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    },
  );

  it('forwards the exact mapped URL and an empty mutation body', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await proxyApiRequest(
      request('/api-proxy/v1/items?tag=a&tag=b', { method: 'POST' }),
      context(['v1', 'items']),
    );

    expect(fetchMock.mock.calls[0][0].href).toBe(`${TARGET}/api/v1/items?tag=a&tag=b`);
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('passes JSON and binary request bodies without parsing', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const captured: Uint8Array[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        captured.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
        return upstreamResponse('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );

    await proxyApiRequest(
      request('/api-proxy/v1/items', { method: 'POST', body: JSON.stringify({ value: 1 }) }),
      context(['v1', 'items']),
    );
    await proxyApiRequest(
      request('/api-proxy/v1/items', { method: 'POST', body: new Uint8Array([0, 1, 255]) }),
      context(['v1', 'items']),
    );

    expect(new TextDecoder().decode(captured[0])).toBe('{"value":1}');
    expect(captured[1]).toEqual(new Uint8Array([0, 1, 255]));
  });

  it('forwards application headers and strips transport and platform headers', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await proxyApiRequest(
      request('/api-proxy/v1/items', {
        headers: {
          Authorization: 'Bearer token',
          Cookie: 'agrovix_access=access',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'operation-1',
          Host: 'attacker.example',
          Connection: 'keep-alive',
          'Content-Length': '99',
          'X-Forwarded-For': '192.0.2.1',
          'X-Vercel-Test': 'secret',
          'CF-Connecting-IP': '192.0.2.2',
        },
      }),
      context(['v1', 'items']),
    );

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('cookie')).toBe('agrovix_access=access');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('idempotency-key')).toBe('operation-1');
    for (const name of [
      'host',
      'connection',
      'content-length',
      'x-forwarded-for',
      'x-vercel-test',
      'cf-connecting-ip',
    ]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it.each([201, 400, 503])('preserves upstream status %s and response body', async (status) => {
    process.env.API_PROXY_TARGET = TARGET;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        upstreamResponse(`status-${status}`, {
          status,
          headers: { 'content-type': 'text/plain', connection: 'close', 'content-length': '10' },
        }),
      ),
    );

    const response = await proxyApiRequest(request(), context(['v1', 'items']));
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(`status-${status}`);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.has('connection')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
  });

  it('preserves an empty upstream response', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstreamResponse(null, { status: 204 })));
    const response = await proxyApiRequest(request(), context(['v1', 'items']));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('preserves separate authentication and deletion Set-Cookie headers and their attributes', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const cookies = [
      'agrovix_access=access; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=lax',
      'agrovix_refresh=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=lax',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstreamResponse('{}', {}, cookies)));

    const response = await proxyApiRequest(request(), context(['v1', 'auth', 'login']));
    expect(responseCookies(response)).toEqual(cookies);
    expect(responseCookies(response)[0]).toContain('HttpOnly; Secure; SameSite=lax');
    expect(responseCookies(response)[1]).toContain('Max-Age=0; Expires=Thu, 01 Jan 1970');
  });

  it('returns a sanitized 502 when the upstream transport fails', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND secret')));
    const response = await proxyApiRequest(request(), context(['v1', 'items']));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: 'Upstream API unavailable.' });
  });

  it('rejects malformed paths before making an upstream request', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await proxyApiRequest(request(), context(['..']));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rewrites same-API redirects and suppresses unrelated redirect locations', async () => {
    process.env.API_PROXY_TARGET = TARGET;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        upstreamResponse(null, { status: 307, headers: { location: '/api/v1/items?next=1' } }),
      )
      .mockResolvedValueOnce(
        upstreamResponse(null, {
          status: 302,
          headers: { location: 'https://unrelated.example/collect' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const sameApi = await proxyApiRequest(request(), context(['v1', 'items']));
    const unrelated = await proxyApiRequest(request(), context(['v1', 'items']));
    expect(sameApi.headers.get('location')).toBe('/api-proxy/v1/items?next=1');
    expect(unrelated.status).toBe(302);
    expect(unrelated.headers.has('location')).toBe(false);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });
});
