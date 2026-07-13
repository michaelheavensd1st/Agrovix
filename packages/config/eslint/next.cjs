/** Shared ESLint preset for Next.js apps (extends the base preset). */
module.exports = {
  root: false,
  extends: [require.resolve('./base.cjs'), 'next/core-web-vitals'],
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
  },
};
