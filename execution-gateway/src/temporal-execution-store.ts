import { createHash } from 'node:crypto'

import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from '@temporalio/client'

import {
  executionWorkflowType,
  isExecutionError,
  validateExecutionResult,
  validateExecutionRequest,
} from './contract-validation.js'
import {
  ExecutionRunConflictError,
  type ExecutionRecord,
  type ExecutionRequest,
} from './execution.js'

function fingerprint(request: ExecutionRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(request)))
    .digest('hex')
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

function statusName(status: { name?: string } | string | undefined): string {
  if (typeof status === 'string') return status
  return status?.name ?? 'UNKNOWN'
}

export class TemporalExecutionStore {
  private constructor(
    private readonly connection: Connection,
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  static async connect(): Promise<TemporalExecutionStore> {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS?.trim() || '127.0.0.1:7233',
    })
    const client = new Client({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE?.trim() || 'default',
    })
    return new TemporalExecutionStore(
      connection,
      client,
      process.env.TEMPORAL_EXECUTION_TASK_QUEUE?.trim() ||
        'sec-review-execution',
    )
  }

  async start(request: ExecutionRequest): Promise<ExecutionRecord> {
    validateExecutionRequest(request)
    const requestFingerprint = fingerprint(request)
    try {
      await this.client.workflow.start(executionWorkflowType(), {
        args: [request],
        taskQueue: this.taskQueue,
        workflowId: request.run_id,
        workflowExecutionTimeout: `${request.timeout_seconds}s`,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        memo: {
          workflow: request.workflow,
          request_fingerprint: requestFingerprint,
        },
      })
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
      const existing = await this.get(request.run_id)
      const description = await this.client.workflow
        .getHandle(request.run_id)
        .describe()
      if (
        description.memo?.request_fingerprint === requestFingerprint &&
        existing
      ) {
        return existing
      }
      throw new ExecutionRunConflictError(
        request.run_id,
        request.workflow,
        existing?.workflow,
      )
    }
    return (
      (await this.get(request.run_id)) ?? {
        run_id: request.run_id,
        workflow: request.workflow,
        status: 'queued',
      }
    )
  }

  async get(runId: string): Promise<ExecutionRecord | undefined> {
    const handle = this.client.workflow.getHandle(runId)
    let description
    try {
      description = await handle.describe()
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return undefined
      throw error
    }
    const temporalStatus = statusName(description.status)
    const workflow =
      typeof description.memo?.workflow === 'string'
        ? description.memo.workflow
        : undefined
    if (temporalStatus === 'RUNNING') {
      return {
        run_id: runId,
        ...(workflow ? { workflow } : {}),
        status: 'running',
      }
    }
    if (temporalStatus === 'COMPLETED') {
      const response = (await handle.result()) as Record<string, unknown>
      if (response.ok === true && 'result' in response) {
        if (!workflow) {
          return {
            run_id: runId,
            status: 'failed',
            artifact_storage: { status: 'unavailable' },
            error: executionError(
              'EXECUTION_RESPONSE_INVALID',
              'Completed execution is missing its workflow identity.',
            ),
          }
        }
        try {
          validateExecutionResult(workflow, response.result)
        } catch (error) {
          return {
            run_id: runId,
            workflow,
            status: 'failed',
            artifact_storage: { status: 'unavailable' },
            error: executionError(
              'EXECUTION_RESPONSE_INVALID',
              error instanceof Error ? error.message : String(error),
            ),
          }
        }
        let artifact_storage: ArtifactStorageProjection
        try {
          artifact_storage = parseRunDiagnosticArtifact(
            response.artifact_storage,
            runId,
          )
        } catch (error) {
          return {
            run_id: runId,
            workflow,
            status: 'failed',
            artifact_storage: {
              status: 'failed',
              error_code: 'ARTIFACT_REFERENCE_INVALID',
              message: 'Execution returned an invalid run diagnostic artifact.',
            },
            error: executionError(
              'EXECUTION_RESPONSE_INVALID',
              error instanceof Error ? error.message : String(error),
            ),
          }
        }
        return {
          run_id: runId,
          ...(workflow ? { workflow } : {}),
          status: 'succeeded',
          result: response.result,
          artifact_storage,
          ...(typeof response.memory_processing === 'object' &&
          response.memory_processing !== null
            ? {
                memory_processing: response.memory_processing as Record<
                  string,
                  unknown
                >,
              }
            : {}),
        }
      }
      return {
        run_id: runId,
        ...(workflow ? { workflow } : {}),
        status: 'failed',
        artifact_storage: { status: 'unavailable' },
        error: isExecutionError(response.error)
          ? response.error
          : executionError(
              'EXECUTION_RESPONSE_INVALID',
              'Invalid workflow response.',
            ),
      }
    }
    return {
      run_id: runId,
      ...(workflow ? { workflow } : {}),
      status: 'failed',
      artifact_storage: { status: 'unavailable' },
      error: executionError(
        'EXECUTION_FAILED',
        `Temporal workflow ended with status ${temporalStatus}.`,
      ),
    }
  }

  async close(): Promise<void> {
    await this.connection.close()
  }
}

interface ArtifactStorageProjection {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: {
    kind: 'diagnostic_bundle'
    uri: string
    media_type: 'application/tar+zstd'
    digest: string
    size_bytes: number
  }
  error_code?: string
  message?: string
}

export function parseRunDiagnosticArtifact(
  value: unknown,
  runId: string,
): ArtifactStorageProjection {
  if (!isRecord(value) || value.status !== 'available')
    throw new Error('Execution response is missing artifact_storage.')
  const artifact = value.artifact
  if (
    !isRecord(artifact) ||
    artifact.kind !== 'diagnostic_bundle' ||
    artifact.media_type !== 'application/tar+zstd' ||
    typeof artifact.uri !== 'string' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    throw new Error('Execution response has malformed artifact metadata.')
  const uri = new URL(artifact.uri)
  if (
    uri.protocol !== 's3:' ||
    uri.hostname === '' ||
    uri.pathname !== `/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst` ||
    uri.username !== '' ||
    uri.password !== '' ||
    uri.port !== '' ||
    uri.search !== '' ||
    uri.hash !== ''
  )
    throw new Error(
      'Execution response has an invalid diagnostic artifact URI.',
    )
  return {
    status: 'available',
    artifact: {
      kind: 'diagnostic_bundle',
      uri: artifact.uri,
      media_type: 'application/tar+zstd',
      digest: artifact.digest,
      size_bytes: artifact.size_bytes as number,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function executionError(
  code: string,
  message: string,
): Record<string, unknown> {
  return { category: 'runtime', code, message, retryable: false, details: {} }
}
