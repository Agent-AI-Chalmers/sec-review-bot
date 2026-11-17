import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test.mjs'],
    testTimeout: 30_000
  }
})
