import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Isolate concurrent package runs (vitest-dev/vitest#11748).
    fsModuleCachePath: `${import.meta.dirname}/node_modules/.vitest-cache`,
    environment: 'node',
    include: ['test/*.test.ts'],
    testTimeout: 30_000
  }
})
