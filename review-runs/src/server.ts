// Process entry point and compatibility export for the Review Runs HTTP surface.
export {
  REVIEW_RUNS_FASTIFY_OPTIONS,
  registerReviewRunsRoutes
} from './http/server-surface.js'
export { startReviewRunsServer } from './runtime/server-runtime.js'

import { startReviewRunsServer } from './runtime/server-runtime.js'

if (process.env.NODE_ENV !== 'test') {
  const running = await startReviewRunsServer()
  const shutdown = async (): Promise<void> => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })
}
