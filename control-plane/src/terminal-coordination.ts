import type { ReviewRunRecord, ReviewRunStore } from './review-store.js'
import type { ExecutionRunStatus } from './execution-client.js'

type ObservationStore = Pick<
  ReviewRunStore,
  | 'markRunning'
  | 'recordExecutionSuccess'
  | 'failExecution'
  | 'touchObservation'
>
export type ExecutionObservationResult =
  'active' | 'succeeded' | 'failed' | 'poll_retry'
export interface ExecutionObservationEvent {
  kind:
    | 'execution_poll_retry'
    | 'execution_state_changed'
    | 'execution_terminal_recorded'
  run_id: string
  workflow: ReviewRunRecord['workflow']
  from: ReviewRunRecord['execution']['status']
  to: ExecutionObservationResult
  error_code?: string
}

function errorInfo(error: unknown): { code: string; message: string } {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'EXECUTION_FAILED'
  return {
    code,
    message: error instanceof Error ? error.message : String(error)
  }
}

/** Persists Execution state only; connector-specific interpretation and publication happen later. */
export async function observeExecutionRun(
  store: ObservationStore,
  run: ReviewRunRecord,
  getStatus: (
    runId: string,
    workflow: ReviewRunRecord['workflow']
  ) => Promise<ExecutionRunStatus>,
  isTerminalPollingError: (error: unknown) => boolean,
  onEvent: (event: ExecutionObservationEvent) => void = () => {}
): Promise<ExecutionObservationResult> {
  let status: ExecutionRunStatus
  try {
    status = await getStatus(run.run_id, run.workflow)
  } catch (error) {
    if (!isTerminalPollingError(error)) {
      onEvent({
        kind: 'execution_poll_retry',
        run_id: run.run_id,
        workflow: run.workflow,
        from: run.execution.status,
        to: 'poll_retry'
      })
      return 'poll_retry'
    }
    await store.failExecution(run.run_id, errorInfo(error))
    onEvent({
      kind: 'execution_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.execution.status,
      to: 'failed',
      error_code: errorInfo(error).code
    })
    return 'failed'
  }
  if (status.status === 'running') {
    // `markRunning` only writes on the queued -> running transition; when the run is already
    // running, retry the heartbeat so `execution.updated_at` keeps advancing. If the store has
    // already seen a different state, the UPDATE matches nothing and the run stays as observed.
    if (!(await store.markRunning(run.run_id))) {
      await store.touchObservation(run.run_id)
      return 'active'
    }
    onEvent({
      kind: 'execution_state_changed',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.execution.status,
      to: 'active'
    })
    return 'active'
  }
  if (status.status !== 'succeeded' && status.status !== 'failed') {
    // The Execution still reports an unfinished task. Refresh the observation heartbeat only for
    // the states it applies to; `touchObservation` is a no-op for pending/uncertain.
    await store.touchObservation(run.run_id)
    return 'active'
  }
  if (status.status === 'failed') {
    const recorded = await store.failExecution(
      run.run_id,
      status.error === undefined
        ? {
            code: 'EXECUTION_FAILED',
            message: `Execution run failed without an error: ${run.run_id}`
          }
        : {
            code: status.error.code ?? 'EXECUTION_FAILED',
            message: status.error.message ?? 'Execution failed.'
          },
      status.artifact_storage
    )
    if (!recorded) return 'failed'
    onEvent({
      kind: 'execution_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.execution.status,
      to: 'failed',
      error_code: status.error?.code ?? 'EXECUTION_FAILED'
    })
    return 'failed'
  }
  // Only a missing field is checked here, not a null one. A top-level `null` cannot arrive:
  // the Execution validates the result against the v1 contract before it reports `succeeded`
  // (`temporal_gateway.py`), and its response model serializes with `exclude_none`, so a null
  // would be omitted rather than sent as `"result": null`. Checking for null here would be
  // defensive code for an unreachable input. It matters that the assumption stays true: a
  // stored JSON `null` would be excluded by the `jsonb_typeof(...) <> 'null'` guard on every
  // publication claim, stranding the run with a publication no claim can pick up.
  if (!Object.hasOwn(status, 'result')) {
    await store.failExecution(run.run_id, {
      code: 'EXECUTION_RESULT_MISSING',
      message: 'Execution succeeded without a workflow result.'
    })
    onEvent({
      kind: 'execution_terminal_recorded',
      run_id: run.run_id,
      workflow: run.workflow,
      from: run.execution.status,
      to: 'failed',
      error_code: 'EXECUTION_RESULT_MISSING'
    })
    return 'failed'
  }
  if (
    !(await store.recordExecutionSuccess(
      run.run_id,
      status.result,
      status.artifact_storage
    ))
  ) {
    return 'succeeded'
  }
  onEvent({
    kind: 'execution_terminal_recorded',
    run_id: run.run_id,
    workflow: run.workflow,
    from: run.execution.status,
    to: 'succeeded'
  })
  return 'succeeded'
}
