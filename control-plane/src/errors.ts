/** Publication-step failure codes Control Plane can emit as terminal (deterministic).
 *
 * These cross the package boundary: github-integration must classify each as
 * `retry: false`, otherwise a new code silently loops the runner forever. Add a
 * code here only together with the matching github-side classification (asserted
 * by `publication-error-code-alignment.test.ts`).
 */
export const PUBLICATION_STEP_ERROR_CODES = {
  set_duplicate: 'PUBLICATION_STEP_SET_DUPLICATE',
  set_changed: 'PUBLICATION_STEP_SET_CHANGED',
  retry_exhausted: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
  not_claimable: 'PUBLICATION_STEP_NOT_CLAIMABLE'
} as const

export type PublicationStepErrorCode =
  (typeof PUBLICATION_STEP_ERROR_CODES)[keyof typeof PUBLICATION_STEP_ERROR_CODES]

export class DeterministicControlPlaneError extends Error {
  readonly code: PublicationStepErrorCode

  constructor(message: string, code: PublicationStepErrorCode, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'DeterministicControlPlaneError'
    this.code = code
  }
}
