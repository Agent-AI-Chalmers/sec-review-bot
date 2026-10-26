import type { Plugin } from 'vite'

import { createFixtureRouter } from './router.js'

/** Serve representative application states without Review Runs, Memory Catalog, or the BFF. */
export function devFixtures(): Plugin {
  return {
    name: 'control-plane-ui-dev-fixtures',
    configureServer(server): void {
      server.middlewares.use(createFixtureRouter())
    }
  }
}
