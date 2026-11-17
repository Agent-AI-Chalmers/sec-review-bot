import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
    maxWorkers: 3,
    testTimeout: 30_000
  }
})
