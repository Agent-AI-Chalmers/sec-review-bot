import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const MAX_SESSION_BODY_BYTES = 1024 * 1024
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 10_000

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
  )
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
}
const allowed = /^\/api\/runs(?:\?.*)?$|^\/api\/runs\/[^/?]+(?:\/publication-steps)?$/

export function createControlPlaneUiServer({
  controlPlaneUrl,
  controlPlaneToken,
  accessToken,
  assets = path.resolve('dist')
}: {
  controlPlaneUrl: string
  controlPlaneToken: string
  accessToken: string
  assets?: string
}): Server {
  const sessionValue = crypto.createHash('sha256').update(accessToken).digest('base64url')
  const authenticated = (cookie: string | undefined): boolean =>
    cookie
      ?.split(';')
      .map((value) => value.trim())
      .includes(`control_plane_ui_session=${sessionValue}`) ?? false
  return createServer(async (request, response) => {
    securityHeaders(response)
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    if (request.url === '/api/session' && request.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        size += buffer.byteLength
        if (size > MAX_SESSION_BODY_BYTES) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end('{"error":"request_too_large"}')
          return
        }
        chunks.push(buffer)
      }
      const supplied = ((): string => {
        try {
          return (
            (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: string }).token ?? ''
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
        return
      }
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/`
      })
      response.end()
      return
    }
    if (request.url?.startsWith('/api/')) {
      if (!authenticated(request.headers.cookie)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized"}')
        return
      }
      if (request.method !== 'GET' || !allowed.test(request.url)) {
        response.writeHead(404)
        response.end()
        return
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), CONTROL_PLANE_REQUEST_TIMEOUT_MS)
      try {
        const upstream = await fetch(`${controlPlaneUrl}/v1${request.url.slice(4)}`, {
          headers: { authorization: `Bearer ${controlPlaneToken}` },
          signal: controller.signal
        })
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json'
        })
        response.end(Buffer.from(await upstream.arrayBuffer()))
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError'
        response.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: timedOut ? 'control_plane_timeout' : 'control_plane_unavailable'
          })
        )
      } finally {
        clearTimeout(timeout)
      }
      return
    }
    const requested = request.url === '/' ? 'index.html' : (request.url?.slice(1) ?? 'index.html')
    let file = path.resolve(assets, requested)
    if (!file.startsWith(`${assets}${path.sep}`)) {
      response.writeHead(404)
      response.end()
      return
    }
    try {
      if (!(await stat(file)).isFile()) file = path.join(assets, 'index.html')
    } catch {
      file = path.join(assets, 'index.html')
    }
    response.writeHead(200, {
      'content-type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/javascript'
    })
    createReadStream(file).pipe(response)
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controlPlaneToken = process.env.CONTROL_PLANE_READ_TOKEN
  const accessToken = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
  if (!controlPlaneToken) throw new Error('CONTROL_PLANE_READ_TOKEN is required.')
  if (!accessToken) throw new Error('CONTROL_PLANE_UI_ACCESS_TOKEN is required.')
  createControlPlaneUiServer({
    controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8090',
    controlPlaneToken,
    accessToken
  }).listen(Number.parseInt(process.env.CONTROL_PLANE_UI_PORT ?? '8091', 10), '0.0.0.0')
}
