import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ArtifactStore } from '../artifacts/store.js'
import { PROXIED_CONTENT_TYPE, sendJson } from '../http.js'
import type { MemoryCatalogClient } from '../upstream/memory-catalog-client.js'
import { sendUpstreamFailure, writeUpstreamResult } from '../upstream/relay.js'
import { createMemoryWriteRoutes } from './memory-writes.js'
import { createMemoryArtifactRoutes } from './memory-artifacts.js'

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

/** Compose Memory routes and project Catalog query responses for the browser. */
export function createMemoryRoutes({
  catalog,
  artifactStore,
  artifactDownloadIdleTimeoutMs
}: {
  catalog?: MemoryCatalogClient
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs: number
}): MemoryRoutes {
  const writes = createMemoryWriteRoutes({ catalog, artifactStore })
  const artifacts = createMemoryArtifactRoutes({
    catalog,
    artifactStore,
    artifactDownloadIdleTimeoutMs
  })

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
        writeUpstreamResult(response, upstream, { cacheControl: 'no-store' })
        return
      }
      const parsed: unknown = JSON.parse(upstream.body.toString('utf8'))
      response.writeHead(200, {
        'content-type': PROXIED_CONTENT_TYPE,
        'cache-control': 'no-store'
      })
      response.end(JSON.stringify(redactArtifactUris(parsed)))
    } catch (error) {
      sendUpstreamFailure(response, 'memory_catalog', error)
    }
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (await writes.handle(request, response)) return true
    if (await artifacts.handle(request, response)) return true
    if (request.method !== 'GET') return false
    const path = memoryCatalogPath(request.url ?? '')
    if (path === null) return false
    await readMemoryPage(response, path)
    return true
  }
  return { handle }
}
