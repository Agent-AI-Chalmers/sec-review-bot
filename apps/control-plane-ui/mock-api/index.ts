import type { Plugin } from 'vite'

import { createMockApiRouter } from './router.js'

/** Serve representative application states without Review Runs, Memory Catalog, or the BFF. */
export function mockApi(): Plugin {
  return {
    name: 'control-plane-ui-mock-api',
    configureServer(server): void {
      const handle = createMockApiRouter()
      server.middlewares.use((request, response, next) => {
        void handle(request, response, next).catch(next)
      })
    }
  }
}
