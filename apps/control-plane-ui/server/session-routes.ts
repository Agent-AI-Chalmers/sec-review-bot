import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isSameOrigin } from './request-security.js'

const MAX_SESSION_BODY_BYTES = 1024 * 1024

export interface SessionRoutes {
  authenticated(request: IncomingMessage): boolean
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own process-local browser sessions and the two routes that mutate them. */
export function createSessionRoutes({
  accessToken,
  maximumSessions,
  secureCookies,
  sessionTtlSeconds
}: {
  accessToken: string
  maximumSessions: number
  secureCookies: boolean
  sessionTtlSeconds: number
}): SessionRoutes {
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1)
    throw new RangeError('maximumSessions must be a positive integer')

  // Restarting the BFF intentionally revokes every session. Only opaque expirations live here;
  // the shared access token is used for comparison and is never stored in a session record.
  const sessions = new Map<string, number>()
  const cookieSecurity = secureCookies ? '; Secure' : ''
  const sessionCookie = (request: IncomingMessage): string | undefined =>
    request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('control_plane_ui_session='))
      ?.slice('control_plane_ui_session='.length)

  const prepareSlot = (now: number): void => {
    for (const [session, expiresAt] of sessions)
      if (expiresAt <= now) sessions.delete(session)
    while (sessions.size >= maximumSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  const authenticated = (request: IncomingMessage): boolean => {
    const session = sessionCookie(request)
    if (session === undefined) return false
    const expiresAt = sessions.get(session)
    if (expiresAt === undefined) return false
    if (expiresAt <= Date.now()) {
      sessions.delete(session)
      return false
    }
    return true
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.url === '/api/session' && request.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        size += buffer.byteLength
        if (size > MAX_SESSION_BODY_BYTES) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end('{"error":"request_too_large"}')
          return true
        }
        chunks.push(buffer)
      }
      const supplied = ((): string => {
        try {
          return (
            (
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                token?: string
              }
            ).token ?? ''
          )
        } catch {
          return ''
        }
      })()
      const suppliedBytes = Buffer.from(supplied)
      const accessTokenBytes = Buffer.from(accessToken)
      const valid =
        suppliedBytes.byteLength === accessTokenBytes.byteLength &&
        crypto.timingSafeEqual(suppliedBytes, accessTokenBytes)
      if (!valid) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized"}')
        return true
      }
      const sessionValue = crypto.randomBytes(32).toString('base64url')
      const now = Date.now()
      prepareSlot(now)
      sessions.set(sessionValue, now + sessionTtlSeconds * 1000)
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlSeconds}${cookieSecurity}`,
        'cache-control': 'no-store'
      })
      response.end()
      return true
    }

    if (request.url === '/api/session' && request.method === 'DELETE') {
      if (!isSameOrigin(request)) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"error":"cross_origin"}')
        return true
      }
      const session = sessionCookie(request)
      if (session !== undefined) sessions.delete(session)
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecurity}`
      })
      response.end()
      return true
    }

    return false
  }

  return { authenticated, handle }
}
