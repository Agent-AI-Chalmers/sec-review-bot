import type { ControlPlaneWorkflow } from './contracts.js'
import type { ReviewRunStore } from './review-store.js'
import { RunnerSubmissionUncertainError } from './runner-client.js'

type Store = Pick<
  ReviewRunStore,
  'getRun' | 'save_prepared_submission' | 'mark_queued' | 'failPreparation'
>

/** Persists the replayable request before crossing the Runner uncertainty boundary. */
export async function submitPreparedRun(
  store: Store,
  args: {
    runId: string
    preparationToken: string
    publishContext: Record<string, unknown>
    input: Record<string, unknown>
  },
  submit: (request: {
    workflow: ControlPlaneWorkflow
    run_id: string
    input: Record<string, unknown>
  }) => Promise<unknown>
): Promise<{ run_id: string; workflow: ControlPlaneWorkflow; status: 'queued' }> {
  const run = await store.getRun(args.runId)
  if (run === null)
    throw Object.assign(new Error(`Review run does not exist: ${args.runId}`), {
      code: 'REVIEW_RUN_NOT_FOUND'
    })
  let runnerAccepted = false
  try {
    await store.save_prepared_submission(
      args.runId,
      args.preparationToken,
      args.publishContext,
      args.input
    )
    await submit({ workflow: run.workflow, run_id: args.runId, input: args.input })
    runnerAccepted = true
    await store.mark_queued(args.runId, args.preparationToken, args.publishContext)
    return { run_id: args.runId, workflow: run.workflow, status: 'queued' }
  } catch (error) {
    await store
      .failPreparation(args.runId, args.preparationToken, {
        code:
          runnerAccepted || error instanceof RunnerSubmissionUncertainError
            ? 'SUBMISSION_STATE_UNCERTAIN'
            : error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'REVIEW_START_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
      .catch(() => {})
    throw error
  }
}
