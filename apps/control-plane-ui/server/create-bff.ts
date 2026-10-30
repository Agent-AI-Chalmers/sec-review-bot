import { createServer, type Server } from 'node:http'
import path from 'node:path'

import type { ArtifactStore } from './artifacts/store.js'
import { applySecurityHeaders } from './request-security.js'
import { createMemoryRoutes } from './routes/memory.js'
import { createReviewRunsRoutes } from './routes/review-runs.js'
import { createRunArtifactRoutes } from './routes/run-artifacts.js'
import { createSessionRoutes } from './routes/session.js'
import { createStaticRoutes } from './routes/static.js'
import { createMemoryCatalogClient } from './upstream/memory-catalog-client.js'
import { createReviewRunsClient } from './upstream/review-runs-client.js'

export type { ArtifactStore } from './artifacts/store.js'

const MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024
const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 10_000
const ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_MAXIMUM_SESSIONS = 10_000

/** Create the Control Plane UI BFF: same-origin API, session boundary, and upstream adapters. */
export function createControlPlaneUiBffServer({
  reviewRunsUrl,
  reviewRunsToken,
  accessToken,
  memoryCatalogUrl,
  memoryCatalogOperatorToken,
  artifactStore,
  artifactDownloadIdleTimeoutMs = ARTIFACT_DOWNLOAD_IDLE_TIMEOUT_MS,
  reviewRunsRequestTimeoutMs = DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
  memoryCatalogRequestTimeoutMs = DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
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
  memoryCatalogRequestTimeoutMs?: number
  upstreamJsonMaxBytes?: number
  secureCookies?: boolean
  sessionTtlSeconds?: number
  maximumSessions?: number
  assets?: string
}): Server {
  const sessionRoutes = createSessionRoutes({
    accessToken,
    maximumSessions,
    secureCookies,
    sessionTtlSeconds
  })
  const reviewRuns = createReviewRunsClient({
    baseUrl: reviewRunsUrl,
    readToken: reviewRunsToken,
    requestTimeoutMs: reviewRunsRequestTimeoutMs,
    maximumResponseBytes: upstreamJsonMaxBytes
  })
  const memoryCatalog =
    memoryCatalogUrl && memoryCatalogOperatorToken
      ? createMemoryCatalogClient({
          baseUrl: memoryCatalogUrl,
          operatorToken: memoryCatalogOperatorToken,
          requestTimeoutMs: memoryCatalogRequestTimeoutMs,
          maximumResponseBytes: upstreamJsonMaxBytes
        })
      : undefined
  const apiRoutes = [
    createMemoryRoutes({
      catalog: memoryCatalog,
      artifactStore,
      artifactDownloadIdleTimeoutMs
    }),
    createRunArtifactRoutes({
      reviewRuns,
      artifactStore,
      artifactDownloadIdleTimeoutMs
    }),
    createReviewRunsRoutes({ reviewRuns })
  ]
  const staticRoutes = createStaticRoutes({ assets })

  return createServer(async (request, response) => {
    applySecurityHeaders(response)
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    if (await sessionRoutes.handle(request, response)) return
    if (request.url?.startsWith('/api/')) {
      if (!sessionRoutes.authenticated(request)) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"unauthorized"}')
        return
      }
      for (const routes of apiRoutes)
        if (await routes.handle(request, response)) return
      response.writeHead(404)
      response.end()
      return
    }
    await staticRoutes.handle(request, response)
  })
}
