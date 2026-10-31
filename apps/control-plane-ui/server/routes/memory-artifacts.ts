import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ArtifactStore } from '../artifacts/store.js'
import type { PublishedArtifact } from '../artifacts/published-artifact.js'
import {
  ArtifactDownloadTimeoutError,
  readVerifiedArtifactBuffer
} from '../artifacts/verified-artifact.js'
import { PROXIED_CONTENT_TYPE, sendJson } from '../http.js'
import type { MemoryCatalogClient } from '../upstream/memory-catalog-client.js'
import { UpstreamRequestError } from '../upstream/request.js'
import { catalogArtifactReference } from '../memory/artifact-reference.js'
import { readMemoryTreeArtifact } from '../memory/memory-tree-artifact.js'
import { readTrajectoryArtifact } from '../memory/trajectory-artifact.js'

type MemoryArtifactRequest = {
  identity: string
  view: 'download' | 'content'
} & (
  | { kind: 'tree'; collection: 'revisions' }
  | { kind: 'trajectory'; collection: 'revisions' | 'extractions' }
)

/** Resolve the HTTP representation into a valid artifact source and view. */
function parseMemoryArtifactRequest(
  collection: string,
  identity: string,
  representation: string
): MemoryArtifactRequest | null {
  if (collection !== 'revisions' && collection !== 'extractions') return null
  if (collection === 'revisions' && !/^[1-9][0-9]*$/.test(identity)) return null
  if (collection === 'extractions' && !/^[A-Za-z0-9._:-]+$/.test(identity))
    return null
  switch (representation) {
    case 'artifact':
    case 'content':
      if (collection !== 'revisions') return null
      return {
        collection,
        identity,
        kind: 'tree',
        view: representation === 'content' ? 'content' : 'download'
      }
    case 'trajectory':
    case 'trajectory/content':
      return {
        collection,
        identity,
        kind: 'trajectory',
        view: representation === 'trajectory/content' ? 'content' : 'download'
      }
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publishedMemoryArtifact(
  record: unknown,
  request: MemoryArtifactRequest
): PublishedArtifact {
  if (!isRecord(record)) throw new Error('invalid_memory_catalog_record')
  if (request.kind === 'tree')
    return catalogArtifactReference(record.memory_tree_reference, 'tree')
  if (request.collection === 'extractions')
    return catalogArtifactReference(record.trajectory_reference, 'trajectory')
  const source = record.source
  if (!isRecord(source) || source.kind !== 'maintenance')
    return { kind: 'invalid' }
  return catalogArtifactReference(source.trajectory_reference, 'trajectory')
}

function memoryArtifactFailure(error: unknown): {
  status: number
  error: string
} {
  if (
    error instanceof ArtifactDownloadTimeoutError ||
    (error instanceof UpstreamRequestError && error.kind === 'timeout')
  )
    return { status: 504, error: 'memory_artifact_download_timeout' }
  if (error instanceof UpstreamRequestError && error.kind === 'too_large')
    return { status: 502, error: 'upstream_response_too_large' }
  if (error instanceof Error && error.message === 'artifact_identity_mismatch')
    return { status: 502, error: 'artifact_identity_mismatch' }
  return { status: 502, error: 'memory_artifact_download_failed' }
}

export interface MemoryArtifactRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own artifact source selection, verification, preview, and attachment responses. */
export function createMemoryArtifactRoutes({
  catalog,
  artifactStore,
  artifactDownloadIdleTimeoutMs
}: {
  catalog?: MemoryCatalogClient
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs: number
}): MemoryArtifactRoutes {
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.method !== 'GET') return false
    const match =
      /^\/api\/memory\/(revisions|extractions)\/([^/?]+)\/(artifact|trajectory|content|trajectory\/content)$/.exec(
        request.url ?? ''
      )
    if (match === null) return false
    if (catalog === undefined || artifactStore === undefined) {
      sendJson(response, 503, { error: 'memory_artifact_unavailable' })
      return true
    }
    const artifactRequest = parseMemoryArtifactRequest(
      match[1],
      match[2],
      match[3]
    )
    if (artifactRequest === null) {
      sendJson(response, 404, { error: 'memory_artifact_not_found' })
      return true
    }
    try {
      const upstream = await catalog.getArtifactRecord(
        artifactRequest.collection,
        artifactRequest.identity
      )
      if (upstream.status < 200 || upstream.status >= 300) {
        sendJson(response, upstream.status === 404 ? 404 : 502, {
          error:
            upstream.status === 404
              ? 'memory_artifact_not_found'
              : 'memory_catalog_unavailable'
        })
        return true
      }
      const record: unknown = JSON.parse(upstream.body.toString('utf8'))
      const published = publishedMemoryArtifact(record, artifactRequest)
      if (published.kind === 'invalid') {
        sendJson(response, 409, { error: 'memory_artifact_unavailable' })
        return true
      }
      if (published.kind === 'too_large') {
        sendJson(response, 413, { error: 'artifact_too_large' })
        return true
      }
      const complete = await readVerifiedArtifactBuffer(
        artifactStore,
        published.artifact,
        { idleTimeoutMs: artifactDownloadIdleTimeoutMs }
      )
      if (artifactRequest.view === 'content') {
        let content: object
        if (artifactRequest.kind === 'tree') {
          const files = await readMemoryTreeArtifact(complete)
          content = {
            files: Object.fromEntries(
              [...files].map(([name, value]) => [name, value.toString('utf8')])
            )
          }
        } else {
          content = { events: readTrajectoryArtifact(complete) }
        }
        response.writeHead(200, {
          'content-type': PROXIED_CONTENT_TYPE,
          'cache-control': 'no-store'
        })
        response.end(JSON.stringify(content))
        return true
      }
      const filename =
        artifactRequest.kind === 'tree'
          ? 'memory-tree.v1.tar.zst'
          : 'memory-trajectory.v1.jsonl.zst'
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'content-length': String(complete.length)
      })
      response.end(complete)
    } catch (error) {
      const failure = memoryArtifactFailure(error)
      sendJson(response, failure.status, { error: failure.error })
    }
    return true
  }
  return { handle }
}
