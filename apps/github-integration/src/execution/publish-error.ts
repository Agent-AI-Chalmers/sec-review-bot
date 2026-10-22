import {
  EXECUTION_PUBLISH_ERROR_CODES,
  type ExecutionPublishErrorCode
} from './publish-error-code.js'
import { isRecord } from '../utils/error-utils.js'

interface ErrorOptionsWithCause {
  cause?: unknown
}

export class DeterministicExecutionPublishError extends Error {
  readonly code: ExecutionPublishErrorCode

  // Use this for deterministic publication failures, such as malformed execution
  // results. Retrying the same stored run cannot repair those inputs.
  constructor(
    message: string,
    code: ExecutionPublishErrorCode = EXECUTION_PUBLISH_ERROR_CODES.execution_publish_non_retryable,
    options: ErrorOptionsWithCause = {}
  ) {
    super(message, options)
    this.name = 'DeterministicExecutionPublishError'
    this.code = code
  }
}

export function isDeterministicExecutionPublishError(
  error: unknown
): error is DeterministicExecutionPublishError {
  return (
    error instanceof DeterministicExecutionPublishError ||
    (isRecord(error) &&
      error.name === 'DeterministicExecutionPublishError' &&
      typeof error.code === 'string')
  )
}
