/**
 * Publication-step failure codes Control Plane can emit as terminal (deterministic).
 *
 * These cross the package boundary: github-integration must classify each as `retry: false`,
 * otherwise a new code silently loops the runner forever (asserted by
 * `publication-error-code-alignment.test.ts`).
 *
 * The *strings* are owned by the hand-written OpenAPI contract
 * (`contracts/control-plane-api/openapi.yaml`, `ErrorResponse.code` enum); this module keeps
 * only the semantic keys and pins the values to that contract with `satisfies`, so a value
 * that is not a contract code fails to compile. Coverage — that no contract code is missing a
 * key here — is checked by `error-codes.test.ts`, because the semantic keys are not the code
 * strings and cannot express that direction as a clean compile-time type.
 */
import {
  PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT,
  type PublicationStepErrorCode
} from './error-codes-generated.js'

export const PUBLICATION_STEP_ERROR_CODES = {
  set_duplicate: 'PUBLICATION_STEP_SET_DUPLICATE',
  set_changed: 'PUBLICATION_STEP_SET_CHANGED',
  retry_exhausted: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
  not_claimable: 'PUBLICATION_STEP_NOT_CLAIMABLE'
} as const satisfies Record<string, PublicationStepErrorCode>

// Keep the unused import's value use honest: the values are the contract strings, and the
// coverage test below (error-codes.test.ts) asserts they also cover every contract code.
void PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT

export class DeterministicControlPlaneError extends Error {
  readonly code: PublicationStepErrorCode

  constructor(message: string, code: PublicationStepErrorCode, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'DeterministicControlPlaneError'
    this.code = code
  }
}
