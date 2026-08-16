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
type DiagnosticCategory =
  | 'dns_resolution'
  | 'connection_refused'
  | 'network_unreachable'
  | 'tls_handshake'
  | 'timeout'
  | 'other';

const SAFE_ERROR_NAMES = new Set(['AbortError', 'Error', 'TimeoutError', 'TypeError']);
const SAFE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type ErrorRecord = Record<string, unknown>;

export type SafeFetchDiagnostic = {
  event: 'api_proxy.fetch_failed';
  targetConfigured: true;
  category: DiagnosticCategory;
  errorName: string;
  errorCode?: string;
  causeCode?: string;
  syscallCategory?: 'dns' | 'connect' | 'read' | 'write' | 'other';
};

function record(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

function safeProperty(value: unknown, property: string): unknown {
  try {
    return record(value)?.[property];
  } catch {
    return undefined;
  }
}

function safeCode(value: unknown): string | undefined {
  const code = safeProperty(value, 'code');
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : undefined;
}

function nestedErrors(value: unknown): unknown[] {
  const errors = safeProperty(value, 'errors');
  return Array.isArray(errors) ? errors.slice(0, 8) : [];
}

function categoryFor(codes: Array<string | undefined>, errorName: string): DiagnosticCategory {
  if (codes.includes('ENOTFOUND')) return 'dns_resolution';
  if (codes.includes('ECONNREFUSED')) return 'connection_refused';
  if (codes.some((code) => code === 'ENETUNREACH' || code === 'EHOSTUNREACH')) {
    return 'network_unreachable';
  }
  if (
    codes.some(
      (code) =>
        code?.includes('CERT') ||
        code?.includes('TLS') ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    )
  ) {
    return 'tls_handshake';
  }
  if (
    errorName === 'AbortError' ||
    errorName === 'TimeoutError' ||
    codes.some((code) => code === 'ETIMEDOUT' || code?.includes('TIMEOUT'))
  ) {
    return 'timeout';
  }
  return 'other';
}

function safeSyscallCategory(value: unknown): SafeFetchDiagnostic['syscallCategory'] {
  const syscall = safeProperty(value, 'syscall');
  if (typeof syscall !== 'string') return undefined;
  if (syscall === 'getaddrinfo' || syscall === 'getnameinfo') return 'dns';
  if (syscall === 'connect') return 'connect';
  if (syscall === 'read') return 'read';
  if (syscall === 'write') return 'write';
  return 'other';
}

export function safeFetchDiagnostic(error: unknown): SafeFetchDiagnostic {
  const rawName = safeProperty(error, 'name');
  const errorName =
    typeof rawName === 'string' && SAFE_ERROR_NAMES.has(rawName) ? rawName : 'OtherError';
  const cause = safeProperty(error, 'cause');
  const candidates = [cause, ...nestedErrors(cause)];
  const errorCode = safeCode(error);
  const causeCode = candidates.map(safeCode).find((code) => code !== undefined);
  const syscallCategory = candidates
    .map(safeSyscallCategory)
    .find((category) => category !== undefined);

  return {
    event: 'api_proxy.fetch_failed',
    targetConfigured: true,
    category: categoryFor(
      [errorCode, ...candidates.map(safeCode)],
      errorName,
    ),
    errorName,
    ...(errorCode ? { errorCode } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(syscallCategory ? { syscallCategory } : {}),
  };
}

export function normalizeProxyTarget(rawTarget: string | undefined): string {
  const configured = rawTarget;
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
  const rawTarget = process.env.API_PROXY_TARGET;
  if (rawTarget === undefined) {
    console.error({ event: 'api_proxy.configuration_missing', targetConfigured: false });
    return Response.json({ detail: 'Upstream API unavailable.' }, { status: 502 });
  }

  let upstream: URL;
  let targetOrigin: string;
  try {
    const { path = [] } = await context.params;
    targetOrigin = normalizeProxyTarget(rawTarget);
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
  } catch (error) {
    console.error(safeFetchDiagnostic(error));
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
