// Generated from contracts/control-plane-api/openapi.yaml (path relative to the repository
// root). Do not edit. The contract's `x-state-machines` block is the single source of truth;
// this file is its TypeScript view. Regenerate it with
// `pnpm --dir contracts/control-plane-api/tools run generate`.

export type StateAxis = 'preparation' | 'execution' | 'publication' | 'notice'

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
    states: ['pending', 'preparing', 'submitted', 'failed'],
    details: {
      pending: {
        label: 'Pending',
        description: 'Admitted, but no preparer has claimed the work yet.'
      },
      preparing: {
        label: 'Preparing',
        description:
          'A coordinator currently owns the claim and is building the Runner input.'
      },
      submitted: {
        label: 'Submitted',
        description:
          'The input was accepted and handed to the Runner; preparation is done.'
      },
      failed: {
        label: 'Failed',
        description:
          'Preparation failed permanently (retry budget exhausted or input could not be built). The Runner was never handed input, so execution is skipped.'
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
      'failed'
    ],
    details: {
      pending: {
        label: 'Pending',
        description:
          'Admitted, but its prepared input has not been submitted to the Runner yet.'
      },
      queued: {
        label: 'Queued',
        description:
          'The Runner accepted the submission; polling has not yet seen it start.'
      },
      running: {
        label: 'Running',
        description:
          'Polling observed that the Runner is executing this run. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be slightly out of date.'
      },
      succeeded: {
        label: 'Succeeded',
        description:
          'The Runner returned a result; it now becomes eligible for publication.'
      },
      skipped: {
        label: 'Skipped',
        description:
          'Execution never ran because preparation failed. This is not an execution failure; the reason is on the preparation axis.'
      },
      uncertain: {
        label: 'Unconfirmed',
        description:
          'The task was submitted, but no response arrived, so it is unknown whether the Runner accepted it. This is not a failure: the submission is replayed under the same run_id, and the run becomes queued if accepted or failed if it keeps failing.'
      },
      failed: {
        label: 'Failed',
        description:
          'A definite failure, in one of two ways: (1) polling produced a conclusive answer that the task cannot succeed — the Runner reported it failed, or the run could not be found, returned no result, or the response broke the protocol; (2) a retried submission failed conclusively. A transient network error (a timeout, a 5xx, a dropped connection) is not a definite failure.'
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
        from: 'queued',
        to: 'running',
        label: 'runner started'
      },
      {
        from: 'queued',
        to: 'succeeded',
        label: 'runner succeeded'
      },
      {
        from: 'running',
        to: 'succeeded',
        label: 'runner succeeded'
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
    states: ['pending', 'publishing', 'published', 'failed', 'skipped'],
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
  },
  {
    axis: 'notice',
    order: 4,
    title: 'Failure notice',
    field: 'failure_notice.status',
    initial: 'pending',
    terminal: ['delivered', 'failed'],
    states: ['pending', 'delivering', 'delivered', 'failed'],
    details: {
      pending: {
        label: 'Pending',
        description:
          'A run ended on some axis and the requester still has to be told.'
      },
      delivering: {
        label: 'Delivering',
        description: 'The failure notice is being delivered to the requester.'
      },
      delivered: {
        label: 'Delivered',
        description: 'The requester was told the run failed.'
      },
      failed: {
        label: 'Delivery failed',
        description:
          'Delivery was attempted and did not succeed, most often because the provider could not be reached. The notice is retained as the record that the requester was never told.'
      }
    },
    transitions: [
      {
        from: 'pending',
        to: 'delivering',
        label: 'notice claimed'
      },
      {
        from: 'delivering',
        to: 'delivering',
        reason: 'NOTICE_LEASE_EXPIRED',
        label: 'delivery lease expired'
      },
      {
        from: 'delivering',
        to: 'delivered',
        label: 'notice delivered'
      },
      {
        from: 'delivering',
        to: 'failed',
        label: 'delivery failed'
      }
    ]
  }
] as const

/** The machine for one axis, or undefined if the axis is unknown. */
export function stateMachine(axis: StateAxis): StateMachine | undefined {
  return STATE_MACHINES.find((machine) => machine.axis === axis)
}
