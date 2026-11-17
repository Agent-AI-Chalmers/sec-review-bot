import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 3,
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
