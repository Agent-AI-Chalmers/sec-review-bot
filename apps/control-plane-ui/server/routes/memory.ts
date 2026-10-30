import type { IncomingMessage, ServerResponse } from 'node:http'

import { ARTIFACT_BUCKET, type ArtifactStore } from '../artifacts/store.js'
import {
  ArtifactDownloadTimeoutError,
  readVerifiedArtifactBuffer
} from '../artifacts/verified-artifact.js'
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody
} from '../http-request.js'
import { PROXIED_CONTENT_TYPE, sendJson } from '../http-response.js'
import { requireSameOrigin } from '../request-security.js'
import type { MemoryCatalogClient } from '../upstream/memory-catalog-client.js'
import { UpstreamRequestError } from '../upstream/request.js'
import { catalogArtifactReference } from '../memory/artifact-reference.js'
import {
  buildMemoryTreeArtifact,
  readMemoryTreeArtifact
} from '../memory/memory-tree-artifact.js'
import { readTrajectoryArtifact } from '../memory/trajectory-artifact.js'

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

export interface MemoryRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own Memory Catalog reads, writes, and memory artifact projections. */
export function createMemoryRoutes({
  catalog,
  artifactStore,
  artifactDownloadIdleTimeoutMs
}: {
  catalog?: MemoryCatalogClient
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs: number
}): MemoryRoutes {
  const writeMemory = async (
    request: IncomingMessage,
    response: ServerResponse,
    action: string
  ): Promise<void> => {
    if (!requireSameOrigin(request, response)) return
    if (catalog === undefined) {
      sendJson(response, 503, { error: 'memory_catalog_unavailable' })
      return
    }
    let raw: Buffer
    try {
      raw = await readBoundedRequestBody(request)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: 'request_too_large' })
        return
      }
      throw error
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      sendJson(response, 400, { error: 'invalid_request' })
      return
    }
    let catalogPath: string
    let catalogBody: Record<string, unknown>
    if (action === 'pause' || action === 'resume') {
      catalogPath = `/v1/maintenance-control/${action}`
      catalogBody = {
        operation_id: body.operation_id,
        expected_generation: body.expected_generation
      }
    } else if (action === 'restore') {
      catalogPath = '/v1/memory-tree/restore'
      catalogBody = {
        operation_id: body.operation_id,
        expected_active_revision: body.expected_active_revision,
        restored_revision: body.restored_revision
      }
    } else {
      if (!artifactStore?.putMemoryArtifact) {
        sendJson(response, 503, {
          error: 'memory_artifact_upload_unavailable'
        })
        return
      }
      if (
        typeof body.files !== 'object' ||
        body.files === null ||
        Array.isArray(body.files)
      ) {
        sendJson(response, 400, { error: 'invalid_memory_files' })
        return
      }
      const files = new Map<string, string>()
      for (const [name, value] of Object.entries(body.files)) {
        if (typeof value !== 'string') {
          sendJson(response, 400, { error: 'invalid_memory_files' })
          return
        }
        files.set(name, value)
      }
      let artifact: Awaited<ReturnType<typeof buildMemoryTreeArtifact>>
      try {
        artifact = await buildMemoryTreeArtifact(files)
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : 'invalid_request'
        })
        return
      }
      try {
        await artifactStore.putMemoryArtifact(artifact)
      } catch {
        sendJson(response, 502, { error: 'memory_artifact_upload_failed' })
        return
      }
      catalogPath = '/v1/memory-tree/revisions'
      catalogBody = {
        expected_active_revision: body.expected_active_revision,
        memory_tree_reference: {
          uri: `s3://${ARTIFACT_BUCKET}/${artifact.objectKey}`,
          digest: artifact.digest,
          media_type: artifact.mediaType,
          size_bytes: artifact.sizeBytes
        },
        source: {
          kind: 'operator',
          operation_id: body.operation_id
        }
      }
    }
    try {
      const upstream = await catalog.write(catalogPath, catalogBody)
      response.writeHead(upstream.status, {
        'content-type': PROXIED_CONTENT_TYPE,
        'cache-control': 'no-store'
      })
      response.end(upstream.body)
    } catch (error) {
      const kind =
        error instanceof UpstreamRequestError ? error.kind : 'unavailable'
      sendJson(response, kind === 'timeout' ? 504 : 502, {
        error:
          kind === 'too_large'
            ? 'upstream_response_too_large'
            : kind === 'timeout'
              ? 'memory_catalog_timeout'
              : 'memory_catalog_unavailable'
      })
    }
  }

  const readMemoryArtifact = async (
    response: ServerResponse,
    collection: 'revisions' | 'extractions',
    identity: string,
    requestedKind: string
  ): Promise<void> => {
    if (catalog === undefined || artifactStore === undefined) {
      sendJson(response, 503, { error: 'memory_artifact_unavailable' })
      return
    }
    const trajectoryContent = requestedKind === 'trajectory/content'
    if (
      (collection === 'revisions' && !/^[1-9][0-9]*$/.test(identity)) ||
      (collection === 'extractions' && !/^[A-Za-z0-9._:-]+$/.test(identity)) ||
      (collection === 'extractions' &&
        requestedKind !== 'trajectory' &&
        !trajectoryContent)
    ) {
      sendJson(response, 404, { error: 'memory_artifact_not_found' })
      return
    }
    try {
      const upstream = await catalog.getArtifactRecord(collection, identity)
      if (upstream.status < 200 || upstream.status >= 300) {
        sendJson(response, upstream.status === 404 ? 404 : 502, {
          error:
            upstream.status === 404
              ? 'memory_artifact_not_found'
              : 'memory_catalog_unavailable'
        })
        return
      }
      const record = JSON.parse(upstream.body.toString('utf8')) as Record<
        string,
        unknown
      >
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
      const complete = await readVerifiedArtifactBuffer(
        artifactStore,
        artifact,
        { idleTimeoutMs: artifactDownloadIdleTimeoutMs }
      )
      if (requestedKind === 'content') {
        const files = await readMemoryTreeArtifact(complete)
        response.writeHead(200, {
          'content-type': PROXIED_CONTENT_TYPE,
          'cache-control': 'no-store'
        })
        response.end(
          JSON.stringify({
            files: Object.fromEntries(
              [...files].map(([name, value]) => [name, value.toString('utf8')])
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
        'content-length': String(complete.length)
      })
      response.end(complete)
    } catch (error) {
      const timedOut =
        error instanceof ArtifactDownloadTimeoutError ||
        (error instanceof UpstreamRequestError && error.kind === 'timeout')
      sendJson(response, timedOut ? 504 : 502, {
        error: timedOut
          ? 'memory_artifact_download_timeout'
          : error instanceof UpstreamRequestError && error.kind === 'too_large'
            ? 'upstream_response_too_large'
            : error instanceof Error &&
                error.message === 'artifact_identity_mismatch'
              ? 'artifact_identity_mismatch'
              : 'memory_artifact_download_failed'
      })
    }
  }

  const readMemoryPage = async (
    response: ServerResponse,
    path: string
  ): Promise<void> => {
    if (catalog === undefined) {
      sendJson(response, 503, { error: 'memory_catalog_unavailable' })
      return
    }
    try {
      const upstream = await catalog.read(path)
      if (upstream.status < 200 || upstream.status >= 300) {
        response.writeHead(upstream.status, {
          'content-type': PROXIED_CONTENT_TYPE,
          'cache-control': 'no-store'
        })
        response.end(upstream.body)
        return
      }
      const parsed: unknown = JSON.parse(upstream.body.toString('utf8'))
      response.writeHead(200, {
        'content-type': PROXIED_CONTENT_TYPE,
        'cache-control': 'no-store'
      })
      response.end(JSON.stringify(redactArtifactUris(parsed)))
    } catch (error) {
      const kind =
        error instanceof UpstreamRequestError ? error.kind : 'unavailable'
      sendJson(response, kind === 'timeout' ? 504 : 502, {
        error:
          kind === 'too_large'
            ? 'upstream_response_too_large'
            : kind === 'timeout'
              ? 'memory_catalog_timeout'
              : 'memory_catalog_unavailable'
      })
    }
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.method === 'POST') {
      const writeMatch = /^\/api\/memory\/(pause|resume|edit|restore)$/.exec(
        request.url ?? ''
      )
      if (writeMatch !== null) {
        await writeMemory(request, response, writeMatch[1] ?? '')
        return true
      }
    }
    if (request.method === 'GET') {
      const artifactMatch =
        /^\/api\/memory\/(revisions|extractions)\/([^/?]+)\/(artifact|trajectory|content|trajectory\/content)$/.exec(
          request.url ?? ''
        )
      if (artifactMatch !== null) {
        await readMemoryArtifact(
          response,
          artifactMatch[1] === 'revisions' ? 'revisions' : 'extractions',
          artifactMatch[2] ?? '',
          artifactMatch[3] ?? ''
        )
        return true
      }
      const path = memoryCatalogPath(request.url ?? '')
      if (path !== null) {
        await readMemoryPage(response, path)
        return true
      }
    }
    return false
  }

  return { handle }
}
