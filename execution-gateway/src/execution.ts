import type {
  ExecutionWorkflow,
  WorkflowInputByName,
} from './contract-types-generated.js'

export interface ExecutionRequest {
  workflow: ExecutionWorkflow
  run_id: string
  input_data: WorkflowInputByName[ExecutionWorkflow]
  timeout_seconds: number
  runtime?: { workspace_image?: string } | null
}

export interface ExecutionRecord {
  run_id: string
  workflow?: string
  status: string
  result?: unknown
  error?: Record<string, unknown>
  memory_processing?: Record<string, unknown>
  artifact_storage?: {
    status: 'available' | 'unavailable' | 'failed'
    artifact?: {
      kind: 'diagnostic_bundle'
      uri: string
      media_type: string
      digest: string
      size_bytes: number
    }
    error_code?: string
    message?: string
  }
}

export class ExecutionRunConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly requestedWorkflow: string,
    readonly existingWorkflow?: string,
  ) {
    super(`Execution run_id ${runId} is already bound to another request.`)
  }
}
