import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from './http.js'

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
  )
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
}

/** Return whether a state-changing request came from the console's own origin.
 *
 * The comparison is self-referential so loopback, LAN and domain deployments need no
 * origin configuration. A request carrying neither Origin nor Referer is refused.
 */
function isSameOrigin(request: IncomingMessage): boolean {
  const source = request.headers.origin ?? request.headers.referer
  const host = request.headers.host
  if (source === undefined || host === undefined) return false
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}

/** Refuse a state-changing request that did not come from the console's own origin.
 *
 * Every mutating route shares one refusal: a cross-site request learns the same thing
 * whichever route it reached, and a new route cannot invent a second error code for the
 * same policy. Callers return early when this sends the refusal.
 */
export function requireSameOrigin(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  if (isSameOrigin(request)) return true
  sendJson(response, 403, { error: 'cross_site_request' })
  return false
}
