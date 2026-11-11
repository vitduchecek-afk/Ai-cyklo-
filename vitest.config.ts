import { defineConfig } from 'vitest/config';

const live = process.env.TRAILPACK_LIVE_TESTS === '1';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'apps/mobile/test/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          exclude: ['**/*.live.test.ts', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 20000,
        },
      },
      {
        test: {
          name: 'live',
          include: live ? ['packages/*/test/**/*.live.test.ts', 'tests/live/**/*.live.test.ts'] : ['tests/live/__none__'],
          environment: 'node',
          testTimeout: 90000,
          passWithNoTests: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
