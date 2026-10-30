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
import { zstdDecompressSync } from 'node:zlib'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'

import { LIST_RUN_QUERY_PARAMS } from '../shared/list-run-query-params.js'
import {
  buildMemoryTreeArtifact,
  MAX_MEMORY_TREE_ARTIFACT_BYTES,
  memoryTreeObjectKey,
  readMemoryTreeArtifact
} from './memory/memory-tree-artifact.js'
import {
  MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES,
  readDiagnosticBundle
} from './run/diagnostic-bundle.js'

const MAX_SESSION_BODY_BYTES = 1024 * 1024
const MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024
const REVIEW_RUNS_REQUEST_TIMEOUT_MS = 10_000
const ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const ARTIFACT_BUCKET = 'sec-review'
const MAX_TRAJECTORY_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_TRAJECTORY_CONTENT_BYTES = 8 * 1024 * 1024
const MAX_TRAJECTORY_LINE_BYTES = 512 * 1024
const MAX_TRAJECTORY_MESSAGES = 2000
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_MAXIMUM_SESSIONS = 10_000

class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super('Upstream JSON response exceeds the size limit.')
    this.name = 'UpstreamResponseTooLargeError'
  }
}

async function readBoundedUpstreamBody(
  response: Response,
  maximumBytes: number
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel()
    throw new UpstreamResponseTooLargeError()
  }
  if (response.body === null) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new UpstreamResponseTooLargeError()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

async function readBoundedUpstreamJson(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  return JSON.parse(
    (await readBoundedUpstreamBody(response, maximumBytes)).toString('utf8')
  )
}

interface ArtifactObject {
  body: Readable
  contentLength?: number
}

export interface ArtifactStore {
  getObject(key: string, signal: AbortSignal): Promise<ArtifactObject>
  putMemoryArtifact?(artifact: {
    bytes: Buffer
    digest: string
    mediaType: string
    objectKey: string
    sizeBytes: number
  }): Promise<void>
}

interface AvailableArtifact {
  digest: string
  key: string
  maximumSize: number
  sizeBytes: number
}

interface TrajectoryEvent {
  seq: number
  event: 'message'
  message: Record<string, unknown>
}

/** Parse only the append-only trajectory shape produced by TrajectoryWriter.
 *
 * This deliberately does not accept arbitrary JSON arrays or Python reprs. The viewer is an
 * operational reader for one owned artifact format, so format drift must fail visibly instead
 * of being guessed into a plausible but inaccurate conversation.
 */
