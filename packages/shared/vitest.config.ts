import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `dist` holds the compiled copy of this same source. Without this, every
    // test would be discovered and run twice — once as TypeScript, once as its
    // own build output.
    include: ['src/**/*.test.ts'],
  },
});
