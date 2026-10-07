import type { ReviewRunRecord, ReviewRunStore } from './review-store.js'

type SubmissionRecoveryStore = Pick<ReviewRunStore,
  'claimSubmissionRecovery' | 'completeSubmissionRecovery' | 'failSubmissionRecovery'>

type SubmissionError = { code?: string | null, message: string }

export type SubmissionRecoveryResult =
  | { status: 'claim_unavailable' }
  | { status: 'input_missing' }
  | { status: 'recovered' }
  | { status: 'claim_lost' }
  | { status: 'deferred', error: unknown }
  | { status: 'failed', error: unknown }

export interface SubmissionRecoveryDependencies {
  submit: (request: {
    workflow: ReviewRunRecord['workflow']
    run_id: string
    input: Record<string, unknown>
  }) => Promise<unknown>
  classifyError: (error: unknown) => SubmissionError & { uncertain: boolean }
}

/**
 * Replays the persisted request with the original run identity. Runner owns
 * request idempotency; Control Plane owns the recovery claim and durable state.
 */
export async function recoverReviewRunSubmission (
  store: SubmissionRecoveryStore,
  run: ReviewRunRecord,
  dependencies: SubmissionRecoveryDependencies
): Promise<SubmissionRecoveryResult> {
  const claimToken = await store.claimSubmissionRecovery(run.run_id)
  if (claimToken === null) return { status: 'claim_unavailable' }

  if (run.runner_input === undefined) {
    await store.failSubmissionRecovery(run.run_id, claimToken, {
      code: 'SUBMISSION_RECOVERY_INPUT_MISSING',
      message: 'The persisted Runner input is missing; this submission cannot be recovered.'
    })
    return { status: 'input_missing' }
  }

  try {
    await dependencies.submit({
      workflow: run.workflow,
      run_id: run.run_id,
      input: run.runner_input
    })
    return await store.completeSubmissionRecovery(run.run_id, claimToken)
      ? { status: 'recovered' }
      : { status: 'claim_lost' }
  } catch (error) {
    const classified = dependencies.classifyError(error)
    await store.failSubmissionRecovery(run.run_id, claimToken, {
      code: classified.code ?? null,
      message: classified.message
    })
    return classified.uncertain
      ? { status: 'deferred', error }
      : { status: 'failed', error }
  }
}
