import { RUNNER_PUBLISH_ERROR_CODES, type RunnerPublishErrorCode } from './publish-error-code.js'
import { isRecord } from '../utils/error-utils.js'

interface ErrorOptionsWithCause {
  cause?: unknown
}

export class DeterministicRunnerPublishError extends Error {
  readonly code: RunnerPublishErrorCode

  // Use this for deterministic publication failures, such as malformed runner
  // results. Retrying the same stored run cannot repair those inputs.
  constructor(
    message: string,
    code: RunnerPublishErrorCode = RUNNER_PUBLISH_ERROR_CODES.runner_publish_non_retryable,
    options: ErrorOptionsWithCause = {}
  ) {
    super(message, options)
    this.name = 'DeterministicRunnerPublishError'
    this.code = code
  }
}

export function isDeterministicRunnerPublishError(
  error: unknown
): error is DeterministicRunnerPublishError {
  return (
    error instanceof DeterministicRunnerPublishError ||
    (isRecord(error) &&
      error.name === 'DeterministicRunnerPublishError' &&
      typeof error.code === 'string')
  )
}
