import type { ReviewRunStore } from '../persistence/review-run-store.js'
import type { OperationHandlers } from './route-handlers.js'

export function buildAdminRouteHandlers(store: ReviewRunStore) {
  return {
    listParkedRuns: async () => ({
      blocks: await store.queries.listParkedRuns()
    }),

    abandonBlockedPreparation: async (request) => {
      const { runId } = request.params
      const { reason } = request.body
      return await store.operatorDecisions.abandonBlockedPreparation(
        runId,
        reason
      )
    },

    giveUpDisconnectedRun: async (request) => {
      const { runId } = request.params
      const { reason } = request.body
      return await store.operatorDecisions.giveUpDisconnectedRun(runId, reason)
    },

    resumeDisconnectedRun: async (request) => {
      const { runId } = request.params
      return await store.operatorDecisions.resumeDisconnectedRun(runId)
    }
  } satisfies Partial<OperationHandlers>
}
