export type WorkflowName = 'issue-review' | 'pull-request-review' | 'repository-review'
type JsonObject = Record<string, unknown>
interface RunnerServiceErrorBody {
  message?: string
  code?: string
  category?: string
  retryable?: boolean
  details?: JsonObject
}
export interface RunnerArtifactStorage {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: { kind: string; uri: string; media_type: string; digest: string; size_bytes: number }
  error_code?: string
  message?: string
}
export interface RunnerRunStatus {
  run_id: string | null
  workflow: WorkflowName | null
  status: string
  result?: unknown
  error?: RunnerServiceErrorBody
  artifact_storage?: RunnerArtifactStorage
}
export interface RunnerWorkflowResponse {
  run_id: string
  workflow: WorkflowName
  result: unknown
}

function serviceError(status: RunnerRunStatus, fallback?: RunnerServiceErrorBody): Error {
  const source = status.error ?? fallback ?? {}
  return Object.assign(new Error(source.message ?? 'Runner returned an unknown execution error.'), {
    name: 'AgentRunnerServiceError',
    code: source.code ?? 'RUNNER_SERVICE_ERROR',
    category: source.category ?? 'runtime',
    retryable: source.retryable ?? false,
    details: source.details ?? {},
    run_id: status.run_id,
    workflow: status.workflow
  })
}

/** Parses a terminal result already observed and persisted by Control Plane. */
export function completedRunnerRunResult(status: RunnerRunStatus): RunnerWorkflowResponse | null {
  if (status.status !== 'succeeded' && status.status !== 'failed') return null
  if (status.error !== undefined) throw serviceError(status)
  if (status.status === 'failed')
    throw serviceError(status, {
      code: 'RUNNER_EXECUTION_FAILED',
      message: `Runner completed run ${status.run_id ?? '(unknown)'} without an error body.`,
      retryable: false
    })
  if (status.workflow === null || status.run_id === null)
    throw new Error('Runner completed a run without run metadata.')
  return { run_id: status.run_id, workflow: status.workflow, result: status.result }
}
