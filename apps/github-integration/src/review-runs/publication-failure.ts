import { asErrorWithResponse, errorCode } from '../utils/error-utils.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../execution/publish-error-code.js'
import { isDeterministicExecutionPublishError } from '../execution/publish-error.js'

interface PublishFailureClassification {
  retry: boolean
  code: string | null
  reason: string
}

// Review Runs publication faults that retrying cannot repair. The step set is
// fixed for a stored run, so re-claiming the publication re-enters the same
// condition and fails identically. Treat them as terminal instead of looping.
const DETERMINISTIC_REVIEW_RUNS_PUBLICATION_CODES = new Set<string>([
  EXECUTION_PUBLISH_ERROR_CODES.publication_step_set_duplicate,
  EXECUTION_PUBLISH_ERROR_CODES.publication_step_set_changed,
  EXECUTION_PUBLISH_ERROR_CODES.publication_step_not_claimable
])

/** Whether the failure is about reaching the service, not about what it answered.
 *
 * The exhaustion code is a decision Review Runs makes; a fault that never got an answer
 * from it (no status) or that a proxy answered (500 and above) says nothing about that decision.
 * A 4xx means the request reached Review Runs and was refused, which is a real answer. */
function isTransportFault(error: unknown): boolean {
  const status = asErrorWithResponse(error).status
  return status === undefined || status >= 500
}

function isRateLimitOrAbuseLimit(error: unknown): boolean {
  const errorInfo = asErrorWithResponse(error)
  const headers = errorInfo.response?.headers ?? {}
  const retryAfter = headers['retry-after'] ?? headers['Retry-After']
  const rateRemaining =
    headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining']
  const message = [errorInfo.message, errorInfo.response?.data?.message]
    .join(' ')
    .toLowerCase()
  return (
    retryAfter !== undefined ||
    rateRemaining === '0' ||
    message.includes('rate limit') ||
    message.includes('abuse')
  )
}

export function classifyPublicationFailure(
  error: unknown
): PublishFailureClassification {
  if (isDeterministicExecutionPublishError(error)) {
    return {
      retry: false,
      code: errorCode(error),
      reason: 'deterministic-publish-result'
    }
  }
  // An exhausted step that reached this classification was reconciled first: the publish paths
  // only propagate the exhaustion error after looking for the remote effect and finding none.
  // Re-claiming would be refused again (no attempt is left), so it must fail rather than loop.
  //
  // A transport fault is the one exception. The publish paths reach this branch by rethrowing
  // whatever the claim call threw, and Review Runs answers this same code whether the budget is
  // spent or the request never arrived: a timeout, a 5xx, or a dropped connection carries it too.
  // Treating that as a verdict would end a publication whose steps were never refused, so a fault
  // with no HTTP status, or one a proxy or load balancer answered, stays retryable and the next
  // owner re-reads the step instead.
  if (
    errorCode(error) ===
    EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  ) {
    return {
      retry: isTransportFault(error),
      code: errorCode(error),
      reason: 'publication-step-retry-exhausted'
    }
  }
  const reviewRunsCode = errorCode(error)
  if (
    reviewRunsCode !== null &&
    DETERMINISTIC_REVIEW_RUNS_PUBLICATION_CODES.has(reviewRunsCode)
  ) {
    return {
      retry: false,
      code: reviewRunsCode,
      reason: 'review-runs-deterministic-publication-fault'
    }
  }

  const responseStatus = asErrorWithResponse(error).status
  if (responseStatus === undefined)
    return {
      retry: true,
      code: errorCode(error),
      reason: 'unknown-publish-error'
    }
  if (
    responseStatus >= 500 ||
    responseStatus === 408 ||
    responseStatus === 409 ||
    responseStatus === 429
  ) {
    return {
      retry: true,
      code: errorCode(error),
      reason: 'github-transient-response'
    }
  }
  if (responseStatus === 403 && isRateLimitOrAbuseLimit(error)) {
    return {
      retry: true,
      code: errorCode(error),
      reason: 'github-rate-limited'
    }
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return {
      retry: false,
      code:
        errorCode(error) ?? EXECUTION_PUBLISH_ERROR_CODES.github_auth_rejected,
      reason: 'github-auth-rejected'
    }
  }
  if (responseStatus === 404) {
    return {
      retry: false,
      code: errorCode(error) ?? EXECUTION_PUBLISH_ERROR_CODES.github_not_found,
      reason: 'github-not-found'
    }
  }
  if (responseStatus === 422) {
    return {
      retry: false,
      code:
        errorCode(error) ??
        EXECUTION_PUBLISH_ERROR_CODES.github_validation_rejected,
      reason: 'github-validation-rejected'
    }
  }
  if (responseStatus >= 400 && responseStatus < 500) {
    return {
      retry: false,
      code:
        errorCode(error) ??
        EXECUTION_PUBLISH_ERROR_CODES.github_publish_rejected,
      reason: 'github-deterministic-response'
    }
  }
  return {
    retry: true,
    code: errorCode(error),
    reason: 'github-unclassified-response'
  }
}
