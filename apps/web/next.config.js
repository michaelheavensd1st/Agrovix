/** @type {import('next').NextConfig} */

function normalizeProxyTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.trim() !== rawTarget) {
    throw new Error(
      'API_PROXY_TARGET must be a non-empty absolute HTTP(S) origin without whitespace.',
    );
  }

  const candidate = rawTarget.replace(/\/+$/, '');
  let target;
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

const API_PROXY_TARGET = normalizeProxyTarget(
  process.env.API_PROXY_TARGET === undefined
    ? 'http://127.0.0.1:8000'
    : process.env.API_PROXY_TARGET,
);

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@agrovix/ui', '@agrovix/types', '@agrovix/validation', '@agrovix/utils'],
  experimental: {
    typedRoutes: false,
  },

  async rewrites() {
    return [
      {
        source: '/api-proxy/:path*',
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