function readTrajectoryArtifact(bytes: Buffer): TrajectoryEvent[] {
  const content = zstdDecompressSync(bytes, {
    maxOutputLength: MAX_TRAJECTORY_CONTENT_BYTES
  })
  const events: TrajectoryEvent[] = []
  let previousSeq = 0
  for (const rawLine of content.toString('utf8').split('\n')) {
    if (!rawLine.trim()) continue
    if (Buffer.byteLength(rawLine, 'utf8') > MAX_TRAJECTORY_LINE_BYTES)
      throw new Error('invalid_trajectory_artifact')
    const parsed: unknown = JSON.parse(rawLine)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('invalid_trajectory_artifact')
    const event = parsed as Record<string, unknown>
    if (
      !Number.isSafeInteger(event.seq) ||
      (event.seq as number) <= previousSeq ||
      event.event !== 'message' ||
      typeof event.message !== 'object' ||
      event.message === null ||
      Array.isArray(event.message)
    )
      throw new Error('invalid_trajectory_artifact')
    previousSeq = event.seq as number
    events.push({
      seq: previousSeq,
      event: 'message',
      message: event.message as Record<string, unknown>
    })
    if (events.length > MAX_TRAJECTORY_MESSAGES)
      throw new Error('invalid_trajectory_artifact')
  }
  return events
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
 * with the query reduced to the parameters Review Runs declares (generated from
 * `openapi.yaml`). Anything else the browser put in the URL (UI state such as `range`,
 * analytics parameters, typos) is dropped rather than forwarded, so this proxy cannot send
 * a request outside Review Runs's contract.
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

/** The UUID a Review Runs run id is (see the contract's `runId` path parameter). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether this BFF path is one of the reads the console may proxy upstream.
 *
 * The run-id segment is matched against the contract's UUID shape after percent-decoding, not
 * with a catch-all. A catch-all would still be safe today - Review Runs rejects a malformed id
 * with a 400 - but it widens the reachable surface to whatever path a future upstream read
 * endpoint might parse, so the allow-list states the exact shape it means.
 */
/** The operator writes the console may proxy: `/api/admin/runs/<uuid>/<action>`.
 *
 * The admin credential is supplied by the operator for that one request and forwarded as-is; the
 * BFF never reads or stores it. Keeping it out of the server means a compromised BFF cannot
 * abandon or resume runs, and Review Runs decides who is allowed to.
 */
// Same shape check as the read allow-list: the id is a UUID or the request is not one this BFF
// proxies. Sharing `RUN_ID` keeps the two policies from drifting apart.
const ADMIN_DECISION = new RegExp(
  `^/api/admin/runs/(${RUN_ID.source.slice(1, -1)})/(abandon|resume|give-up)$`
)

function isAllowedReadPath(bffUrl: string): boolean {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  if (url.pathname === '/api/runs') return true
  // A fixed sub-resource of the run collection, not a run id: it lists the runs coordination
  // has stopped retrying, so the console can show the operator queue without any write access.
  if (url.pathname === '/api/runs/parked') return true
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

function memoryCatalogPath(bffUrl: string): string | null {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  const path = url.pathname
  if (path === '/api/memory/tree') return `/v1/memory-tree${url.search}`
  if (
    path === '/api/memory/revisions' ||
    /^\/api\/memory\/revisions\/[1-9][0-9]*$/.test(path)
  )
    return `/v1/memory-tree${path.slice('/api/memory'.length)}${url.search}`
  const allowed =
    path === '/api/memory/overview' ||
    path === '/api/memory/extractions' ||
    path === '/api/memory/observations' ||
    path === '/api/memory/maintenance-control' ||
    /^\/api\/memory\/extractions\/[A-Za-z0-9._:-]+$/.test(path)
  if (!allowed) return null
  return `/v1${path.slice('/api/memory'.length)}${url.search}`
}

function redactArtifactUris(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactArtifactUris)
  if (typeof value !== 'object' || value === null) return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'uri' && typeof item === 'string' && item.startsWith('s3://'))
      continue
    result[key] = redactArtifactUris(item)
  }
  return result
}

function catalogArtifactReference(
  value: unknown,
  kind: 'tree' | 'trajectory'
): AvailableArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const artifact = value as Record<string, unknown>
  if (
    typeof artifact.uri !== 'string' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0 ||
    (kind === 'tree'
      ? artifact.media_type !== 'application/tar+zstd'
      : artifact.media_type !== 'application/zstd')
  )
    return null
  const maximumSize =
    kind === 'tree'
      ? MAX_MEMORY_TREE_ARTIFACT_BYTES
      : MAX_TRAJECTORY_ARTIFACT_BYTES
  if ((artifact.size_bytes as number) > maximumSize) return null
  const prefix = `s3://${ARTIFACT_BUCKET}/memory/${kind === 'tree' ? 'trees/' : 'trajectories/'}`
  if (!artifact.uri.startsWith(prefix)) return null
  if (
    kind === 'tree' &&
    artifact.uri !==
      `s3://${ARTIFACT_BUCKET}/${memoryTreeObjectKey(artifact.digest)}`
  )
    return null
  return {
    digest: artifact.digest,
    key: artifact.uri.slice(`s3://${ARTIFACT_BUCKET}/`.length),
    maximumSize,
    sizeBytes: artifact.size_bytes as number
  }
}

