export const RUNNER_PUBLISH_ERROR_CODES = {
  issue_result_invalid: 'ISSUE_RESULT_INVALID',
  pull_request_result_invalid: 'PULL_REQUEST_RESULT_INVALID',
  repository_result_invalid: 'REPOSITORY_RESULT_INVALID',
  github_auth_rejected: 'GITHUB_AUTH_REJECTED',
  github_not_found: 'GITHUB_NOT_FOUND',
  github_publish_rejected: 'GITHUB_PUBLISH_REJECTED',
  github_validation_rejected: 'GITHUB_VALIDATION_REJECTED',
  runner_publish_non_retryable: 'RUNNER_PUBLISH_NON_RETRYABLE'
} as const

export type RunnerPublishErrorCode =
  typeof RUNNER_PUBLISH_ERROR_CODES[keyof typeof RUNNER_PUBLISH_ERROR_CODES]
