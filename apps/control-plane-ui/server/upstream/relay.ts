import type { ServerResponse } from 'node:http'

import { PROXIED_CONTENT_TYPE, sendJson } from '../http.js'
import { UpstreamRequestError, type UpstreamResult } from './request.js'

/** The upstreams this BFF proxies, named the way their error codes name them. */
export type UpstreamName = 'review_runs' | 'memory_catalog'

export interface UpstreamFailure {
  status: number
  error: string
}

/**
 * Translate one failed upstream call into the status and error code the console reads.
 *
 * The failure kinds are produced in one place, so their translation lives in one place
 * too: an oversized response is a 502 whichever upstream sent it, a timeout is a 504,
 * and only the two ordinary failures carry the upstream's name.
 */
export function upstreamFailure(
  error: unknown,
  upstream: UpstreamName
): UpstreamFailure {
  const kind =
    error instanceof UpstreamRequestError ? error.kind : 'unavailable'
  if (kind === 'too_large')
    return { status: 502, error: 'upstream_response_too_large' }
  if (kind === 'timeout') return { status: 504, error: `${upstream}_timeout` }
  return { status: 502, error: `${upstream}_unavailable` }
}

export function sendUpstreamFailure(
  response: ServerResponse,
  upstream: UpstreamName,
  error: unknown
): void {
  const failure = upstreamFailure(error, upstream)
  sendJson(response, failure.status, { error: failure.error })
}

/**
 * Relay an upstream response as it arrived: its status, its body, and the JSON content
 * type the console parses. Callers that must transform a successful body pass their own
 * headers and keep this for the pass-through statuses.
 */
export function writeUpstreamResult(
  response: ServerResponse,
  result: UpstreamResult,
  { cacheControl }: { cacheControl?: string } = {}
): void {
  response.writeHead(result.status, {
    'content-type': PROXIED_CONTENT_TYPE,
    ...(cacheControl === undefined ? {} : { 'cache-control': cacheControl })
  })
  response.end(result.body)
}
