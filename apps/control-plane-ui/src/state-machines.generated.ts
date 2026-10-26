// Generated from contracts/control-plane-api/v1/openapi.yaml (path relative to the repository
// root). Do not edit. The contract's `x-state-machines` block is the single source of truth;
// this file is its TypeScript view. Regenerate it with
// `pnpm --dir contracts/control-plane-api/tools run generate`.

export type StateAxis = 'preparation' | 'execution' | 'publication'

export interface StateTransition {
  from: string
  to: string
  reason?: string
  label?: string
}

export interface StateDetail {
  label: string
  description: string
}

export interface StateMachine {
  axis: StateAxis
  order: number
  title: string
  field: string
  initial: string
  terminal: string[]
  states: string[]
  details: Record<string, StateDetail>
  transitions: StateTransition[]
}

/** Every declared state machine. Which of them the console draws is a presentation decision
 * that lives in the console, not here. */
export const STATE_MACHINES: readonly StateMachine[] = [
  {
    axis: 'preparation',
    order: 1,
    title: 'Preparation',
    field: 'preparation.status',
    initial: 'pending',
    terminal: ['submitted', 'failed'],
    states: [
      'pending',
      'preparing',
      'uncertain',
      'disconnected',
      'submitted',
      'failed'
    ],
    details: {
      pending: {
        label: 'Pending',
        description: 'Admitted, but no preparer has claimed the work yet.'
      },
      preparing: {
        label: 'Preparing',
        description:
          'A coordinator currently owns the claim and is building the Execution input.'
      },
      uncertain: {
        label: 'Uncertain',
        description:
          'The claim lapsed before the preparer reported, so it is unknown whether the prepared input reached Control Plane. This is not a failure: a claim may rebuild the input and resubmit it under the same identity, which is idempotent.'
      },
      disconnected: {
        label: 'Disconnected',
        description:
          "Automatic work stopped without a conclusion, because the run's persisted state no longer admits the only transition expiry could make. Nothing retries this row on its own; an operator resumes it into `uncertain` or abandons it."
      },
      submitted: {
        label: 'Submitted',
        description:
          'The input was accepted and handed to the Execution API provider; preparation is done.'
      },
      failed: {
        label: 'Failed',
        description:
          'Preparation failed permanently (retry budget exhausted or input could not be built). The Execution API provider was never handed input, so execution is skipped.'
      }
    },
    transitions: [
      {
        from: 'pending',
        to: 'preparing',
        label: 'claimed'
      },
      {
        from: 'preparing',
        to: 'submitted',
        label: 'input accepted'
      },
      {
        from: 'preparing',
        to: 'pending',
        label: 'retry'
      },
      {
        from: 'preparing',
        to: 'uncertain',
        label: 'claim lapsed'
      },
      {
        from: 'uncertain',
        to: 'preparing',
        label: 'reclaim to confirm'
      },
      {
        from: 'preparing',
        to: 'disconnected',
        reason: 'EXECUTION_ALREADY_ADVANCED',
        label: 'cannot be concluded automatically'
      },
      {
        from: 'disconnected',
        to: 'uncertain',
        reason: 'PREPARATION_RESUMED_BY_OPERATOR',
        label: 'resumed by an operator'
      },
      {
        from: 'disconnected',
        to: 'failed',
        reason: 'PREPARATION_GIVEN_UP_BY_OPERATOR',
        label: 'given up by an operator'
      },
      {
        from: 'disconnected',
        to: 'failed',
        reason: 'EXECUTION_ALREADY_ADVANCED',
        label: 'abandoned by an operator'
      },
      {
        from: 'disconnected',
        to: 'failed',
        reason: 'PREPARATION_ABANDONED',
        label: 'abandoned by an operator'
      },
      {
        from: 'preparing',
        to: 'failed',
        label: 'failed'
      }
    ]
  },
  {
    axis: 'execution',
    order: 2,
    title: 'Execution',
    field: 'execution.status',
    initial: 'pending',
    terminal: ['succeeded', 'skipped', 'failed'],
    states: [
      'pending',
      'queued',
      'running',
      'succeeded',
      'skipped',
      'uncertain',
      'disconnected',
      'failed'
    ],
    details: {
      pending: {
        label: 'Pending',
        description:
          'Admitted, but its prepared input has not been submitted to the Execution API provider yet.'
      },
      queued: {
        label: 'Queued',
        description:
          'The Execution API provider accepted the submission; polling has not yet seen it start.'
      },
      running: {
        label: 'Running',
        description:
          'Polling observed that the Execution API provider is executing this run. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be slightly out of date.'
      },
      succeeded: {
        label: 'Succeeded',
        description:
          'The Execution API provider returned a result; it now becomes eligible for publication.'
      },
      skipped: {
        label: 'Skipped',
        description:
          'Execution never ran because preparation failed. This is not an execution failure; the reason is on the preparation axis.'
      },
      uncertain: {
        label: 'Unconfirmed',
        description:
          'The task was submitted, but no response arrived, so it is unknown whether the Execution API provider accepted it. This is not a failure: the submission is replayed under the same run_id.'
      },
      disconnected: {
        label: 'Disconnected',
        description:
          'Automatic recovery used its budget without a conclusive Execution API provider answer. The run is visible for operator action and is not reported as failed.'
      },
      failed: {
        label: 'Failed',
        description:
          'A definite failure, in one of two ways: (1) polling produced a conclusive answer that the task cannot succeed — the Execution API provider reported it failed, or the run could not be found, returned no result, or the response broke the protocol; (2) a retried submission failed conclusively. A transient network error (a timeout, a 5xx, a dropped connection) is not a definite failure.'
      }
    },
    transitions: [
      {
        from: 'pending',
        to: 'queued',
        label: 'input submitted'
      },
      {
        from: 'pending',
        to: 'skipped',
        label: 'preparation failed'
      },
      {
        from: 'pending',
        to: 'uncertain',
        reason: 'SUBMISSION_STATE_UNCERTAIN',
        label: 'submission unconfirmed'
      },
      {
        from: 'uncertain',
        to: 'uncertain',
        reason: 'SUBMISSION_RECOVERY_CLAIMED',
        label: 'replay claimed'
      },
      {
        from: 'uncertain',
        to: 'queued',
        label: 'replay accepted'
      },
      {
        from: 'uncertain',
        to: 'failed',
        label: 'replay rejected'
      },
      {
        from: 'uncertain',
        to: 'disconnected',
        reason: 'SUBMISSION_RECOVERY_EXHAUSTED',
        label: 'recovery disconnected'
      },
      {
        from: 'disconnected',
        to: 'uncertain',
        reason: 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR',
        label: 'resumed by an operator'
      },
      {
        from: 'disconnected',
        to: 'failed',
        reason: 'SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR',
        label: 'given up by an operator'
      },
      {
        from: 'queued',
        to: 'running',
        label: 'execution started'
      },
      {
        from: 'queued',
        to: 'succeeded',
        label: 'execution succeeded'
      },
      {
        from: 'running',
        to: 'succeeded',
        label: 'execution succeeded'
      },
      {
        from: 'queued',
        to: 'failed',
        label: 'polling concluded failure'
      },
      {
        from: 'running',
        to: 'failed',
        label: 'polling concluded failure'
      }
    ]
  },
  {
    axis: 'publication',
    order: 3,
    title: 'Publication',
    field: 'publication.status',
    initial: 'pending',
    terminal: ['published', 'failed', 'skipped'],
    states: [
      'pending',
      'publishing',
      'uncertain',
      'disconnected',
      'published',
      'failed',
      'skipped'
    ],
    details: {
      pending: {
        label: 'Pending',
        description:
          'Waiting for a successful execution result before publishing.'
      },
      publishing: {
        label: 'Publishing',
        description:
          'A coordinator owns the publication claim and is performing the side effects.'
      },
      uncertain: {
        label: 'Uncertain',
        description:
          'A step may have completed its side effect remotely and is being reconciled. The axis reflects its strongest step; this is not a failure, and other steps keep publishing.'
      },
      disconnected: {
        label: 'Disconnected',
        description:
          'Automatic reconciliation of a step stopped without an answer, so an operator has to establish what is on the remote system. The axis reflects its strongest step.'
      },
      published: {
        label: 'Published',
        description: 'All publication steps succeeded; the result is visible.'
      },
      failed: {
        label: 'Failed',
        description:
          'The publication failed after its retry budget was exhausted.'
      },
      skipped: {
        label: 'Skipped',
        description:
          'There was nothing to publish because execution did not succeed.'
      }
    },
    transitions: [
      {
        from: 'pending',
        to: 'publishing',
        label: 'publishing started'
      },
      {
        from: 'publishing',
        to: 'uncertain',
        label: 'a step may have taken effect'
      },
      {
        from: 'uncertain',
        to: 'publishing',
        label: 'step settled'
      },
      {
        from: 'uncertain',
        to: 'disconnected',
        label: 'reconciliation could not conclude'
      },
      {
        from: 'disconnected',
        to: 'pending',
        reason: 'PUBLICATION_RESUMED_BY_OPERATOR',
        label: 'resumed by an operator'
      },
      {
        from: 'disconnected',
        to: 'failed',
        reason: 'PUBLICATION_ABANDONED_BY_OPERATOR',
        label: 'given up by an operator'
      },
      {
        from: 'publishing',
        to: 'published',
        label: 'published'
      },
      {
        from: 'publishing',
        to: 'publishing',
        reason: 'PUBLICATION_LEASE_EXPIRED',
        label: 'publishing lease expired'
      },
      {
        from: 'publishing',
        to: 'pending',
        label: 'retryable failure'
      },
      {
        from: 'publishing',
        to: 'failed',
        label: 'terminal failure'
      },
      {
        from: 'pending',
        to: 'skipped',
        label: 'execution not published'
      },
      {
        from: 'publishing',
        to: 'skipped',
        reason: 'PUBLICATION_ABANDONED',
        label: 'execution failed'
      }
    ]
  }
] as const

/** The machine for one axis, or undefined if the axis is unknown. */
export function stateMachine(axis: StateAxis): StateMachine | undefined {
  return STATE_MACHINES.find((machine) => machine.axis === axis)
}
