import type { ReviewRunRecord } from '../persistence/review-run-store.js'

type SubmissionError = { code?: string | null; message: string }

interface SubmissionRecoveryStore {
  executions: {
    claimSubmissionRecovery(runId: string): Promise<string | null>
    submissionRecoveryAttemptCount(runId: string): Promise<number | null>
    disconnectExhaustedSubmissionRecovery(
      runId: string,
      maxAttempts: number
    ): Promise<boolean>
    recordUnknownRecoveryOutcome(runId: string, token: string): Promise<boolean>
  }
  submissionTransitions: {
    completeSubmissionRecovery(runId: string, token: string): Promise<boolean>
    failSubmissionRecovery(
      runId: string,
      token: string,
      error: SubmissionError
    ): Promise<boolean>
  }
}

export type SubmissionRecoveryResult =
  | { status: 'claim_unavailable' }
  | { status: 'input_missing' }
  | { status: 'recovered' }
  | { status: 'claim_lost' }
  | { status: 'deferred'; error: unknown }
  | { status: 'disconnected' }
  | { status: 'failed'; error: unknown }

/** How many replays may end with the outcome still unknown before automation disconnects.
 *
 * Mirrors `MAX_PREPARATION_ATTEMPTS`: the point is not a particular number, it is that a number
 * exists. The bound limits automatic external traffic; it is not evidence about whether the
 * Execution accepted a prior request. */
export const MAX_SUBMISSION_RECOVERY_ATTEMPTS = 8

/** The code recorded when the replay budget stops automatic recovery. */
export const SUBMISSION_RECOVERY_EXHAUSTED = 'SUBMISSION_RECOVERY_EXHAUSTED'

export interface SubmissionRecoveryDependencies {
  submit: (request: {
    workflow: ReviewRunRecord['workflow']
    run_id: string
    input: Record<string, unknown>
  }) => Promise<unknown>
  classifyError: (error: unknown) => SubmissionError & { uncertain: boolean }
}

/**
 * Replays the persisted request with the original run identity. Execution owns
 * request idempotency; Review Runs owns the recovery claim and durable state.
 */
export async function recoverReviewRunSubmission(
  store: SubmissionRecoveryStore,
  run: ReviewRunRecord,
  dependencies: SubmissionRecoveryDependencies
): Promise<SubmissionRecoveryResult> {
  const claimToken = await store.executions.claimSubmissionRecovery(run.run_id)
  if (claimToken === null) return { status: 'claim_unavailable' }

  if (run.execution_input === undefined) {
    await store.submissionTransitions.failSubmissionRecovery(
      run.run_id,
      claimToken,
      {
        code: 'SUBMISSION_RECOVERY_INPUT_MISSING',
        message:
          'The persisted Execution input is missing; this submission cannot be recovered.'
      }
    )
    return { status: 'input_missing' }
  }

  try {
    await dependencies.submit({
      workflow: run.workflow,
      run_id: run.run_id,
      input: run.execution_input
    })
    return (await store.submissionTransitions.completeSubmissionRecovery(
      run.run_id,
      claimToken
    ))
      ? { status: 'recovered' }
      : { status: 'claim_lost' }
  } catch (error) {
    const classified = dependencies.classifyError(error)
    if (classified.uncertain) {
      // The replay's outcome is unknown, which is exactly what `uncertain` already means: the
      // Execution may have accepted it, so nothing may be concluded. Counting the attempt only
      // bounds automatic recovery; exhaustion moves the run to disconnected, never failed.
      await store.executions.recordUnknownRecoveryOutcome(
        run.run_id,
        claimToken
      )
      return { status: 'deferred', error }
    }
    await store.submissionTransitions.failSubmissionRecovery(
      run.run_id,
      claimToken,
      {
        code: classified.code ?? null,
        message: classified.message
      }
    )
    return { status: 'failed', error }
  }
}

/** Disconnect an uncertain run whose replays keep ending unknown.
 *
 * Called before replaying, so the budget is enforced by the row itself rather than inferred from
 * whatever the caller just read. A row that is not over budget — or that another owner has claimed
 * since — leaves this a no-op and the normal replay path proceeds. */
export async function concludeExhaustedSubmissionRecovery(
  store: SubmissionRecoveryStore,
  run: ReviewRunRecord
): Promise<SubmissionRecoveryResult | null> {
  const attempts = await store.executions.submissionRecoveryAttemptCount(
    run.run_id
  )
  if (attempts === null || attempts < MAX_SUBMISSION_RECOVERY_ATTEMPTS)
    return null
  const disconnected =
    await store.executions.disconnectExhaustedSubmissionRecovery(
      run.run_id,
      MAX_SUBMISSION_RECOVERY_ATTEMPTS
    )
  return disconnected ? { status: 'disconnected' } : null
}
