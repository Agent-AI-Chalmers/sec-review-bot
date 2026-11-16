import type {
  RunResponse,
  ExecutionWorkflow,
  WorkflowInputByName,
} from './execution-api-types-generated.js'

// Derive each workflow/input pair from the generated API mapping. The Temporal
// contract adds the handoff fields; runtime validation checks both contracts.
export type ExecutionWorkflowInput = {
  [Workflow in ExecutionWorkflow]: {
    workflow: Workflow
    run_id: string
    input: WorkflowInputByName[Workflow]
    timeout_seconds: number
    runtime?: { workspace_image?: string } | null
  }
}[ExecutionWorkflow]

export type ExecutionRecord = RunResponse & {
  run_id: string
  workflow?: string
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
