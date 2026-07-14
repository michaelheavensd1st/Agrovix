module.exports = {
  root: true,
  extends: ['../../.eslintrc.json'],
  ignorePatterns: ['node_modules', '.expo', 'babel.config.js'],
  overrides: [
    {
      files: ['**/*.tsx', '**/*.ts'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off'
      }
    }
  ]
};
