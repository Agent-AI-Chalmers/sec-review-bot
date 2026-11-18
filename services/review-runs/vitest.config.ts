import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Isolate concurrent package runs (vitest-dev/vitest#11748).
    fsModuleCachePath: `${import.meta.dirname}/node_modules/.vitest-cache`,
    restoreMocks: true,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'types',
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ['test/**/*.test-d.ts']
          }
        }
      },
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/*.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000
        }
      }
    ]
  }
})
