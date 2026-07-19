/** @type {import('next').NextConfig} */

const API_PROXY_TARGET = process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000';

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
