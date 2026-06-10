import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser integration tests share one chromium instance per file;
    // run files sequentially to keep resource usage predictable on CI.
    fileParallelism: false,
  },
});
