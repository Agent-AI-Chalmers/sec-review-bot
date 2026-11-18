import type { ReviewRunRecord } from '../persistence/review-run-store.js'

type SubmissionError = { code?: string | null; message: string }

interface SubmissionRecoveryStore {
  executions: {
    claimSubmissionRecovery(runId: string, maxUnresolvedRecoveries: number): Promise<string | null>
    disconnectExhaustedSubmissionRecovery(
      runId: string,
      maxUnresolvedRecoveries: number
    ): Promise<boolean>
    recordUnknownRecoveryOutcome(runId: string, token: string): Promise<boolean>
  }
  submissionTransitions: {
    completeSubmissionRecovery(runId: string, token: string): Promise<boolean>
    failSubmissionRecovery(runId: string, token: string, error: SubmissionError): Promise<boolean>
  }
}

export type SubmissionRecoveryResult =
  | { outcome: 'claim_unavailable' }
  | { outcome: 'input_missing' }
  | { outcome: 'recovered' }
  | { outcome: 'claim_lost' }
  | { outcome: 'deferred'; error: unknown }
  | { outcome: 'disconnected' }
  | { outcome: 'failed'; error: unknown }

/** Stop automatic submission recovery after this many replays still have an unknown outcome. */
export const MAX_UNRESOLVED_SUBMISSION_RECOVERIES = 8

export interface SubmissionRecoveryDependencies {
  submit: (request: {
    workflow: ReviewRunRecord['workflow']
    run_id: string
    input: Record<string, unknown>
  }) => Promise<unknown>
  classifyError: (error: unknown) => SubmissionError & { uncertain: boolean }
}

/** Process one pending submission recovery, including its budget and ownership checks.
 * Execution owns request idempotency; Review Runs records the accepted or unresolved outcome.
 */
export async function recoverReviewRunSubmission(
  store: SubmissionRecoveryStore,
  run: ReviewRunRecord,
  dependencies: SubmissionRecoveryDependencies
): Promise<SubmissionRecoveryResult> {
  if (
    await store.executions.disconnectExhaustedSubmissionRecovery(
      run.run_id,
      MAX_UNRESOLVED_SUBMISSION_RECOVERIES
    )
  ) {
    return { outcome: 'disconnected' }
  }

  // Claiming also checks the budget atomically: another owner may have spent it since the
  // disconnect check. A live lease or changed state makes either operation a no-op.
  const claimToken = await store.executions.claimSubmissionRecovery(
    run.run_id,
    MAX_UNRESOLVED_SUBMISSION_RECOVERIES
  )
  if (claimToken === null) {
    return { outcome: 'claim_unavailable' }
  }

  if (run.execution_input === undefined) {
    const recorded = await store.submissionTransitions.failSubmissionRecovery(
      run.run_id,
      claimToken,
      {
        code: 'SUBMISSION_RECOVERY_INPUT_MISSING',
        message: 'The persisted Execution input is missing; this submission cannot be recovered.'
      }
    )
    return { outcome: recorded ? 'input_missing' : 'claim_lost' }
  }

  try {
    await dependencies.submit({
      workflow: run.workflow,
      run_id: run.run_id,
      input: run.execution_input
    })
  } catch (error) {
    const classified = dependencies.classifyError(error)
    if (classified.uncertain) {
      // Only an unknown replay result spends this budget. Keep the lease to pace the next replay.
      const recorded = await store.executions.recordUnknownRecoveryOutcome(run.run_id, claimToken)
      return recorded ? { outcome: 'deferred', error } : { outcome: 'claim_lost' }
    }
    const recorded = await store.submissionTransitions.failSubmissionRecovery(
      run.run_id,
      claimToken,
      { code: classified.code ?? null, message: classified.message }
    )
    return recorded ? { outcome: 'failed', error } : { outcome: 'claim_lost' }
  }
  // A local commit failure cannot establish that the accepted remote submission failed.
  return (await store.submissionTransitions.completeSubmissionRecovery(run.run_id, claimToken))
    ? { outcome: 'recovered' }
    : { outcome: 'claim_lost' }
}
