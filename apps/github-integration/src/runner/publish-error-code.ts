export const RUNNER_PUBLISH_ERROR_CODES = {
  issue_result_invalid: 'ISSUE_RESULT_INVALID',
  pull_request_result_invalid: 'PULL_REQUEST_RESULT_INVALID',
  repository_result_invalid: 'REPOSITORY_RESULT_INVALID',
  publish_context_invalid: 'PUBLISH_CONTEXT_INVALID',
  github_auth_rejected: 'GITHUB_AUTH_REJECTED',
  github_not_found: 'GITHUB_NOT_FOUND',
  github_publish_rejected: 'GITHUB_PUBLISH_REJECTED',
  github_validation_rejected: 'GITHUB_VALIDATION_REJECTED',
  // These four codes Control Plane emits as terminal (deterministic) publication
  // step failures. They must match the `ErrorResponse.code` enum in the hand-written
  // `contracts/control-plane-api/openapi.yaml`; the alignment test reads Control Plane's
  // single source and asserts each code is classified `retry: false`, so a new code on
  // the Control Plane side cannot silently loop the runner forever.
  publication_step_retry_exhausted: 'PUBLICATION_STEP_RETRY_EXHAUSTED',
  publication_step_set_duplicate: 'PUBLICATION_STEP_SET_DUPLICATE',
  publication_step_set_changed: 'PUBLICATION_STEP_SET_CHANGED',
  // A step that is already 'succeeded' (or otherwise not claimable and not
  // retry-exhausted) cannot be repaired by re-claiming, so it is terminal.
  publication_step_not_claimable: 'PUBLICATION_STEP_NOT_CLAIMABLE',
  runner_publish_non_retryable: 'RUNNER_PUBLISH_NON_RETRYABLE',
  // The app could not attribute a bot-authored object because its own login is unknown.
  // Re-claiming the same publication re-enters the same condition, so retrying only loops; a
  // restart with complete `/app` metadata is what repairs it.
  app_metadata_unavailable: 'APP_METADATA_UNAVAILABLE'
} as const

export type RunnerPublishErrorCode =
  (typeof RUNNER_PUBLISH_ERROR_CODES)[keyof typeof RUNNER_PUBLISH_ERROR_CODES]
