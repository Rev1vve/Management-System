import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library auto-cleanup only runs when vitest `globals` is enabled;
// register it explicitly so renders don't leak between tests.
afterEach(() => {
  cleanup();
});
