import { REVIEW_RUNS_PUBLICATION_ERROR_CODES } from '../review-runs/review-runs-api.js'

export const EXECUTION_PUBLISH_ERROR_CODES = {
  ...REVIEW_RUNS_PUBLICATION_ERROR_CODES,
  issue_result_invalid: 'ISSUE_RESULT_INVALID',
  pull_request_result_invalid: 'PULL_REQUEST_RESULT_INVALID',
  repository_result_invalid: 'REPOSITORY_RESULT_INVALID',
  publish_context_invalid: 'PUBLISH_CONTEXT_INVALID',
  github_auth_rejected: 'GITHUB_AUTH_REJECTED',
  github_not_found: 'GITHUB_NOT_FOUND',
  github_publish_rejected: 'GITHUB_PUBLISH_REJECTED',
  github_validation_rejected: 'GITHUB_VALIDATION_REJECTED',
  execution_publish_non_retryable: 'EXECUTION_PUBLISH_NON_RETRYABLE',
  // The app could not attribute a bot-authored object because its own login is unknown.
  // Re-claiming the same publication re-enters the same condition, so retrying only loops; a
  // restart with complete `/app` metadata is what repairs it.
  app_metadata_unavailable: 'APP_METADATA_UNAVAILABLE'
} as const

export type ExecutionPublishErrorCode =
  (typeof EXECUTION_PUBLISH_ERROR_CODES)[keyof typeof EXECUTION_PUBLISH_ERROR_CODES]
