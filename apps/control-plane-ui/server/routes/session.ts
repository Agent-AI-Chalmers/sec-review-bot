import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from '../http-response.js'
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody
} from '../http-request.js'
import { requireSameOrigin } from '../request-security.js'

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
      // Signing in is a state change too: without this, another site could force the
      // browser into a session it did not ask for.
      if (!requireSameOrigin(request, response)) return true
      let raw: Buffer
      try {
        raw = await readBoundedRequestBody(request)
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(response, 413, { error: 'request_too_large' })
          return true
        }
        throw error
      }
      const supplied = ((): string => {
        try {
          return (
            (
              JSON.parse(raw.toString('utf8')) as {
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
        sendJson(response, 401, { error: 'unauthorized' })
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
      if (!requireSameOrigin(request, response)) return true
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
