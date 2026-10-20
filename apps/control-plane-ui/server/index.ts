import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { tmpdir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { LIST_RUN_QUERY_PARAMS } from '../src/list-run-query-params.js'

const MAX_SESSION_BODY_BYTES = 1024 * 1024
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 10_000
const ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const ARTIFACT_BUCKET = 'sec-review'

interface ArtifactObject {
  body: Readable
  contentLength?: number
}

export interface ArtifactStore {
  getObject(key: string, signal: AbortSignal): Promise<ArtifactObject>
}

interface AvailableArtifact {
  digest: string
  key: string
  sizeBytes: number
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
  )
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
}

/** A state-changing request may only come from the console's own origin.
 *
 * The check is self-referential on purpose: there is nothing to configure. A browser
 * sets `Origin` to the page a script runs on, and `Host` to the address actually being
 * dialled, so a same-origin call has matching hosts and a cross-site one does not. The
 * BFF may be reached as a loopback address, a LAN IP or a domain, so comparing against
 * the request's own `Host` works in every deployment without hard-coding one.
 *
 * `Origin` is absent on some requests; `Referer` is its partial fallback. A request
 * carrying neither is refused, because an attacker can also omit them.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const source = request.headers.origin ?? request.headers.referer
  const host = request.headers.host
  if (source === undefined || host === undefined) return false
  try {
    return new URL(source).host === host
  } catch {
    // A malformed `Origin`/`Referer` is not a same-origin request.
    return false
  }
}

/**
 * The upstream path a read proxy should request: the BFF path minus its `/api` prefix,
 * with the query reduced to the parameters Control Plane declares (generated from
 * `openapi.yaml`). Anything else the browser put in the URL (UI state such as `range`,
 * analytics parameters, typos) is dropped rather than forwarded, so this proxy cannot send
 * a request outside Control Plane's contract.
 */
function forwardedPath(bffUrl: string): string {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  const forwarded = new URLSearchParams()
  for (const name of LIST_RUN_QUERY_PARAMS) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') forwarded.set(name, value)
  }
  const query = forwarded.toString()
  return `${url.pathname.slice('/api'.length)}${query === '' ? '' : `?${query}`}`
}

/** The UUID a Control Plane run id is (see the contract's `runId` path parameter). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether this BFF path is one of the reads the console may proxy upstream.
 *
 * The run-id segment is matched against the contract's UUID shape after percent-decoding, not
 * with a catch-all. A catch-all would still be safe today - Control Plane rejects a malformed id
 * with a 400 - but it widens the reachable surface to whatever path a future upstream read
 * endpoint might parse, so the allow-list states the exact shape it means.
 */
/** `POST /api/admin/runs/<uuid>/abandon`, the only write the console may proxy.
 *
 * The admin credential is supplied by the operator for that one request and forwarded as-is; the
 * BFF never reads or stores it. Keeping it out of the server means a compromised BFF cannot
 * abandon runs, and the Control Plane decides who is allowed to.
 */
// Same shape check as the read allow-list: the id is a UUID or the request is not one this BFF
// proxies. Sharing `RUN_ID` keeps the two policies from drifting apart.
const ADMIN_ABANDON = new RegExp(
  `^/api/admin/runs/(${RUN_ID.source.slice(1, -1)})/abandon$`
)

function isAllowedReadPath(bffUrl: string): boolean {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  if (url.pathname === '/api/runs') return true
  // A fixed sub-resource of the run collection, not a run id: it lists the runs coordination
  // has stopped retrying, so the console can show the operator queue without any write access.
  if (url.pathname === '/api/runs/blocked-preparations') return true
  const segments = url.pathname.split('/')
  // ['', 'api', 'runs', '<runId>', ...optional suffix]
  if (segments.length < 4 || segments[1] !== 'api' || segments[2] !== 'runs')
    return false
  let runId: string
  try {
    runId = decodeURIComponent(segments[3] ?? '')
  } catch {
    // A malformed escape (`%zz`) is not a path this BFF proxies.
    return false
  }
  if (!RUN_ID.test(runId)) return false
  if (segments.length === 4) return true
  if (segments.length !== 5) return false
  return segments[4] === 'publication-steps' || segments[4] === 'events'
}

