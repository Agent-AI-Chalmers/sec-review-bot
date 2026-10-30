import type { IncomingMessage, ServerResponse } from 'node:http'

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
export function isSameOrigin(request: IncomingMessage): boolean {
  const source = request.headers.origin ?? request.headers.referer
  const host = request.headers.host
  if (source === undefined || host === undefined) return false
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}
