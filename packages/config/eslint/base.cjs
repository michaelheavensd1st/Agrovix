/** Shared ESLint base preset for all TS/JS packages. */
module.exports = {
  root: false,
  env: { es2022: true, node: true, browser: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-unused-vars': 'off',
    eqeqeq: ['error', 'smart'],
  },
};
