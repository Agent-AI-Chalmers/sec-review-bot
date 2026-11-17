import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: 3,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**']
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts']
        }
      }
    ]
  }
})
