// Classifies preparation failures before they cross Review Runs boundary.
// The result controls durable retry scheduling, not GitHub-specific workflow logic.
import { asErrorWithResponse, errorCode } from '../utils/error-utils.js'

/** A persisted connector input cannot become valid by waiting for an external service. */
export class InvalidPreparationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPreparationInputError'
  }
}

export interface PreparationFailureClassification {
  retry: boolean
  retryAfterMs?: number
  code: string | null
}

function retryAfterMs(error: unknown, attempt: number): number {
  const headers = asErrorWithResponse(error).response?.headers ?? {}
  const value = headers['retry-after'] ?? headers['Retry-After']
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN
  if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000
  return Math.min(10 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 7))
}

function isRateLimited(error: unknown): boolean {
  const info = asErrorWithResponse(error)
  const headers = info.response?.headers ?? {}
  return (
    headers['retry-after'] !== undefined ||
    headers['x-ratelimit-remaining'] === '0' ||
    [info.message, info.response?.data?.message]
      .join(' ')
      .toLowerCase()
      .includes('rate limit')
  )
}

export function classifyPreparationFailure(
  error: unknown,
  attempt: number,
  deterministic = false
): PreparationFailureClassification {
  const code = errorCode(error)
  if (deterministic || error instanceof InvalidPreparationInputError)
    return { retry: false, code }
  const status = asErrorWithResponse(error).status
  const retry =
    status === undefined ||
    status >= 500 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status === 403 && isRateLimited(error))
  return retry
    ? { retry, code, retryAfterMs: retryAfterMs(error, attempt) }
    : { retry, code }
}
