import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sprint 5.3: unmount React trees between tests so a fan-out
// callback still in flight from the previous test's mocked
// apiFetch cannot observe the next test's reset mock and throw
// unhandled rejections.
afterEach(() => {
  cleanup();
});