/**
 * The `content-type` served for a proxied Review Runs response.
 *
 * Every proxied route (the reads and the admin write) returns JSON, so the BFF answers with a
 * fixed JSON media type instead of echoing the upstream `content-type`. The upstream value is
 * only attacker-influenced if Review Runs is compromised, but copying it verbatim would serve
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
    maximumSize: MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES,
    sizeBytes: artifact.size_bytes as number
  }
}

function artifactStoreFromEnvironment(): ArtifactStore | undefined {
  const endpoint = process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT?.trim()
  const bucket = process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET?.trim()
  const addressingStyle =
    process.env.SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE?.trim() || 'auto'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!endpoint && !bucket) return undefined
  if (
    bucket !== ARTIFACT_BUCKET ||
    !accessKeyId ||
    !secretAccessKey ||
    !['auto', 'path', 'virtual'].includes(addressingStyle)
  )
    throw new Error(
      'Control Plane UI artifact storage configuration is invalid.'
    )
  const client = new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Omitting forcePathStyle preserves the SDK's native endpoint behavior for auto mode.
    ...(addressingStyle === 'auto'
      ? {}
      : { forcePathStyle: addressingStyle === 'path' }),
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
    },
    async putMemoryArtifact(artifact): Promise<void> {
      try {
        const existing = await client.send(
          new HeadObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: artifact.objectKey
          })
        )
        if (
          existing.ContentLength !== artifact.sizeBytes ||
          existing.ContentType !== artifact.mediaType ||
          existing.Metadata?.sha256 !== artifact.digest.slice('sha256:'.length)
        )
          throw new Error('memory_artifact_identity_mismatch')
        return
      } catch (error) {
        if (storageStatus(error) !== 404) throw error
      }
      await client.send(
        new PutObjectCommand({
          Bucket: ARTIFACT_BUCKET,
          Key: artifact.objectKey,
          Body: artifact.bytes,
          ContentType: artifact.mediaType,
          IfNoneMatch: '*',
          Metadata: {
            sha256: artifact.digest.slice('sha256:'.length),
            'size-bytes': String(artifact.sizeBytes)
          }
        })
      )
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
  reviewRunsUrl,
  reviewRunsToken,
  accessToken,
  memoryCatalogUrl,
  memoryCatalogOperatorToken,
  artifactStore,
  artifactDownloadIdleTimeoutMs = ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS,
  reviewRunsRequestTimeoutMs = REVIEW_RUNS_REQUEST_TIMEOUT_MS,
  upstreamJsonMaxBytes = MAX_UPSTREAM_JSON_BYTES,
  secureCookies = false,
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  maximumSessions = DEFAULT_MAXIMUM_SESSIONS,
  assets = path.resolve('dist')
}: {
  reviewRunsUrl: string
  reviewRunsToken: string
  accessToken: string
  memoryCatalogUrl?: string
  memoryCatalogOperatorToken?: string
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs?: number
  reviewRunsRequestTimeoutMs?: number
  upstreamJsonMaxBytes?: number
  secureCookies?: boolean
  sessionTtlSeconds?: number
  maximumSessions?: number
  assets?: string
}): Server {
  if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1)
    throw new RangeError('maximumSessions must be a positive integer')
  // Sessions are intentionally process-local: a restart revokes every browser session, and this
  // store retains only opaque token expirations rather than operator credentials.
  const sessions = new Map<string, number>()
  const prepareSessionSlot = (now: number): void => {
    for (const [session, expiresAt] of sessions)
      if (expiresAt <= now) sessions.delete(session)
    while (sessions.size >= maximumSessions) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }
  const sessionCookie = (request: IncomingMessage): string | undefined =>
    request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('control_plane_ui_session='))
      ?.slice('control_plane_ui_session='.length)
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
  const cookieSecurity = secureCookies ? '; Secure' : ''
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
      const sessionValue = crypto.randomBytes(32).toString('base64url')
      const now = Date.now()
      prepareSessionSlot(now)
      sessions.set(sessionValue, now + sessionTtlSeconds * 1000)
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtlSeconds}${cookieSecurity}`,
        'cache-control': 'no-store'
      })
      response.end()
      return
    }
    // Signing out can only be done by the server: the session cookie is HttpOnly, so
    // the console cannot clear it from script. Expiring it here forgets the credential
    // on this browser and removes its opaque value from the process-local session table.
    // It does not revoke the shared access token itself, which stays valid for anyone
    // else who holds it.
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
      const session = sessionCookie(request)
      if (session !== undefined) sessions.delete(session)
      response.writeHead(204, {
        'set-cookie': `control_plane_ui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecurity}`
      })
      response.end()
      return
    }
    if (request.url?.startsWith('/api/')) {
      if (!authenticated(request)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized"}')
        return
      }
      const memoryPath = memoryCatalogPath(request.url ?? '')
      const memoryWriteMatch =
        /^\/api\/memory\/(pause|resume|edit|restore)$/.exec(request.url ?? '')
      if (request.method === 'POST' && memoryWriteMatch !== null) {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross_site_request' })
          return
        }
        if (!memoryCatalogUrl || !memoryCatalogOperatorToken) {
          sendJson(response, 503, { error: 'memory_catalog_unavailable' })
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > MAX_SESSION_BODY_BYTES) {
            sendJson(response, 413, { error: 'request_too_large' })
            return
          }
          chunks.push(bytes)
        }
        try {
          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8')
          ) as Record<string, unknown>
          const action = memoryWriteMatch[1]
          let catalogPath: string
          let catalogBody: Record<string, unknown>
          if (action === 'pause' || action === 'resume') {
            catalogPath = `/v1/maintenance-control/${action}`
            catalogBody = {
              operation_id: body.operation_id,
              expected_generation: body.expected_generation
            }
          } else {
            if (action === 'edit') {
              if (!artifactStore?.putMemoryArtifact)
                throw new Error('memory_artifact_upload_unavailable')
              if (
                typeof body.files !== 'object' ||
                body.files === null ||
                Array.isArray(body.files)
              )
                throw new Error('invalid_memory_files')
              const files = new Map<string, string>()
              for (const [name, value] of Object.entries(body.files)) {
                if (typeof value !== 'string')
                  throw new Error('invalid_memory_files')
                files.set(name, value)
              }
              const artifact = await buildMemoryTreeArtifact(files)
              await artifactStore.putMemoryArtifact(artifact)
              const reference = {
                uri: `s3://${ARTIFACT_BUCKET}/${artifact.objectKey}`,
                digest: artifact.digest,
                media_type: artifact.mediaType,
                size_bytes: artifact.sizeBytes
              }
              catalogPath = '/v1/memory-tree/revisions'
              catalogBody = {
                expected_active_revision: body.expected_active_revision,
                memory_tree_reference: reference,
                source: {
                  kind: 'operator',
                  operation_id: body.operation_id
                }
              }
            } else {
              catalogPath = '/v1/memory-tree/restore'
              catalogBody = {
                operation_id: body.operation_id,
                expected_active_revision: body.expected_active_revision,
                restored_revision: body.restored_revision
              }
            }
          }
          const upstream = await fetch(`${memoryCatalogUrl}${catalogPath}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${memoryCatalogOperatorToken}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify(catalogBody),
            signal: AbortSignal.timeout(REVIEW_RUNS_REQUEST_TIMEOUT_MS)
          })
          const responseBody = await readBoundedUpstreamBody(
            upstream,
            upstreamJsonMaxBytes
          )
          response.writeHead(upstream.status, {
            'content-type': PROXIED_CONTENT_TYPE,
            'cache-control': 'no-store'
          })
          response.end(responseBody)
        } catch (error) {
          if (error instanceof UpstreamResponseTooLargeError) {
            sendJson(response, 502, { error: 'upstream_response_too_large' })
            return
          }
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : 'invalid_request'
          })
        }
        return
      }
      const memoryArtifactMatch =
        /^\/api\/memory\/(revisions|extractions)\/([^/?]+)\/(artifact|trajectory|content|trajectory\/content)$/.exec(
          request.url ?? ''
        )
      if (request.method === 'GET' && memoryArtifactMatch !== null) {
        if (
          !memoryCatalogUrl ||
          !memoryCatalogOperatorToken ||
          !artifactStore
        ) {
          sendJson(response, 503, { error: 'memory_artifact_unavailable' })
          return
        }
        const collection = memoryArtifactMatch[1]
        const identity = memoryArtifactMatch[2] ?? ''
        const requestedKind = memoryArtifactMatch[3]
        const trajectoryContent = requestedKind === 'trajectory/content'
        if (
          (collection === 'revisions' && !/^[1-9][0-9]*$/.test(identity)) ||
          (collection === 'extractions' &&
            !/^[A-Za-z0-9._:-]+$/.test(identity)) ||
          (collection === 'extractions' &&
            requestedKind !== 'trajectory' &&
            !trajectoryContent)
        ) {
          sendJson(response, 404, { error: 'memory_artifact_not_found' })
          return
        }
        try {
          const upstream = await fetch(
            `${memoryCatalogUrl}/v1/${collection === 'revisions' ? 'memory-tree/revisions' : 'extractions'}/${encodeURIComponent(identity)}`,
            {
              headers: {
                authorization: `Bearer ${memoryCatalogOperatorToken}`
              },
              signal: AbortSignal.timeout(REVIEW_RUNS_REQUEST_TIMEOUT_MS)
            }
          )
          if (!upstream.ok) {
            sendJson(response, upstream.status === 404 ? 404 : 502, {
              error:
                upstream.status === 404
                  ? 'memory_artifact_not_found'
                  : 'memory_catalog_unavailable'
            })
            return
          }
          const record = (await readBoundedUpstreamJson(
            upstream,
            upstreamJsonMaxBytes
          )) as Record<string, unknown>
          const source = record.source as Record<string, unknown> | undefined
          const rawReference =
            collection === 'extractions'
              ? record.trajectory_reference
              : requestedKind === 'artifact' || requestedKind === 'content'
                ? record.memory_tree_reference
                : source?.kind === 'maintenance'
                  ? source.trajectory_reference
                  : undefined
          const artifact = catalogArtifactReference(
            rawReference,
            requestedKind === 'artifact' || requestedKind === 'content'
              ? 'tree'
              : 'trajectory'
          )
          if (artifact === null) {
            sendJson(response, 409, { error: 'memory_artifact_unavailable' })
            return
          }
          const object = await artifactStore.getObject(
            artifact.key,
            AbortSignal.timeout(ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS)
          )
          if (
            object.contentLength !== undefined &&
            (object.contentLength !== artifact.sizeBytes ||
              object.contentLength > artifact.maximumSize)
          ) {
            object.body.destroy()
            throw new Error('artifact_identity_mismatch')
          }
          const chunks: Buffer[] = []
          let size = 0
          const digest = crypto.createHash('sha256')
          for await (const chunk of object.body) {
            const bytes = Buffer.from(chunk)
            size += bytes.length
            if (size > artifact.sizeBytes || size > artifact.maximumSize)
              throw new Error('artifact_identity_mismatch')
            digest.update(bytes)
            chunks.push(bytes)
          }
          if (
            size !== artifact.sizeBytes ||
            `sha256:${digest.digest('hex')}` !== artifact.digest
          )
            throw new Error('artifact_identity_mismatch')
          const complete = Buffer.concat(chunks)
          if (requestedKind === 'content') {
            const files = await readMemoryTreeArtifact(complete)
            response.writeHead(200, {
              'content-type': PROXIED_CONTENT_TYPE,
              'cache-control': 'no-store'
            })
            response.end(
              JSON.stringify({
                files: Object.fromEntries(
                  [...files].map(([name, value]) => [
                    name,
                    value.toString('utf8')
                  ])
                )
              })
            )
            return
          }
          if (trajectoryContent) {
            response.writeHead(200, {
              'content-type': PROXIED_CONTENT_TYPE,
              'cache-control': 'no-store'
            })
            response.end(
              JSON.stringify({ events: readTrajectoryArtifact(complete) })
            )
            return
          }
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${requestedKind === 'artifact' ? 'memory-tree.v1.tar.zst' : 'memory-trajectory.v1.jsonl.zst'}"`,
            'cache-control': 'no-store',
            'content-length': String(size)
          })
          response.end(complete)
        } catch (error) {
          sendJson(response, 502, {
            error:
              error instanceof UpstreamResponseTooLargeError
                ? 'upstream_response_too_large'
                : error instanceof Error &&
                    error.message === 'artifact_identity_mismatch'
                  ? 'artifact_identity_mismatch'
                  : 'memory_artifact_download_failed'
          })
        }
        return
      }
      if (request.method === 'GET' && memoryPath !== null) {
        if (!memoryCatalogUrl || !memoryCatalogOperatorToken) {
          sendJson(response, 503, { error: 'memory_catalog_unavailable' })
          return
        }
        try {
          const upstream = await fetch(`${memoryCatalogUrl}${memoryPath}`, {
            headers: {
              authorization: `Bearer ${memoryCatalogOperatorToken}`
            },
            signal: AbortSignal.timeout(REVIEW_RUNS_REQUEST_TIMEOUT_MS)
          })
          const bytes = await readBoundedUpstreamBody(
            upstream,
            upstreamJsonMaxBytes
          )
          if (!upstream.ok) {
            response.writeHead(upstream.status, {
              'content-type': PROXIED_CONTENT_TYPE,
              'cache-control': 'no-store'
            })
            response.end(bytes)
            return
          }
          const parsed: unknown = JSON.parse(bytes.toString('utf8'))
          response.writeHead(200, {
            'content-type': PROXIED_CONTENT_TYPE,
            'cache-control': 'no-store'
          })
          response.end(JSON.stringify(redactArtifactUris(parsed)))
        } catch (error) {
          const timedOut =
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
          sendJson(response, timedOut ? 504 : 502, {
            error:
              error instanceof UpstreamResponseTooLargeError
                ? 'upstream_response_too_large'
                : timedOut
                  ? 'memory_catalog_timeout'
                  : 'memory_catalog_unavailable'
          })
        }
        return
      }
      const artifactContentMatch =
        /^\/api\/runs\/([^/?]+)\/artifact\/content$/.exec(request.url)
      if (request.method === 'GET' && artifactContentMatch !== null) {
        if (artifactStore === undefined) {
          sendJson(response, 503, { error: 'artifact_view_unavailable' })
          return
        }
        let runId: string
        try {
          runId = decodeURIComponent(artifactContentMatch[1] ?? '')
        } catch {
          sendJson(response, 400, { error: 'invalid_run_id' })
          return
        }
        if (!runId || runId.includes('/')) {
          sendJson(response, 400, { error: 'invalid_run_id' })
          return
        }
        const controller = new AbortController()
        let timedOut = false
        const timeout = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, reviewRunsRequestTimeoutMs)
        try {
          const upstream = await fetch(
            `${reviewRunsUrl}/v1/runs/${encodeURIComponent(runId)}`,
            {
              headers: { authorization: `Bearer ${reviewRunsToken}` },
              signal: controller.signal
            }
          )
          if (upstream.status === 404) {
            sendJson(response, 404, { error: 'artifact_not_found' })
            return
          }
          if (!upstream.ok) {
            sendJson(response, 502, { error: 'review_runs_unavailable' })
            return
          }
          const body = (await readBoundedUpstreamJson(
            upstream,
            upstreamJsonMaxBytes
          )) as {
            run?: { run_id?: unknown; artifact_storage?: unknown }
          }
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
          if (artifact.sizeBytes > MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES) {
            sendJson(response, 413, { error: 'artifact_preview_too_large' })
            return
          }
          const object = await artifactStore.getObject(
            artifact.key,
            controller.signal
          )
          if (
            object.contentLength !== undefined &&
            object.contentLength !== artifact.sizeBytes
          ) {
            object.body.destroy()
            sendJson(response, 502, { error: 'artifact_identity_mismatch' })
            return
          }
          const chunks: Buffer[] = []
          const digest = crypto.createHash('sha256')
          let sizeBytes = 0
          for await (const chunk of object.body) {
            const bytes = Buffer.from(chunk)
            sizeBytes += bytes.length
            if (sizeBytes > artifact.sizeBytes)
              throw new Error('artifact_identity_mismatch')
            digest.update(bytes)
            chunks.push(bytes)
          }
          if (
            sizeBytes !== artifact.sizeBytes ||
            `sha256:${digest.digest('hex')}` !== artifact.digest
          )
            throw new Error('artifact_identity_mismatch')
          const view = await readDiagnosticBundle(Buffer.concat(chunks), runId)
          response.writeHead(200, {
            'content-type': PROXIED_CONTENT_TYPE,
            'cache-control': 'private, no-store'
          })
          response.end(
            JSON.stringify({
              files: view.files,
              unpreviewable_files: view.unpreviewableFiles
            })
          )
        } catch (error) {
          if (response.headersSent || response.destroyed) return
          const message = error instanceof Error ? error.message : ''
          sendJson(response, timedOut ? 504 : 502, {
            error: timedOut
              ? 'artifact_view_timeout'
              : error instanceof UpstreamResponseTooLargeError
                ? 'upstream_response_too_large'
                : message === 'artifact_identity_mismatch'
                  ? 'artifact_identity_mismatch'
                  : message === 'diagnostic_bundle_too_large'
                    ? 'artifact_preview_too_large'
                    : 'invalid_diagnostic_bundle'
          })
        } finally {
          clearTimeout(timeout)
        }
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
        }, reviewRunsRequestTimeoutMs)
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
            `${reviewRunsUrl}/v1/runs/${encodeURIComponent(runId)}`,
            {
              headers: { authorization: `Bearer ${reviewRunsToken}` },
              signal: metadataController.signal
            }
          )
          if (upstream.status === 404) {
            sendJson(response, 404, { error: 'artifact_not_found' })
            return
          }
          if (!upstream.ok) {
            sendJson(response, 502, { error: 'review_runs_unavailable' })
            return
          }
          const body = (await readBoundedUpstreamJson(
            upstream,
            upstreamJsonMaxBytes
          )) as {
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
                    ? 'review_runs_timeout'
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
      const decision = ADMIN_DECISION.exec(request.url ?? '')
      if (request.method === 'POST' && decision !== null) {
        // A session cookie alone must not authorise a cross-site POST: the same check the
        // sign-out route uses.
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross_site_request' })
          return
        }
        const adminToken = request.headers['x-review-runs-admin-token']
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
          // The action is taken from the matched route, never from the raw URL, so the
          // upstream path can only be one of the two decisions this BFF states it proxies.
          const action =
            decision[2] === 'resume'
              ? 'resume'
              : decision[2] === 'give-up'
                ? 'give-up'
                : 'abandon'
          const upstream = await fetch(
            `${reviewRunsUrl}/v1/admin/runs/${encodeURIComponent(
              decodeURIComponent(decision[1] ?? '')
            )}/${action}`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${adminToken}`,
                'content-type': 'application/json'
              },
              body: Buffer.concat(chunks),
              signal: AbortSignal.timeout(REVIEW_RUNS_REQUEST_TIMEOUT_MS)
            }
          )
          const responseBody = await readBoundedUpstreamBody(
            upstream,
            upstreamJsonMaxBytes
          )
          response.writeHead(upstream.status, {
            'content-type': PROXIED_CONTENT_TYPE
          })
          response.end(responseBody)
        } catch (error) {
          const timedOut =
            error instanceof Error &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
          sendJson(response, timedOut ? 504 : 502, {
            error:
              error instanceof UpstreamResponseTooLargeError
                ? 'upstream_response_too_large'
                : timedOut
                  ? 'review_runs_timeout'
                  : 'review_runs_unavailable'
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
        REVIEW_RUNS_REQUEST_TIMEOUT_MS
      )
      try {
        const upstream = await fetch(
          `${reviewRunsUrl}/v1${forwardedPath(request.url ?? '/')}`,
          {
            headers: { authorization: `Bearer ${reviewRunsToken}` },
            signal: controller.signal
          }
        )
        const responseBody = await readBoundedUpstreamBody(
          upstream,
          upstreamJsonMaxBytes
        )
        response.writeHead(upstream.status, {
          'content-type': PROXIED_CONTENT_TYPE
        })
        response.end(responseBody)
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError'
        response.writeHead(timedOut ? 504 : 502, {
          'content-type': 'application/json'
        })
        response.end(
          JSON.stringify({
            error:
              error instanceof UpstreamResponseTooLargeError
                ? 'upstream_response_too_large'
                : timedOut
                  ? 'review_runs_timeout'
                  : 'review_runs_unavailable'
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
  import.meta.filename === path.resolve(process.argv[1])
) {
  const reviewRunsToken = process.env.REVIEW_RUNS_READ_TOKEN
  const accessToken = process.env.CONTROL_PLANE_UI_ACCESS_TOKEN
  const secureCookiesValue =
    process.env.CONTROL_PLANE_UI_SECURE_COOKIES?.trim() || 'false'
  if (!['true', 'false'].includes(secureCookiesValue))
    throw new Error('CONTROL_PLANE_UI_SECURE_COOKIES must be true or false.')
  if (!reviewRunsToken) throw new Error('REVIEW_RUNS_READ_TOKEN is required.')
  if (!accessToken)
    throw new Error('CONTROL_PLANE_UI_ACCESS_TOKEN is required.')
  createControlPlaneUiServer({
    reviewRunsUrl: process.env.REVIEW_RUNS_URL ?? 'http://127.0.0.1:8090',
    reviewRunsToken,
    accessToken,
    secureCookies: secureCookiesValue === 'true',
    memoryCatalogUrl: process.env.MEMORY_CATALOG_URL,
    memoryCatalogOperatorToken: process.env.MEMORY_CATALOG_OPERATOR_TOKEN,
    artifactStore: artifactStoreFromEnvironment()
  }).listen(
    Number.parseInt(process.env.CONTROL_PLANE_UI_PORT ?? '8091', 10),
    process.env.CONTROL_PLANE_UI_HOST?.trim() || '127.0.0.1'
  )
}
