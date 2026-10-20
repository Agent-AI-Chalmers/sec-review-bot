import { asErrorWithResponse, errorCode } from '../utils/error-utils.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../runner/publish-error-code.js'
import { isDeterministicRunnerPublishError } from '../runner/publish-error.js'

interface PublishFailureClassification {
  retry: boolean
  code: string | null
  reason: string
}

// Control Plane publication faults that retrying cannot repair. The step set is
// fixed for a stored run, so re-claiming the publication re-enters the same
// condition and fails identically. Treat them as terminal instead of looping.
const DETERMINISTIC_CONTROL_PLANE_PUBLICATION_CODES = new Set<string>([
  RUNNER_PUBLISH_ERROR_CODES.publication_step_set_duplicate,
  RUNNER_PUBLISH_ERROR_CODES.publication_step_set_changed,
  RUNNER_PUBLISH_ERROR_CODES.publication_step_not_claimable
])

/** Whether the failure is about reaching the service, not about what it answered.
 *
 * The exhaustion code is a decision the Control Plane makes; a fault that never got an answer
 * from it (no status) or that a proxy answered (500 and above) says nothing about that decision.
 * A 4xx means the request reached Control Plane and was refused, which is a real answer. */
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
  if (isDeterministicRunnerPublishError(error)) {
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
  // whatever the claim call threw, and Control Plane answers this same code whether the budget is
  // spent or the request never arrived: a timeout, a 5xx, or a dropped connection carries it too.
  // Treating that as a verdict would end a publication whose steps were never refused, so a fault
  // with no HTTP status, or one a proxy or load balancer answered, stays retryable and the next
  // owner re-reads the step instead.
  if (
    errorCode(error) ===
    RUNNER_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  ) {
    return {
      retry: isTransportFault(error),
      code: errorCode(error),
      reason: 'publication-step-retry-exhausted'
    }
  }
  const controlPlaneCode = errorCode(error)
  if (
    controlPlaneCode !== null &&
    DETERMINISTIC_CONTROL_PLANE_PUBLICATION_CODES.has(controlPlaneCode)
  ) {
    return {
      retry: false,
      code: controlPlaneCode,
      reason: 'control-plane-deterministic-publication-fault'
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
      code:
        errorCode(error) ??
        RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected,
      reason: 'github-validation-rejected'
    }
  }
  if (responseStatus >= 400 && responseStatus < 500) {
    return {
      retry: false,
      code:
        errorCode(error) ?? RUNNER_PUBLISH_ERROR_CODES.github_publish_rejected,
      reason: 'github-deterministic-response'
    }
  }
  return {
    retry: true,
    code: errorCode(error),
    reason: 'github-unclassified-response'
  }
}