/**
 * The `content-type` served for a proxied Control Plane response.
 *
 * Every proxied route (the reads and the admin write) returns JSON, so the BFF answers with a
 * fixed JSON media type instead of echoing the upstream `content-type`. The upstream value is
 * only attacker-influenced if Control Plane is compromised, but copying it verbatim would serve
 * whatever that response claimed (for example `text/html`) from the console's own origin, where
 * a browser could run it as script. A constant cannot be mismatched with the body either: the
 * bytes are forwarded unchanged and the contract says they are JSON.
 */
const PROXIED_CONTENT_TYPE = 'application/json; charset=utf-8'

function sendJson(
  response: ServerResponse,
  status: number,
  body: object
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function availableArtifact(
  value: unknown,
  runId: string,
  bucket: string
): AvailableArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const storage = value as Record<string, unknown>
  if (storage.status !== 'available') return null
  if (
    typeof storage.artifact !== 'object' ||
    storage.artifact === null ||
    Array.isArray(storage.artifact)
  )
    return null
  const artifact = storage.artifact as Record<string, unknown>
  const expectedUri = `s3://${bucket}/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  if (
    artifact.kind !== 'diagnostic_bundle' ||
    artifact.uri !== expectedUri ||
    artifact.media_type !== 'application/tar+zstd' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    return null
  const key = expectedUri.slice(`s3://${bucket}/`.length)
  return {
    digest: artifact.digest,
    key,
    sizeBytes: artifact.size_bytes as number
  }
}

function artifactStoreFromEnvironment(): ArtifactStore | undefined {
  const endpoint = process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT?.trim()
  const bucket = process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET?.trim()
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!endpoint && !bucket) return undefined
  if (
    !endpoint ||
    bucket !== ARTIFACT_BUCKET ||
    !accessKeyId ||
    !secretAccessKey
  )
    throw new Error(
      'Control Plane UI artifact storage configuration is invalid.'
    )
  const client = new S3Client({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
  })
  return {
    async getObject(key, signal): Promise<ArtifactObject> {
      const object = await client.send(
        new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }),
        { abortSignal: signal }
      )
      if (!(object.Body instanceof Readable))
        throw new Error('RustFS returned no readable body.')
      return {
        body: object.Body,
        ...(object.ContentLength === undefined
          ? {}
          : { contentLength: object.ContentLength })
      }
    }
  }
}

function storageStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const metadata = '$metadata' in error ? error.$metadata : undefined
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('httpStatusCode' in metadata)
  )
    return undefined
  return typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined
}

