/**
 * Publication-step failure codes Review Runs can emit as terminal (deterministic).
 *
 * These cross the package boundary: github-integration must classify each as `retry: false`,
 * otherwise a new code silently loops execution forever (asserted by
 * `publication-error-code-alignment.test.ts`).
 *
 * The *strings* are owned by the hand-written OpenAPI contract
 * (`contracts/review-runs-api/v1/openapi.yaml`, `ErrorResponse.code` enum); this module keeps
 * only the semantic keys and pins the values to that contract with `satisfies`, so a value
 * that is not a contract code fails to compile. Coverage — that no contract code is missing a
 * key here — is checked by `error-codes.test.ts`, because the semantic keys are not the code
 * strings and cannot express that direction as a clean compile-time type.
 */
import type { PublicationStepErrorCode } from './error-codes-generated.js'

/**
 * The failure code that means "the Execution may have accepted this submission, but we could not
 * confirm it yet".
 *
 * It is the one code with a meaning beyond its text: every terminal preparation failure is
 * reported as execution `skipped` (the Execution was never called), except this one, which becomes
 * execution `uncertain` and keeps publication `pending` because the run may still succeed. The
 * code is stamped by the submission paths in this package
 * (`prepared-submission.ts`, `server.ts`) and read back by `preparation-store.ts`, so it lives
 * here rather than as a literal in each of them: a changed spelling in one place must not
 * silently downgrade "may have been accepted" into "never ran".
 */
export const SUBMISSION_STATE_UNCERTAIN = 'SUBMISSION_STATE_UNCERTAIN'

export const PUBLICATION_STEP_ERROR_CODES = {
  set_duplicate: 'PUBLICATION_STEP_SET_DUPLICATE',
  set_changed: 'PUBLICATION_STEP_SET_CHANGED',
  retry_exhausted: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
  not_claimable: 'PUBLICATION_STEP_NOT_CLAIMABLE'
} as const satisfies Record<string, PublicationStepErrorCode>

export class DeterministicReviewRunError extends Error {
  readonly code: PublicationStepErrorCode

  constructor(
    message: string,
    code: PublicationStepErrorCode,
    options: ErrorOptions = {}
  ) {
    super(message, options)
    this.name = 'DeterministicReviewRunError'
    this.code = code
  }
}
