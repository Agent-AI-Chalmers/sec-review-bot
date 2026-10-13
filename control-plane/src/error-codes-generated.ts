// Generated from ../contracts/control-plane-api/openapi.yaml. Do not edit.
//
// The hand-written openapi.yaml owns the error-code vocabulary; this file is its server-side
// projection. Regenerate it with `pnpm run generate:control-plane-types`.

export type PublicationStepErrorCode =
  | 'PUBLICATION_STEP_NOT_CLAIMABLE'
  | 'PUBLICATION_STEP_RETRY_EXHAUSTED'
  | 'PUBLICATION_STEP_SET_CHANGED'
  | 'PUBLICATION_STEP_SET_DUPLICATE'

export const PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT = [
  'PUBLICATION_STEP_NOT_CLAIMABLE',
  'PUBLICATION_STEP_RETRY_EXHAUSTED',
  'PUBLICATION_STEP_SET_CHANGED',
  'PUBLICATION_STEP_SET_DUPLICATE'
] as const satisfies readonly PublicationStepErrorCode[]

/** Every code the contract's ErrorResponse.code enum allows. */
export const ERROR_RESPONSE_CODES_FROM_CONTRACT = [
  'INVALID_BODY',
  'INVALID_PATH_PARAMETER',
  'INVALID_QUERY',
  'PUBLICATION_STEP_NOT_CLAIMABLE',
  'PUBLICATION_STEP_RETRY_EXHAUSTED',
  'PUBLICATION_STEP_SET_CHANGED',
  'PUBLICATION_STEP_SET_DUPLICATE'
] as const
