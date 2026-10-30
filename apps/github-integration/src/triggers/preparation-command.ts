// Turning one webhook review request into a durable run.
//
// The  queue is the durable boundary: admission creates the run and the preparation
// claim, the connector prepares and submits its input, and every failure between those two
// points is recorded against the run so Review Runs can decide whether to retry it.
//
// The order is the protocol, and it was copied into each trigger: admit, stop on replay,
// require a run id and a claim, start the heartbeat, submit through the lease, and on failure
// own the decision to record it. Only the workflow, its input and the review call differ.
import { admitReviewRun } from '../review-runs/admission.js'
import {
  ReviewRunsSubmissionError,
  reviewRunsClient
} from '../review-runs/client.js'
import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../review-runs/preparation-claim.js'
import { classifyPreparationFailure } from '../review-runs/preparation-failure.js'
import { isSetupDeclarationError } from '../github/setup-declaration.js'

/**
 * The review-runs slice a webhook trigger drives.
 *
 * The return types are deliberately unions: a test double may answer synchronously, and the
 * command always awaits, so both shapes describe the same call.
 */
export interface PreparationCommandStore {
  admitReviewRun: (
    ...args: Parameters<typeof reviewRunsClient.admitReviewRun>
  ) =>
    | Awaited<ReturnType<typeof reviewRunsClient.admitReviewRun>>
    | ReturnType<typeof reviewRunsClient.admitReviewRun>
  failPreparation: (
    ...args: Parameters<typeof reviewRunsClient.failPreparation>
  ) => unknown
  submitPreparedRun: (
    ...args: Parameters<typeof reviewRunsClient.submitPreparedRun>
  ) => unknown
  renewPreparationClaim: (
    ...args: Parameters<typeof reviewRunsClient.renewPreparationClaim>
  ) => Promise<boolean>
  preparationHeartbeatIntervalMs: typeof reviewRunsClient.preparationHeartbeatIntervalMs
  /** Available only on clients that can checkpoint the connector's input mid-preparation. */
  checkpointPreparationInput?: (
    ...args: Parameters<typeof reviewRunsClient.checkpointPreparationInput>
  ) => Promise<void>
}

type SubmitPreparedRun = PreparationCommandStore['submitPreparedRun']
/** What the connector's publish context looks like once the run is submitted. */
export type PreparedPublishContext = Parameters<SubmitPreparedRun>[2]
/** The execution input the workflow prepared, as Review Runs stores it. */
export type PreparedInput = Parameters<SubmitPreparedRun>[3]

export interface PreparationAdmission {
  workflow: 'issue-review' | 'pull-request-review'
  /** The delivery identity that makes a redelivered webhook replay instead of admit again. */
  ingress_key: string
  preparation_input: Record<string, unknown>
}

export interface ClaimedPreparation {
  run_id: string
  token: string
  attempt_count?: number
}

/**
 * Admit, prepare, submit — and record a preparation failure against the run that owns it.
 *
 * A webhook redelivery is answered with the run it originally admitted, so the caller must
 * treat the returned run id as either a fresh submission or a replay. `start_review` is only
 * called for a run this invocation admitted or claimed, which is what makes its side effects
 * safe to retry: the review itself is idempotent per run.
 *
 * The command never records a failure it does not own. A lost claim means another owner is
 * preparing this run, and a submission error means Review Runs already answered the boundary,
 * so in both cases writing a failure here would contradict the record.
 */
export async function runPreparationCommand<T, P>({
  store,
  admission,
  claimed_preparation,
  on_admitted,
  publish_context,
  start_review
}: {
  store: PreparationCommandStore
  admission: PreparationAdmission
  claimed_preparation?: ClaimedPreparation
  on_admitted?: (admission: {
    run_id: string
    status: string
    replayed: boolean
  }) => void
  /** How this workflow's prepared review becomes the run's publish context. */
  publish_context: (prepared: P) => PreparedPublishContext
  start_review: (context: {
    run_id: string
    on_prepared: (prepared: P, input: PreparedInput) => Promise<void>
    /** Store connector input against this claim, so a restart resumes it instead of re-resolving. */
    checkpoint: (preparation_input: Record<string, unknown>) => Promise<void>
  }) => Promise<T>
}): Promise<T | { run_id: string }> {
  const admitted =
    claimed_preparation === undefined
      ? await admitReviewRun(
          // The helper takes the client's promise-returning method; this slice accepts the
          // resolved value too, and the await above makes both the same call.
          store as Pick<typeof reviewRunsClient, 'admitReviewRun'>,
          {
            workflow: admission.workflow,
            ingress_kind: 'github_webhook',
            ingress_key: admission.ingress_key,
            preparation_input: admission.preparation_input
          }
        )
      : null
  if (admitted !== null) {
    on_admitted?.({
      run_id: admitted.run_id,
      status: admitted.status,
      replayed: !admitted.created
    })
    if (!admitted.created) return { run_id: admitted.run_id }
  }

  const run_id = claimed_preparation?.run_id ?? admitted?.run_id
  const preparationToken =
    claimed_preparation?.token ?? admitted?.preparation_token
  const preparationAttempt = claimed_preparation?.attempt_count ?? 1
  if (run_id === undefined)
    throw new Error('Preparation admission did not return a run id.')
  if (!preparationToken)
    throw new Error(
      `Newly admitted review run ${run_id} has no preparation claim.`
    )
  const heartbeat = await startPreparationClaimHeartbeat(
    store,
    run_id,
    preparationToken
  )

  try {
    return await start_review({
      run_id,
      checkpoint: async (preparation_input) => {
        if (store.checkpointPreparationInput === undefined)
          throw new Error('Preparation input checkpointing is unavailable.')
        await store.checkpointPreparationInput(
          run_id,
          preparationToken,
          preparation_input
        )
      },
      on_prepared: async (prepared, input) => {
        // Confirm the lease immediately before crossing the durable submission
        // boundary; the submission itself remains token-fenced by Review Runs.
        await heartbeat.assertOwned()
        await store.submitPreparedRun(
          run_id,
          preparationToken,
          publish_context(prepared),
          input
        )
      }
    })
  } catch (error) {
    const ownsClaim = await heartbeat.stop()
    if (
      ownsClaim &&
      !(error instanceof ReviewRunsSubmissionError) &&
      !(error instanceof PreparationClaimLostError)
    ) {
      const classification = classifyPreparationFailure(
        error,
        preparationAttempt,
        isSetupDeclarationError(error)
      )
      await store.failPreparation(
        run_id,
        preparationToken,
        {
          code: isSetupDeclarationError(error)
            ? 'SETUP_DECLARATION_INVALID'
            : 'REVIEW_START_FAILED',
          message: error instanceof Error ? error.message : String(error)
        },
        {
          retry: classification.retry,
          ...(classification.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classification.retryAfterMs })
        }
      )
    }
    throw error
  } finally {
    await heartbeat.stop()
  }
}