export function createControlPlaneUiServer({
  controlPlaneUrl,
  controlPlaneToken,
  accessToken,
  artifactStore,
  artifactDownloadIdleTimeoutMs = ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS,
  controlPlaneRequestTimeoutMs = CONTROL_PLANE_REQUEST_TIMEOUT_MS,
  assets = path.resolve('dist')
}: {
  controlPlaneUrl: string
  controlPlaneToken: string
  accessToken: string
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs?: number
  controlPlaneRequestTimeoutMs?: number
  assets?: string
}): Server {
  const sessionValue = crypto
    .createHash('sha256')
    .update(accessToken)
    .digest('base64url')
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
        return
      }
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/`
      })
      response.end()
      return
    }
    // Signing out can only be done by the server: the session cookie is HttpOnly, so
    // the console cannot clear it from script. Expiring it here forgets the credential
    // on this browser. It does not revoke the access token itself, which stays valid
    // for anyone else who holds it — the BFF keeps no session table to invalidate.
    //
    // There is nothing to authenticate: any caller may clear its own cookie, and a
    // clear is harmless to a caller that was never signed in. The same-origin check
    // instead keeps another site from reaching in and signing the reader out, which is
    // the only thing a cross-site DELETE could do. `SameSite=Strict` on the cookie
    // already stops the browser attaching it; this stops the request being obeyed.
    if (request.url === '/api/session' && request.method === 'DELETE') {
      if (!sameOrigin(request)) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"error":"cross_origin"}')
        return
      }
      response.writeHead(204, {
        'set-cookie':
          'control_plane_ui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
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
      const artifactMatch = /^\/api\/runs\/([^/?]+)\/artifact$/.exec(
        request.url
      )
      if (request.method === 'GET' && artifactMatch !== null) {
        if (artifactStore === undefined) {
          sendJson(response, 503, { error: 'artifact_download_unavailable' })
          return
        }
        let runId: string
        try {
          runId = decodeURIComponent(artifactMatch[1] ?? '')
        } catch {
          sendJson(response, 400, { error: 'invalid_run_id' })
          return
        }
        if (!runId || runId.includes('/')) {
          sendJson(response, 400, { error: 'invalid_run_id' })
          return
        }
        let metadataTimedOut = false
        const metadataController = new AbortController()
        const metadataTimeout = setTimeout(() => {
          metadataTimedOut = true
          metadataController.abort()
        }, controlPlaneRequestTimeoutMs)
        const downloadController = new AbortController()
        request.once('aborted', () => downloadController.abort())
        response.once('close', () => {
          if (!response.writableEnded) downloadController.abort()
        })
        let downloadTimedOut = false
        let downloadIdleTimeout: NodeJS.Timeout | undefined
        const resetDownloadIdleTimeout = (): void => {
          clearTimeout(downloadIdleTimeout)
          downloadIdleTimeout = setTimeout(() => {
            downloadTimedOut = true
            downloadController.abort()
          }, artifactDownloadIdleTimeoutMs)
          downloadIdleTimeout.unref()
        }
        let temporaryDirectory: string | undefined
        try {
          const upstream = await fetch(
            `${controlPlaneUrl}/v1/runs/${encodeURIComponent(runId)}`,
            {
              headers: { authorization: `Bearer ${controlPlaneToken}` },
              signal: metadataController.signal
            }
          )
          if (upstream.status === 404) {
            sendJson(response, 404, { error: 'artifact_not_found' })
            return
          }
          if (!upstream.ok) {
            sendJson(response, 502, { error: 'control_plane_unavailable' })
            return
          }
          const body = (await upstream.json()) as {
            run?: { run_id?: unknown; artifact_storage?: unknown }
          }
          clearTimeout(metadataTimeout)
          const artifact =
            body.run?.run_id === runId
              ? availableArtifact(
                  body.run.artifact_storage,
                  runId,
                  ARTIFACT_BUCKET
                )
              : null
          if (artifact === null) {
            sendJson(response, 409, { error: 'artifact_unavailable' })
            return
          }
          resetDownloadIdleTimeout()
          const object = await artifactStore.getObject(
            artifact.key,
            downloadController.signal
          )
          if (
            object.contentLength !== undefined &&
            object.contentLength !== artifact.sizeBytes
          ) {
            object.body.destroy()
            sendJson(response, 502, { error: 'artifact_identity_mismatch' })
            return
          }
          temporaryDirectory = await mkdtemp(
            path.join(tmpdir(), 'sec-review-artifact-')
          )
          const temporaryArtifact = path.join(
            temporaryDirectory,
            'diagnostic-tree.v1.tar.zst'
          )
          const digest = crypto.createHash('sha256')
          let sizeBytes = 0
          const verify = new Transform({
            transform(chunk: Buffer, _encoding, callback): void {
              sizeBytes += chunk.byteLength
              if (sizeBytes > artifact.sizeBytes) {
                callback(new Error('artifact_identity_mismatch'))
                return
              }
              digest.update(chunk)
              resetDownloadIdleTimeout()
              callback(null, chunk)
            }
          })
          await pipeline(
            object.body,
            verify,
            createWriteStream(temporaryArtifact),
            {
              signal: downloadController.signal
            }
          )
          clearTimeout(downloadIdleTimeout)
          const actualDigest = `sha256:${digest.digest('hex')}`
          if (
            sizeBytes !== artifact.sizeBytes ||
            actualDigest !== artifact.digest
          ) {
            sendJson(response, 502, { error: 'artifact_identity_mismatch' })
            return
          }
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition':
              'attachment; filename="diagnostic-tree.v1.tar.zst"',
            'cache-control': 'private, no-store',
            'content-length': String(sizeBytes)
          })
          await pipeline(createReadStream(temporaryArtifact), response, {
            signal: downloadController.signal
          })
        } catch (error) {
          if (response.headersSent || response.destroyed) return
          const status = storageStatus(error)
          const identityMismatch =
            error instanceof Error &&
            error.message === 'artifact_identity_mismatch'
          sendJson(
            response,
            status === 404
              ? 404
              : metadataTimedOut || downloadTimedOut
                ? 504
                : 502,
            {
              error:
                status === 404
                  ? 'artifact_not_found'
                  : metadataTimedOut
                    ? 'control_plane_timeout'
                    : downloadTimedOut
                      ? 'artifact_download_timeout'
                      : identityMismatch
                        ? 'artifact_identity_mismatch'
                        : 'artifact_download_failed'
            }
          )
        } finally {
          clearTimeout(metadataTimeout)
          clearTimeout(downloadIdleTimeout)
          if (temporaryDirectory !== undefined)
            await rm(temporaryDirectory, { recursive: true, force: true })
        }
        return
      }
      const abandoned = ADMIN_ABANDON.exec(request.url ?? '')
      if (request.method === 'POST' && abandoned !== null) {
        // A session cookie alone must not authorise a cross-site POST: the same check the
        // sign-out route uses.
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross_site_request' })
          return
        }
        const adminToken = request.headers['x-control-plane-admin-token']
        if (typeof adminToken !== 'string' || adminToken.trim() === '') {
          // 401 rather than 400: the request is well-formed, it just carries no operator
          // credential. The console turns this into its admin-token prompt.
          sendJson(response, 401, { error: 'admin_token_required' })
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk)
          size += buffer.byteLength
          if (size > MAX_SESSION_BODY_BYTES) {
            sendJson(response, 413, { error: 'request_too_large' })
            return
          }
          chunks.push(buffer)
        }
        try {
          const upstream = await fetch(
            `${controlPlaneUrl}/v1/admin/runs/${encodeURIComponent(
              decodeURIComponent(abandoned[1] ?? '')
            )}/abandon`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${adminToken}`,
                'content-type': 'application/json'
              },
              body: Buffer.concat(chunks),
              signal: AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS)
            }
          )
          response.writeHead(upstream.status, {
            'content-type': PROXIED_CONTENT_TYPE
          })
          response.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (error) {
          const timedOut =
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
          sendJson(response, timedOut ? 504 : 502, {
            error: timedOut
              ? 'control_plane_timeout'
              : 'control_plane_unavailable'
          })
        }
        return
      }
      if (request.method !== 'GET' || !isAllowedReadPath(request.url ?? '')) {
        response.writeHead(404)
        response.end()
        return
      }
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        CONTROL_PLANE_REQUEST_TIMEOUT_MS
      )
      try {
        const upstream = await fetch(
          `${controlPlaneUrl}/v1${forwardedPath(request.url ?? '/')}`,
          {
            headers: { authorization: `Bearer ${controlPlaneToken}` },
            signal: controller.signal
          }
        )
        response.writeHead(upstream.status, {
          'content-type': PROXIED_CONTENT_TYPE
        })
        response.end(Buffer.from(await upstream.arrayBuffer()))
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError'
        response.writeHead(timedOut ? 504 : 502, {
          'content-type': 'application/json'
        })
        response.end(
          JSON.stringify({
            error: timedOut
              ? 'control_plane_timeout'
              : 'control_plane_unavailable'
          })
        )
      } finally {
        clearTimeout(timeout)
      }
      return
    }
    const requested =
      request.url === '/'
        ? 'index.html'
        : (request.url?.slice(1) ?? 'index.html')
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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controlPlaneToken = process.env.CONTROL_PLANE_READ_TOKEN
  const accessToken = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
  if (!controlPlaneToken)
    throw new Error('CONTROL_PLANE_READ_TOKEN is required.')
  if (!accessToken)
    throw new Error('CONTROL_PLANE_UI_ACCESS_TOKEN is required.')
  createControlPlaneUiServer({
    controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8090',
    controlPlaneToken,
    accessToken,
    artifactStore: artifactStoreFromEnvironment()
  }).listen(
    Number.parseInt(process.env.CONTROL_PLANE_UI_PORT ?? '8091', 10),
    '0.0.0.0'
  )
}
