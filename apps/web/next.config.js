/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@agrovix/ui', '@agrovix/types', '@agrovix/validation', '@agrovix/utils'],
  experimental: {
    typedRoutes: false,
  },
};

module.exports = nextConfig;
