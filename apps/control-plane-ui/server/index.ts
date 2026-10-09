import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

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

interface PublishedArtifact {
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
const allowed = /^\/api\/runs(?:\?.*)?$|^\/api\/runs\/[^/?]+(?:\/publication-steps)?$/

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function publishedArtifact(
  value: unknown,
  runId: string,
  bucket: string
): PublishedArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const publication = value as Record<string, unknown>
  if (publication.status !== 'published') return null
  if (
    typeof publication.artifact !== 'object' ||
    publication.artifact === null ||
    Array.isArray(publication.artifact)
  )
    return null
  const artifact = publication.artifact as Record<string, unknown>
  const expectedUri = `s3://${bucket}/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  if (
    artifact.kind !== 'diagnostic_bundle' ||
    artifact.uri !== expectedUri ||
    artifact.media_type !== 'application/vnd.sec-review.diagnostic.v1+tar+zstd' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    return null
  const key = expectedUri.slice(`s3://${bucket}/`.length)
  return { digest: artifact.digest, key, sizeBytes: artifact.size_bytes as number }
}

function artifactStoreFromEnvironment(): ArtifactStore | undefined {
  const endpoint = process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT?.trim()
  const bucket = process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET?.trim()
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!endpoint && !bucket) return undefined
  if (!endpoint || bucket !== ARTIFACT_BUCKET || !accessKeyId || !secretAccessKey)
    throw new Error('Control Plane UI artifact storage configuration is invalid.')
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
      if (!(object.Body instanceof Readable)) throw new Error('RustFS returned no readable body.')
      return {
        body: object.Body,
        ...(object.ContentLength === undefined ? {} : { contentLength: object.ContentLength })
      }
    }
  }
}

function storageStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const metadata = '$metadata' in error ? error.$metadata : undefined
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata))
    return undefined
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined
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
      const artifactMatch = /^\/api\/runs\/([^/?]+)\/artifact$/.exec(request.url)
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
          const upstream = await fetch(`${controlPlaneUrl}/v1/runs/${encodeURIComponent(runId)}`, {
            headers: { authorization: `Bearer ${controlPlaneToken}` },
            signal: metadataController.signal
          })
          if (upstream.status === 404) {
            sendJson(response, 404, { error: 'artifact_not_found' })
            return
          }
          if (!upstream.ok) {
            sendJson(response, 502, { error: 'control_plane_unavailable' })
            return
          }
          const body = (await upstream.json()) as {
            run?: { run_id?: unknown; artifact_publication?: unknown }
          }
          clearTimeout(metadataTimeout)
          const artifact =
            body.run?.run_id === runId
              ? publishedArtifact(body.run.artifact_publication, runId, ARTIFACT_BUCKET)
              : null
          if (artifact === null) {
            sendJson(response, 409, { error: 'artifact_not_available' })
            return
          }
          resetDownloadIdleTimeout()
          const object = await artifactStore.getObject(artifact.key, downloadController.signal)
          if (object.contentLength !== undefined && object.contentLength !== artifact.sizeBytes) {
            object.body.destroy()
            sendJson(response, 502, { error: 'artifact_identity_mismatch' })
            return
          }
          temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sec-review-artifact-'))
          const temporaryArtifact = path.join(temporaryDirectory, 'diagnostic-tree.v1.tar.zst')
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
          await pipeline(object.body, verify, createWriteStream(temporaryArtifact), {
            signal: downloadController.signal
          })
          clearTimeout(downloadIdleTimeout)
          const actualDigest = `sha256:${digest.digest('hex')}`
          if (sizeBytes !== artifact.sizeBytes || actualDigest !== artifact.digest) {
            sendJson(response, 502, { error: 'artifact_identity_mismatch' })
            return
          }
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="diagnostic-tree.v1.tar.zst"',
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
            error instanceof Error && error.message === 'artifact_identity_mismatch'
          sendJson(
            response,
            status === 404 ? 404 : metadataTimedOut || downloadTimedOut ? 504 : 502,
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
    accessToken,
    artifactStore: artifactStoreFromEnvironment()
  }).listen(Number.parseInt(process.env.CONTROL_PLANE_UI_PORT ?? '8091', 10), '0.0.0.0')
}
