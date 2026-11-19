import type { Plugin } from 'vite'

import { createMockApiRouter } from './router.js'

/** Serve representative application states without Review Runs, Memory Catalog, or the BFF. */
export function mockApi(): Plugin {
  return {
    name: 'control-plane-ui-mock-api',
    configureServer(server): void {
      const configuredNow = process.env.CONTROL_PLANE_UI_MOCK_API_NOW
      const fixedNow = configuredNow === undefined ? undefined : Date.parse(configuredNow)
      if (fixedNow !== undefined && !Number.isFinite(fixedNow)) {
        throw new Error('CONTROL_PLANE_UI_MOCK_API_NOW must be a valid date.')
      }
      const now = fixedNow === undefined ? Date.now : () => fixedNow
      const handle = createMockApiRouter(now)
      server.middlewares.use((request, response, next) => {
        void handle(request, response, next).catch(next)
      })
    }
  }
}
