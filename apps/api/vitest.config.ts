import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace packages (@family-todo/shared, @family-todo/tg-auth) use a
  // conditional `exports` field that points to source `.ts` under the
  // `development` condition and compiled `dist/` otherwise. Tests run
  // against source so we don't have to pre-build them.
  resolve: {
    conditions: ['development'],
  },
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
