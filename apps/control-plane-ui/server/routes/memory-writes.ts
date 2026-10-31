import type { IncomingMessage, ServerResponse } from 'node:http'

import { ARTIFACT_BUCKET, type ArtifactStore } from '../artifacts/store.js'
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody,
  sendJson
} from '../http.js'
import { requireSameOrigin } from '../request-security.js'
import type { MemoryCatalogClient } from '../upstream/memory-catalog-client.js'
import { sendUpstreamFailure, writeUpstreamResult } from '../upstream/relay.js'
import { buildMemoryTreeArtifact } from '../memory/memory-tree-artifact.js'

type MemoryWriteCommand = { operation_id: string } & (
  | { action: 'pause' | 'resume'; expected_generation: number }
  | {
      action: 'restore'
      expected_active_revision: number
      restored_revision: number
    }
  | {
      action: 'edit'
      expected_active_revision: number
      files: Map<string, string>
    }
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  )
}

/** Validate browser input before constructing Catalog writes or uploading artifacts. */
function parseMemoryWriteCommand(
  action: string,
  value: unknown
): MemoryWriteCommand | { error: 'invalid_request' | 'invalid_memory_files' } {
  if (
    !isRecord(value) ||
    typeof value.operation_id !== 'string' ||
    !/^[A-Za-z0-9._:-]+$/.test(value.operation_id)
  )
    return { error: 'invalid_request' }
  const operation_id = value.operation_id
  if (action === 'pause' || action === 'resume') {
    if (!isIntegerAtLeast(value.expected_generation, 0))
      return { error: 'invalid_request' }
    return {
      action,
      operation_id,
      expected_generation: value.expected_generation
    }
  }
  if (action === 'restore') {
    if (
      !isIntegerAtLeast(value.expected_active_revision, 1) ||
      !isIntegerAtLeast(value.restored_revision, 1)
    )
      return { error: 'invalid_request' }
    return {
      action,
      operation_id,
      expected_active_revision: value.expected_active_revision,
      restored_revision: value.restored_revision
    }
  }
  if (action !== 'edit' || !isIntegerAtLeast(value.expected_active_revision, 0))
    return { error: 'invalid_request' }
  if (!isRecord(value.files)) return { error: 'invalid_memory_files' }
  const files = new Map<string, string>()
  for (const [name, content] of Object.entries(value.files)) {
    if (typeof content !== 'string') return { error: 'invalid_memory_files' }
    files.set(name, content)
  }
  return {
    action,
    operation_id,
    expected_active_revision: value.expected_active_revision,
    files
  }
}

/** Keep the edit's complete publication protocol together, including its final commit. */
async function publishMemoryEdit({
  response,
  catalog,
  artifactStore,
  command
}: {
  response: ServerResponse
  catalog: MemoryCatalogClient
  artifactStore: ArtifactStore | undefined
  command: Extract<MemoryWriteCommand, { action: 'edit' }>
}): Promise<void> {
  if (!artifactStore?.putMemoryArtifact) {
    sendJson(response, 503, { error: 'memory_artifact_upload_unavailable' })
    return
  }
  let artifact: Awaited<ReturnType<typeof buildMemoryTreeArtifact>>
  try {
    artifact = await buildMemoryTreeArtifact(command.files)
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : 'invalid_request'
    })
    return
  }
  const intent = {
    expected_active_revision: command.expected_active_revision,
    memory_tree_reference: {
      uri: `s3://${ARTIFACT_BUCKET}/${artifact.objectKey}`,
      digest: artifact.digest,
      media_type: artifact.mediaType,
      size_bytes: artifact.sizeBytes
    },
    source: { kind: 'operator', operation_id: command.operation_id }
  }
  const reserved = await catalog.write(
    '/v1/memory-tree/revisions/publications/reserve',
    intent
  )
  if (reserved.status < 200 || reserved.status >= 300) {
    writeUpstreamResult(response, reserved, { cacheControl: 'no-store' })
    return
  }
  try {
    await artifactStore.putMemoryArtifact(artifact)
  } catch {
    sendJson(response, 502, { error: 'memory_artifact_upload_failed' })
    return
  }
  const confirmed = await catalog.write(
    '/v1/memory-tree/revisions/publications/confirm',
    intent
  )
  if (confirmed.status < 200 || confirmed.status >= 300) {
    writeUpstreamResult(response, confirmed, { cacheControl: 'no-store' })
    return
  }
  const committed = await catalog.write('/v1/memory-tree/revisions', intent)
  writeUpstreamResult(response, committed, { cacheControl: 'no-store' })
}

export interface MemoryWriteRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own validation and side effects for operator memory writes. */
export function createMemoryWriteRoutes({
  catalog,
  artifactStore
}: {
  catalog?: MemoryCatalogClient
  artifactStore?: ArtifactStore
}): MemoryWriteRoutes {
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
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      sendJson(response, 400, { error: 'invalid_request' })
      return
    }
    const command = parseMemoryWriteCommand(action, parsed)
    if ('error' in command) {
      sendJson(response, 400, command)
      return
    }
    try {
      switch (command.action) {
        case 'pause':
        case 'resume': {
          const upstream = await catalog.write(
            `/v1/maintenance-control/${command.action}`,
            {
              operation_id: command.operation_id,
              expected_generation: command.expected_generation
            }
          )
          writeUpstreamResult(response, upstream, { cacheControl: 'no-store' })
          return
        }
        case 'restore': {
          const upstream = await catalog.write('/v1/memory-tree/restore', {
            operation_id: command.operation_id,
            expected_active_revision: command.expected_active_revision,
            restored_revision: command.restored_revision
          })
          writeUpstreamResult(response, upstream, { cacheControl: 'no-store' })
          return
        }
        case 'edit':
          await publishMemoryEdit({ response, catalog, artifactStore, command })
      }
    } catch (error) {
      sendUpstreamFailure(response, 'memory_catalog', error)
    }
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.method !== 'POST') return false
    const match = /^\/api\/memory\/(pause|resume|edit|restore)$/.exec(
      request.url ?? ''
    )
    if (match === null) return false
    await writeMemory(request, response, match[1])
    return true
  }
  return { handle }
}
