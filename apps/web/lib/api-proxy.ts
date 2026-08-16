const DEFAULT_PROXY_TARGET = 'http://127.0.0.1:8000';

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'range',
  'referer',
  'user-agent',
  'x-request-id',
]);

const RESPONSE_HEADERS_TO_STRIP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

type RouteContext = { params: Promise<{ path?: string[] }> };
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

export function normalizeProxyTarget(rawTarget: string | undefined): string {
  const configured = rawTarget === undefined ? DEFAULT_PROXY_TARGET : rawTarget;
  if (!configured || configured.trim() !== configured) {
    throw new Error(
      'API_PROXY_TARGET must be a non-empty absolute HTTP(S) origin without whitespace.',
    );
  }

  const candidate = configured.replace(/\/+$/, '');
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    throw new Error('API_PROXY_TARGET must be a valid absolute HTTP(S) origin.');
  }

  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== '/'
  ) {
    throw new Error(
      'API_PROXY_TARGET must be an HTTP(S) origin without credentials, path, query, or fragment.',
    );
  }

  return target.origin;
}

function validatePath(request: Request, segments: string[]): void {
  const rawPath = new URL(request.url).pathname;
  if (ENCODED_PATH_SEPARATOR.test(rawPath)) {
    throw new Error('Malformed proxy path.');
  }

  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      CONTROL_CHARACTER.test(segment)
    ) {
      throw new Error('Malformed proxy path.');
    }
  }
}

export function buildUpstreamUrl(
  request: Request,
  segments: string[],
  rawTarget: string | undefined = process.env.API_PROXY_TARGET,
): URL {
  validatePath(request, segments);
  const target = normalizeProxyTarget(rawTarget);
  const suffix = segments.map(encodeURIComponent).join('/');
  const upstream = new URL(suffix ? `/api/${suffix}` : '/api/', target);
  upstream.search = new URL(request.url).search;
  return upstream;
}

function requestHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) {
    if (REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) forwarded.append(name, value);
  }
  return forwarded;
}

function responseHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) {
    if (!RESPONSE_HEADERS_TO_STRIP.has(name.toLowerCase())) forwarded.append(name, value);
  }
  return forwarded;
}

function setCookieValues(headers: HeadersWithSetCookie): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

function rewriteLocation(location: string, upstream: URL, targetOrigin: string): string | null {
  let destination: URL;
  try {
    destination = new URL(location, upstream);
  } catch {
    return null;
  }

  if (destination.origin !== targetOrigin || !destination.pathname.startsWith('/api/')) return null;
  return `/api-proxy/${destination.pathname.slice('/api/'.length)}${destination.search}${destination.hash}`;
}

export async function proxyApiRequest(request: Request, context: RouteContext): Promise<Response> {
  let upstream: URL;
  let targetOrigin: string;
  try {
    const { path = [] } = await context.params;
    targetOrigin = normalizeProxyTarget(process.env.API_PROXY_TARGET);
    upstream = buildUpstreamUrl(request, path, targetOrigin);
  } catch {
    return Response.json({ detail: 'Invalid API proxy configuration or path.' }, { status: 400 });
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, {
      method,
      headers: requestHeaders(request.headers),
      body: hasBody ? request.body : undefined,
      cache: 'no-store',
      redirect: 'manual',
      ...(hasBody ? { duplex: 'half' as const } : {}),
    });
  } catch {
    return Response.json({ detail: 'Upstream API unavailable.' }, { status: 502 });
  }

  const headers = responseHeaders(upstreamResponse.headers);
  for (const cookie of setCookieValues(upstreamResponse.headers as HeadersWithSetCookie)) {
    headers.append('set-cookie', cookie);
  }

  const location = upstreamResponse.headers.get('location');
  if (location) {
    const safeLocation = rewriteLocation(location, upstream, targetOrigin);
    if (safeLocation === null) headers.delete('location');
    else headers.set('location', safeLocation);
  }

  return new Response(method === 'HEAD' ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
