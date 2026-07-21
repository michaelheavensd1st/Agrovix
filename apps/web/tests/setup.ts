import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount every React tree between tests so their effects, fetch
// callbacks, and generation refs cannot leak into the next test's
// mocked apiFetch — otherwise a fan-out inflight in the previous
// test can observe the next test's reset mock.
afterEach(() => {
  cleanup();
});
