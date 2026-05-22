import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      // Loaded explicitly via process.loadEnvFile in setup; this is the fallback.
      NODE_ENV: 'test',
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
