import type { ReviewRunStore } from './review-store.js'
import type { OperationHandlers } from './route-handlers.js'
import type { PathParams, RequestBody } from './route-types.js'

export function buildAdminRouteHandlers(
  store: ReviewRunStore
): OperationHandlers {
  return {
    listParkedRuns: async () => ({
      blocks: await store.listParkedRuns()
    }),

    abandonBlockedPreparation: async (request) => {
      const { runId } =
        request.params as PathParams<'abandonBlockedPreparation'>
      const { reason } =
        request.body as RequestBody<'abandonBlockedPreparation'>
      return await store.abandonBlockedPreparation(runId, reason)
    },

    giveUpDisconnectedRun: async (request) => {
      const { runId } = request.params as PathParams<'giveUpDisconnectedRun'>
      const { reason } = request.body as RequestBody<'giveUpDisconnectedRun'>
      return await store.giveUpDisconnectedRun(runId, reason)
    },

    resumeDisconnectedRun: async (request) => {
      const { runId } = request.params as PathParams<'resumeDisconnectedRun'>
      return await store.resumeDisconnectedRun(runId)
    }
  }
}
