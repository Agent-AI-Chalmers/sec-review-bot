import type { ReviewRunRecord, ReviewRunStore } from './review-store.js'
import type { RunnerRunStatus } from './runner-client.js'

type ObservationStore = Pick<
  ReviewRunStore,
  'markRunning' | 'recordRunnerSuccess' | 'failRunnerExecution'
>
export type RunnerObservationResult = 'active' | 'succeeded' | 'failed' | 'poll_retry'
export interface RunnerObservationEvent {
  kind: 'runner_poll_retry' | 'runner_state_changed' | 'runner_terminal_recorded'
  run_id: string
  workflow: ReviewRunRecord['workflow']
  from: ReviewRunRecord['status']
  to: RunnerObservationResult
  error_code?: string
}

function errorInfo(error: unknown): { code: string; message: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'RUNNER_EXECUTION_FAILED'
  return { code, message: error instanceof Error ? error.message : String(error) }
}

/** Persists Runner state only; connector-specific interpretation and publication happen later. */
export async function observeRunnerRun(
  store: ObservationStore,
  run: ReviewRunRecord,
  getStatus: (runId: string, workflow: ReviewRunRecord['workflow']) => Promise<RunnerRunStatus>,
  isTerminalPollingError: (error: unknown) => boolean,
  onEvent: (event: RunnerObservationEvent) => void = () => {}
): Promise<RunnerObservationResult> {
  let status: RunnerRunStatus
  try {
    status = await getStatus(run.run_id, run.workflow)
  } catch (error) {
    if (!isTerminalPollingError(error)) {
      onEvent({
        kind: 'runner_poll_retry',
        run_id: run.run_id,
        workflow: run.workflow,
        from: run.status,
        to: 'poll_retry'
      })
      return 'poll_retry'
    }
    await store.failRunnerExecution(run.run_id, errorInfo(error))
    onEvent({
      kind: 'runner_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.status,
      to: 'failed',
      error_code: errorInfo(error).code
    })
    return 'failed'
  }
  if (status.status === 'running') {
    await store.markRunning(run.run_id)
    onEvent({
      kind: 'runner_state_changed',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.status,
      to: 'active'
    })
    return 'active'
  }
  if (status.status !== 'succeeded' && status.status !== 'failed') return 'active'
  if (status.status === 'failed') {
    const recorded = await store.failRunnerExecution(
      run.run_id,
      status.error === undefined
        ? {
            code: 'RUNNER_EXECUTION_FAILED',
            message: `Runner run failed without an error: ${run.run_id}`
          }
        : {
            code: status.error.code ?? 'RUNNER_EXECUTION_FAILED',
            message: status.error.message ?? 'Runner execution failed.'
          },
      status.artifact_publication
    )
    if (!recorded) return 'failed'
    onEvent({
      kind: 'runner_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.status,
      to: 'failed',
      error_code: status.error?.code ?? 'RUNNER_EXECUTION_FAILED'
    })
    return 'failed'
  }
  if (!Object.hasOwn(status, 'result')) {
    await store.failRunnerExecution(run.run_id, {
      code: 'RUNNER_RESULT_MISSING',
      message: 'Runner succeeded without a workflow result.'
    })
    onEvent({
      kind: 'runner_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.status,
      to: 'failed',
      error_code: 'RUNNER_RESULT_MISSING'
    })
    return 'failed'
  }
  await store.recordRunnerSuccess(run.run_id, status.result, status.artifact_publication)
  onEvent({
    kind: 'runner_terminal_recorded',
    run_id: run.run_id,
    workflow: run.workflow,
    from: run.status,
    to: 'succeeded'
  })
  return 'succeeded'
}
