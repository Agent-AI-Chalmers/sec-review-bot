import type {
  ExecutionArtifactStorage,
  ExecutionWorkflow,
  WorkflowInputByName,
} from './execution-api-types-generated.js'

export interface ExecutionWorkflowInput {
  workflow: ExecutionWorkflow
  run_id: string
  input: WorkflowInputByName[ExecutionWorkflow]
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
  artifact_storage?: ExecutionArtifactStorage
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
