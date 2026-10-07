import { asErrorWithResponse } from '../../utils/error-utils.js'
import { RUNNER_PUBLISH_ERROR_CODES } from './publish-error-code.js'
import { isDeterministicRunnerPublishError } from './publish-error.js'

interface PublishFailureClassification {
  retry: boolean
  code: string | null
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null
}

function isRateLimitOrAbuseLimit(error: unknown): boolean {
  const errorInfo = asErrorWithResponse(error)
  const headers = errorInfo.response?.headers ?? {}
  const retryAfter = headers['retry-after'] ?? headers['Retry-After']
  const rateRemaining = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining']
  const message = [errorInfo.message, errorInfo.response?.data?.message].join(' ').toLowerCase()
  return (
    retryAfter !== undefined ||
    rateRemaining === '0' ||
    message.includes('rate limit') ||
    message.includes('abuse')
  )
}

export function classifyPublicationFailure(error: unknown): PublishFailureClassification {
  if (isDeterministicRunnerPublishError(error)) {
    return { retry: false, code: errorCode(error), reason: 'deterministic-publish-result' }
  }

  const responseStatus = asErrorWithResponse(error).status
  if (responseStatus === undefined)
    return { retry: true, code: errorCode(error), reason: 'unknown-publish-error' }
  if (
    responseStatus >= 500 ||
    responseStatus === 408 ||
    responseStatus === 409 ||
    responseStatus === 429
  ) {
    return { retry: true, code: errorCode(error), reason: 'github-transient-response' }
  }
  if (responseStatus === 403 && isRateLimitOrAbuseLimit(error)) {
    return { retry: true, code: errorCode(error), reason: 'github-rate-limited' }
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return {
      retry: false,
      code: errorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_auth_rejected,
      reason: 'github-auth-rejected'
    }
  }
  if (responseStatus === 404) {
    return {
      retry: false,
      code: errorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_not_found,
      reason: 'github-not-found'
    }
  }
  if (responseStatus === 422) {
    return {
      retry: false,
      code: errorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected,
      reason: 'github-validation-rejected'
    }
  }
  if (responseStatus >= 400 && responseStatus < 500) {
    return {
      retry: false,
      code: errorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_publish_rejected,
      reason: 'github-deterministic-response'
    }
  }
  return { retry: true, code: errorCode(error), reason: 'github-unclassified-response' }
}
