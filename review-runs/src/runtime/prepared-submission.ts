// Owns the narrow uncertainty boundary around Execution submission: persist the
// replayable request before sending it, then commit the durable queued state.
import type { ReviewRunWorkflow } from '../contracts.js'
import type { ReviewRunStore } from '../persistence/review-store.js'
import { ExecutionSubmissionUncertainError } from '../execution-client.js'
import { SUBMISSION_STATE_UNCERTAIN } from '../errors.js'

type Store = Pick<
  ReviewRunStore,
  'getRun' | 'savePreparedSubmission' | 'markQueued'
> & {
  // Submission only needs best-effort terminal cleanup; callers may provide a
  // narrow test double without observing the retry outcome.
  failPreparation: (
    runId: string,
    token: string,
    error: { code?: string | null; message: string }
  ) => Promise<void | { retry_scheduled: boolean }>
}

/** Persists the replayable request before crossing the Execution uncertainty boundary. */
export async function submitPreparedRun(
  store: Store,
  args: {
    runId: string
    preparationToken: string
    publishContext: Record<string, unknown>
    input: Record<string, unknown>
  },
  submit: (request: {
    workflow: ReviewRunWorkflow
    run_id: string
    input: Record<string, unknown>
  }) => Promise<unknown>
): Promise<{
  run_id: string
  workflow: ReviewRunWorkflow
  status: 'queued'
}> {
  const run = await store.getRun(args.runId)
  if (run === null)
    throw Object.assign(new Error(`Review run does not exist: ${args.runId}`), {
      code: 'REVIEW_RUN_NOT_FOUND'
    })
  let executionAccepted = false
  try {
    await store.savePreparedSubmission(
      args.runId,
      args.preparationToken,
      args.publishContext,
      args.input
    )
    await submit({
      workflow: run.workflow,
      run_id: args.runId,
      input: args.input
    })
    executionAccepted = true
    await store.markQueued(
      args.runId,
      args.preparationToken,
      args.publishContext
    )
    return { run_id: args.runId, workflow: run.workflow, status: 'queued' }
  } catch (error) {
    try {
      await store.failPreparation(args.runId, args.preparationToken, {
        code:
          executionAccepted ||
          error instanceof ExecutionSubmissionUncertainError
            ? SUBMISSION_STATE_UNCERTAIN
            : error instanceof Error &&
                'code' in error &&
                typeof error.code === 'string'
              ? error.code
              : 'REVIEW_START_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
    } catch {
      // Preserve the original submission error when best-effort cleanup also fails.
    }
    throw error
  }
}
