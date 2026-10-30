import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'

import {
  ARTIFACT_BUCKET,
  type ArtifactStore,
  artifactStorageStatus
} from '../artifacts/store.js'
import {
  ArtifactDownloadTimeoutError,
  readVerifiedArtifactBuffer,
  withVerifiedArtifactFile
} from '../artifacts/verified-artifact.js'
import { PROXIED_CONTENT_TYPE, sendJson } from '../http-response.js'
import type { ReviewRunsClient } from '../upstream/review-runs-client.js'
import { UpstreamRequestError } from '../upstream/request.js'
import { availableArtifact } from '../run/artifact-reference.js'
import {
  MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES,
  readDiagnosticBundle
} from '../run/diagnostic-bundle.js'

function decodeRunId(raw: string | undefined): string | null {
  let runId: string
  try {
    runId = decodeURIComponent(raw ?? '')
  } catch {
    return null
  }
  return !runId || runId.includes('/') ? null : runId
}

export interface RunArtifactRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own the run diagnostic preview and attachment download. */
export function createRunArtifactRoutes({
  reviewRuns,
  artifactStore,
  artifactDownloadIdleTimeoutMs
}: {
  reviewRuns: ReviewRunsClient
  artifactStore?: ArtifactStore
  artifactDownloadIdleTimeoutMs: number
}): RunArtifactRoutes {
  const preview = async (
    response: ServerResponse,
    runId: string
  ): Promise<void> => {
    if (artifactStore === undefined) {
      sendJson(response, 503, { error: 'artifact_view_unavailable' })
      return
    }
    try {
      const upstream = await reviewRuns.getRun(runId)
      if (upstream.status === 404) {
        sendJson(response, 404, { error: 'artifact_not_found' })
        return
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        sendJson(response, 502, { error: 'review_runs_unavailable' })
        return
      }
      const body = JSON.parse(upstream.body.toString('utf8')) as {
        run?: { run_id?: unknown; artifact_storage?: unknown }
      }
      const artifact =
        body.run?.run_id === runId
          ? availableArtifact(body.run.artifact_storage, runId, ARTIFACT_BUCKET)
          : null
      if (artifact === null) {
        sendJson(response, 409, { error: 'artifact_unavailable' })
        return
      }
      if (artifact.sizeBytes > MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES) {
        sendJson(response, 413, { error: 'artifact_preview_too_large' })
        return
      }
      const complete = await readVerifiedArtifactBuffer(
        artifactStore,
        artifact,
        { idleTimeoutMs: artifactDownloadIdleTimeoutMs }
      )
      const view = await readDiagnosticBundle(complete, runId)
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
      const timedOut =
        error instanceof ArtifactDownloadTimeoutError ||
        (error instanceof UpstreamRequestError && error.kind === 'timeout')
      sendJson(response, timedOut ? 504 : 502, {
        error: timedOut
          ? 'artifact_view_timeout'
          : error instanceof UpstreamRequestError && error.kind === 'too_large'
            ? 'upstream_response_too_large'
            : message === 'artifact_identity_mismatch'
              ? 'artifact_identity_mismatch'
              : message === 'diagnostic_bundle_too_large'
                ? 'artifact_preview_too_large'
                : 'invalid_diagnostic_bundle'
      })
    }
  }

  const download = async (
    request: IncomingMessage,
    response: ServerResponse,
    runId: string
  ): Promise<void> => {
    if (artifactStore === undefined) {
      sendJson(response, 503, { error: 'artifact_download_unavailable' })
      return
    }
    const downloadController = new AbortController()
    request.once('aborted', () => downloadController.abort())
    response.once('close', () => {
      if (!response.writableEnded) downloadController.abort()
    })
    try {
      const upstream = await reviewRuns.getRun(runId)
      if (upstream.status === 404) {
        sendJson(response, 404, { error: 'artifact_not_found' })
        return
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        sendJson(response, 502, { error: 'review_runs_unavailable' })
        return
      }
      const body = JSON.parse(upstream.body.toString('utf8')) as {
        run?: { run_id?: unknown; artifact_storage?: unknown }
      }
      const artifact =
        body.run?.run_id === runId
          ? availableArtifact(body.run.artifact_storage, runId, ARTIFACT_BUCKET)
          : null
      if (artifact === null) {
        sendJson(response, 409, { error: 'artifact_unavailable' })
        return
      }
      await withVerifiedArtifactFile(
        artifactStore,
        artifact,
        {
          filename: 'diagnostic-tree.v1.tar.zst',
          idleTimeoutMs: artifactDownloadIdleTimeoutMs,
          signal: downloadController.signal
        },
        async (file) => {
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition':
              'attachment; filename="diagnostic-tree.v1.tar.zst"',
            'cache-control': 'private, no-store',
            'content-length': String(file.sizeBytes)
          })
          await pipeline(createReadStream(file.path), response, {
            signal: downloadController.signal
          })
        }
      )
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      const status = artifactStorageStatus(error)
      const identityMismatch =
        error instanceof Error && error.message === 'artifact_identity_mismatch'
      const metadataTimedOut =
        error instanceof UpstreamRequestError && error.kind === 'timeout'
      const downloadTimedOut = error instanceof ArtifactDownloadTimeoutError
      sendJson(
        response,
        status === 404 ? 404 : metadataTimedOut || downloadTimedOut ? 504 : 502,
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
    }
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.method !== 'GET') return false
    const contentMatch = /^\/api\/runs\/([^/?]+)\/artifact\/content$/.exec(
      request.url ?? ''
    )
    if (contentMatch !== null) {
      const runId = decodeRunId(contentMatch[1])
      if (runId === null) {
        sendJson(response, 400, { error: 'invalid_run_id' })
        return true
      }
      await preview(response, runId)
      return true
    }
    const artifactMatch = /^\/api\/runs\/([^/?]+)\/artifact$/.exec(
      request.url ?? ''
    )
    if (artifactMatch !== null) {
      const runId = decodeRunId(artifactMatch[1])
      if (runId === null) {
        sendJson(response, 400, { error: 'invalid_run_id' })
        return true
      }
      await download(request, response, runId)
      return true
    }
    return false
  }

  return { handle }
}
