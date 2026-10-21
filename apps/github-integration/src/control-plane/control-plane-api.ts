// Generated from contracts/control-plane-api/openapi.yaml (path relative to the repository root). Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with `pnpm --dir contracts/control-plane-api/tools run generate`.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Report process health. Requires no credential. */
    get: operations['getHealth']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/readyz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Report whether this instance can safely accept coordination requests. Requires no credential. */
    get: operations['getReadiness']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description List runs for the caller's connector, newest first, with cursor pagination. Returns the redacted observed shape; internal inputs and publish context are omitted. */
    get: operations['listRuns']
    put?: never
    /** @description Admit a review run, assigning its `run_id` before input preparation begins. Re-admitting the same `ingress_kind`/`ingress_key` returns the original run instead of creating another. */
    post: operations['admitRun']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Read one run in the redacted observed shape. Requires the read token. */
    get: operations['getRun']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication-steps': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Read the redacted publication-step summary for one run. Requires the read token. */
    get: operations['listRunPublicationSteps']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/events': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Read the append-only coordination event log for one run, oldest first. Each event is a state transition on one coordination axis (execution, preparation, publication, or notice). This is an audit trail over the snapshot tables, not the Runner's execution history, which lives in Temporal. Requires the read token. */
    get: operations['listRunEvents']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/submission': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Submit a prepared run to the Runner, persisting the input and commit claim before the Runner call so an uncertain submission stays recoverable. */
    post: operations['submitPreparedRun']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/preparation/claim': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Renew the caller's preparation claim while input preparation is still active. Returns whether the claim was renewed. */
    post: operations['renewPreparationClaim']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/preparation/claims/next': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Claim one connector-owned preparation whose durable input is available. Returns null when no preparation is pending. */
    post: operations['claimNextPreparation']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/preparation/checkpoint': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Replace the connector-owned durable preparation input while the caller still owns its preparation claim. Connectors use this to checkpoint data resolved during preparation so a later owner resumes the same work rather than resolving it again. */
    post: operations['checkpointPreparationInput']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/preparation/failure': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Record a preparation failure for a run the caller still owns. A retryable failure remains preparing and becomes claimable after the requested delay; the finite Control Plane retry budget turns exhaustion into a terminal failure. */
    post: operations['failPreparation']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/run-notices/claims/next': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Claim one connector-owned user-visible notice. Returns null when no undelivered notice is available; an expired notice claim is eligible again. */
    post: operations['claimNextRunNotice']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/run-notices/{noticeId}/complete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Complete a notice the caller still owns. `delivered` is true only when the requester can actually read the outcome; `comment_url` is the comment that carries it and is required in that case, so a delivered notice always points at something. A delivery that failed records `delivered: false`. A notice has no user-visible target when the connector cannot resolve one (its input names neither a conversation nor a repository), which the caller reports the same way, because a notice nobody can read is not delivered. */
    post: operations['completeRunNotice']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/publication/claims/next': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Claim the next publishable run, optionally holding the request until one appears. Returns `null` when the wait elapses with no work. */
    post: operations['claimNextPublication']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/claim': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Renew the caller's publication claim. Returns whether the claim was renewed. */
    post: operations['renewPublicationClaim']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/steps': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Initialize the run's publication step set. The set is fixed once written, so a duplicate or changed set is rejected as a deterministic failure. */
    post: operations['initializePublicationSteps']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/steps/{stepKey}/claim': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Assert the caller still owns the run's publication claim before acting on one step. */
    post: operations['requirePublicationStepClaim']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/steps/{stepKey}/complete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Record one publication step as succeeded, attaching the remote object it produced. */
    post: operations['completePublicationStep']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/steps/{stepKey}/settle-exhausted': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Conclude a publication step that has no attempts left, from what the connector found on the remote system. Exhaustion alone never concludes a step: an attempt that started may have taken effect remotely before its owner died or its response was lost, and Control Plane cannot see that system. The connector therefore reports either the effect it found (the step becomes succeeded, using the same remote reference a live completion would have written) or that it looked and found nothing (only then does the step become terminal_failed). The caller must still own the publication claim. */
    post: operations['settleExhaustedPublicationStep']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/steps/{stepKey}/fail': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Record one publication step as failed, optionally spending retry budget. */
    post: operations['failPublicationStep']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/complete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Mark the run's publication as complete. */
    post: operations['completePublication']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/publication/fail': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Record the run's publication outcome as failed, choosing whether the failure is retryable. */
    post: operations['failPublication']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/internal/runs/{runId}': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Read the full run record, including `runner_input` and `publish_context`. Requires the service token; never exposed to the console. */
    get: operations['getInternalRun']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/internal/runs/{runId}/publication/steps': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Read the full publication-step records for one run, including reconciliation ids. Requires the service token. */
    get: operations['listInternalPublicationSteps']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/parked': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description List the runs whose automatic work stopped without a conclusion, on any axis. Coordination stops retrying these, so this is the queue of runs that need an operator decision, and `axis` says which part of the run stopped. Reading it needs only the read token: knowing that a run is stuck is not a privileged act, and the console should be able to show it without holding operator credentials. */
    get: operations['listParkedRuns']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/admin/runs/{runId}/abandon': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description An operator decision, not a repair: conclude a blocked run's open axes so it stops holding unwinnable work. Execution is left untouched (a recorded result and its `workflow_result` stay), nothing is deleted, and the run keeps its ingress identity so a replay still resolves to it. Only a run whose preparation is parked by a contradiction is eligible - the case this decision exists for; a run parked on execution or publication is ended with `giveUp` instead. That single-eligibility restriction is what keeps this from becoming a general state-jumping endpoint: the route can only finish a transition coordination already proved impossible, and a leaked admin token can at most conclude such a run. Requires the admin token; the route does not exist when none is configured. */
    post: operations['abandonBlockedPreparation']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/admin/runs/{runId}/give-up': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description An operator decision that stops waiting for a disconnected run instead of resuming it. It never claims that nothing happened: a disconnected execution may already have been accepted by the Runner, and a disconnected publication may already have delivered some of its steps. The decision is therefore recorded as "this outcome will not be waited for": the disconnected axis ends as failed with a reason naming the operator, and whatever the run would still have produced is not published. A disconnected preparation concludes as a failure, an execution in flight is stopped, and a publication is skipped. Only a run with a disconnected axis is eligible, and a reason is required so the decision is never anonymous. Requires the admin token; the route does not exist when none is configured. */
    post: operations['giveUpDisconnectedRun']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/admin/runs/{runId}/resume': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description An operator decision that hands a disconnected run back to automatic recovery. Exactly one axis can be `disconnected` at a time, and this resumes whichever it is. A disconnected preparation returns to `uncertain` and its attempt budget is reset, because such a row has always spent that budget and would otherwise be concluded as failed by the next command without ever being attempted again. A disconnected execution returns to `uncertain` with its replay budget reset, for the same reason: the replays stopped precisely because that budget was spent. A disconnected publication returns to the normal claim queue: its parked steps become attemptable with both budgets reset, so the side effects they name are issued once more. Steps that already succeeded are not reset - the run resumes where it stopped instead of starting over. Nothing is repaired and no outcome is asserted either way. The decision is the operator's, and it is not capped: every resume is recorded as its own `PUBLICATION_RESUMED_BY_OPERATOR` transition, so the exercise of that authority is visible after the fact rather than limited in advance. Only a run with a disconnected axis is eligible, so a leaked admin token can at most restart work the system already stopped by itself. Requires the admin token; the route does not exist when none is configured. */
    post: operations['resumeDisconnectedRun']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/config/preparation-heartbeat-interval': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Report how often a preparation owner must renew its claim. */
    get: operations['getPreparationHeartbeatInterval']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/config/publication-heartbeat-interval': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Report how often a publication owner must renew its claim. */
    get: operations['getPublicationHeartbeatInterval']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
}
export type webhooks = Record<string, never>
export interface components {
  schemas: {
    ErrorResponse: {
      error: string
      /**
       * @description The machine-readable reason. `INVALID_QUERY`, `INVALID_BODY`, and
       *     `INVALID_PATH_PARAMETER` identify which part of the request failed schema
       *     validation; the `PUBLICATION_STEP_*` codes are terminal publication failures.
       * @enum {string}
       */
      code?:
        | 'INVALID_QUERY'
        | 'INVALID_BODY'
        | 'INVALID_PATH_PARAMETER'
        | 'PUBLICATION_STEP_SET_DUPLICATE'
        | 'PUBLICATION_STEP_SET_CHANGED'
        | 'PUBLICATION_STEP_RETRY_EXHAUSTED'
        | 'PUBLICATION_STEP_NOT_CLAIMABLE'
    }
    ReviewRunRecord: {
      run_id: string
      /** @enum {string} */
      workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
      publish_context: {
        [key: string]: unknown
      }
      runner_input?: {
        [key: string]: unknown
      }
      preparation: components['schemas']['PreparationSummary']
      /** @enum {string} */
      ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
      ingress_key?: string
      execution: components['schemas']['ExecutionSummary']
      publication: components['schemas']['PublicationSummary']
      /** Format: date-time */
      created_at: string
      failure_code: string | null
      failure_message: string | null
      artifact_storage: components['schemas']['ArtifactStorage']
      /** @description User-visible notices caused by this run's coordination events, in creation order. */
      notices: components['schemas']['RunNoticeSummary'][]
    }
    ReviewRunAdmission: {
      record: components['schemas']['ReviewRunRecord']
      created: boolean
      preparation_token: string | null
    }
    PreparationWork: {
      run_id: string
      /** @enum {string} */
      workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
      input_version: string
      input: {
        [key: string]: unknown
      }
      claim_token: string
      attempt_count: number
    }
    /** @description One pending user-visible notice, claimed by the component that can deliver it. */
    RunNoticeWork: {
      notice_id: string
      run_id: string
      input: {
        [key: string]: unknown
      }
      /** @enum {string} */
      kind: 'failure' | 'attention'
      /** @enum {string} */
      axis: 'preparation' | 'execution' | 'publication'
      reason_code: string | null
      claim_token: string
    }
    /** @description Delivery state of one user-visible coordination notice. */
    RunNoticeSummary: {
      notice_id: string
      /** @enum {string} */
      kind: 'failure' | 'attention'
      /** @enum {string} */
      axis: 'preparation' | 'execution' | 'publication'
      /** @enum {string} */
      status: 'pending' | 'delivering' | 'delivered' | 'failed'
      reason_code: string | null
      /** @description Where the requester can read the outcome. Always an absolute URI when present, and null only when no message reached them. */
      comment_url: null | string
    }
    PublicationWork: {
      run_id: string
      /** @enum {string} */
      workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
      publish_context: {
        [key: string]: unknown
      }
      runner_input?: {
        [key: string]: unknown
      }
      preparation: components['schemas']['PreparationSummary']
      /** @enum {string} */
      ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
      ingress_key?: string
      execution: components['schemas']['ExecutionSummary']
      publication: components['schemas']['PublicationSummary']
      /** Format: date-time */
      created_at: string
      failure_code: string | null
      failure_message: string | null
      artifact_storage: components['schemas']['ArtifactStorage']
      /** @description User-visible notices caused by this run's coordination events, in creation order. */
      notices: components['schemas']['RunNoticeSummary'][]
      workflow_result: unknown
      claim_token: string
    }
    PublicationStepRecord: {
      step_key: string
      /** @enum {string} */
      status:
        | 'pending'
        | 'running'
        | 'uncertain'
        | 'disconnected'
        | 'succeeded'
        | 'failed'
        | 'terminal_failed'
      /** @description How many times this step has been claimed and started. More than one means an earlier owner began the side effect, so a reclaiming publisher must reconcile against the remote object (`remote_object_id`/`remote_object_url`) instead of assuming nothing happened. */
      attempt_count: number
      /**
       * Format: date-time
       * @description When the latest claim of this step started; null until the step is claimed once. Together with `attempt_count` it distinguishes a step that never started from one whose publisher died mid-effect.
       */
      last_attempt_at: string | null
      remote_object_id: string | null
      /** Format: uri */
      remote_object_url: string | null
      failure_code: string | null
      failure_message: string | null
    }
    ObservedPublicationStep: {
      step_key: string
      /** @enum {string} */
      status:
        | 'pending'
        | 'running'
        | 'uncertain'
        | 'disconnected'
        | 'succeeded'
        | 'failed'
        | 'terminal_failed'
      /** @description How many attempts this step has started against its budget. A count above one on a successful step means the side effect was reached after a retry or a recovery, not on the first try. */
      attempt_count: number
      /** Format: uri */
      remote_object_url: string | null
      failure_code: string | null
      failure_message: string | null
    }
    ObservedRun: {
      run_id: string
      /** @enum {string} */
      workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
      preparation: components['schemas']['PreparationSummary']
      execution: components['schemas']['ExecutionSummary']
      publication: components['schemas']['PublicationSummary']
      /** Format: date-time */
      created_at: string
      failure_code: string | null
      artifact_storage: components['schemas']['ArtifactStorage']
      /** @description User-visible notices caused by this run's coordination events, in creation order. */
      notices: components['schemas']['RunNoticeSummary'][]
    }
    ExecutionSummary: {
      /**
       * @description The Runner lifecycle, retained under its established public name. `pending` means the run has been admitted but its prepared input has not yet been submitted to the Runner; preparation progress is reported separately by `preparation`. `skipped` means execution never ran because preparation failed; the reason is on `preparation`, not here. `uncertain` means a submission may have reached the Runner but its result could not be confirmed; a recovery replays it under the same identity. `disconnected` means automatic recovery stopped after its finite budget without a conclusive answer, so it is not a failure.
       * @enum {string}
       */
      status:
        | 'pending'
        | 'queued'
        | 'running'
        | 'uncertain'
        | 'disconnected'
        | 'succeeded'
        | 'skipped'
        | 'failed'
      /**
       * Format: date-time
       * @description Immutable instant the prepared Runner input was accepted and execution began; null while the run is still pending, and also null for `skipped`, which is concluded without ever having started. Written once, so a recovery replay does not move it.
       */
      started_at: string | null
      /**
       * Format: date-time
       * @description Immutable instant the execution axis reached a terminal state (`succeeded`, `failed`, or `skipped`); null while it is pending, queued, running, uncertain, or disconnected. Together with `started_at` it times the phase (only when `started_at` is non-null, since `skipped` has an end without a start).
       */
      finished_at: string | null
      /**
       * Format: date-time
       * @description Last time the execution axis was written: a polling confirmation, a state transition, or a submission/recovery write. This is the observation freshness the console reports ("observed Ns ago"), not a phase bound — use `started_at` and `finished_at` for that.
       */
      updated_at: string
    }
    PublicationSummary: {
      /** @enum {string} */
      status:
        | 'pending'
        | 'publishing'
        | 'uncertain'
        | 'disconnected'
        | 'published'
        | 'failed'
        | 'skipped'
      /**
       * Format: date-time
       * @description Immutable instant the publication phase began (the work was first claimed); null while it is pending, and null for `skipped`, which is concluded without ever having started. A retryable failure that returns the row to pending and claims it again does not move it.
       */
      started_at: string | null
      /**
       * Format: date-time
       * @description Immutable instant the publication axis reached a terminal state (`published`, `failed`, or `skipped`); null while it is pending or publishing. It is set for every terminal outcome. The instant the result became visible is this field read together with `status: published`.
       */
      finished_at: string | null
      /**
       * Format: date-time
       * @description Last time the publication axis was written, including claim heartbeats. This is the activity freshness the console reports, not a phase bound — use `started_at` and `finished_at` for that. Unlike them it keeps advancing while a long publication runs.
       */
      updated_at: string
    }
    ReviewRunEvent: {
      /** @description Monotonic identifier; also the tie-breaker within one occurred_at. */
      event_id: number
      /** @enum {string} */
      axis: 'execution' | 'preparation' | 'publication'
      /** @description State before the transition; null for the first event on an axis. */
      from_status: string | null
      to_status: string
      /** @description Machine-readable cause for a failure or reversion, when there is one. */
      reason_code: string | null
      /** Format: date-time */
      occurred_at: string
    }
    /** @description One run the system stopped working on by itself, and the axis it is parked on. A queue that listed only preparation left an operator unable to find a run whose execution or publication stalled. */
    ParkedRun: {
      run_id: string
      /** @enum {string} */
      axis: 'preparation' | 'execution' | 'publication'
      /**
       * @description Why automation stopped. A publication parks when a step's reconciliation budget is spent; the steps themselves record which one and what its last failure was.
       * @enum {string}
       */
      reason:
        | 'EXECUTION_ALREADY_ADVANCED'
        | 'SUBMISSION_RECOVERY_EXHAUSTED'
        | 'PUBLICATION_RECONCILIATION_EXHAUSTED'
    }
    /** @description Durable preparation state for the run's preparation axis. This is an operational summary only; it never exposes connector-owned preparation input. It is not nullable: admission creates a run, its preparation, and its execution in one transaction and nothing deletes an axis on its own, so every readable run carries a summary. A row whose preparation is missing is corrupt — the Control Plane drops it from list reads and answers 404 for a single-run read, logging the fault — rather than reported with a null summary. */
    PreparationSummary: {
      /**
       * @description Preparation lifecycle. `preparing` means a preparer currently owns the claim; it is the preparation axis's own "in progress" state and is unrelated to the Runner, which is only submitted to once preparation reaches `submitted`.
       * @enum {string}
       */
      status:
        | 'pending'
        | 'preparing'
        | 'uncertain'
        | 'disconnected'
        | 'submitted'
        | 'failed'
      attempt_count: number
      /** @description Non-null only while `status` is `disconnected`: the reason the run's own records do not admit the transition an expired lease would make, so automatic work cannot conclude it. It names that conflict and nothing else - what an operator may do about it is the `disconnected` state's business, not this field's. The value today is `EXECUTION_ALREADY_ADVANCED`. */
      disconnect_reason: string | null
      /**
       * Format: date-time
       * @description Immutable instant the preparation phase began (a preparer first claimed the work); null while it is still pending. A retry that returns the row to pending and claims it again does not move it, so it is a safe start bound for the phase.
       */
      started_at: string | null
      /**
       * Format: date-time
       * @description Immutable instant the preparation phase reached a terminal state (`submitted` or `failed`); null while it is pending or preparing. Distinct from `updated_at`, which also moves on claim heartbeats and input checkpoints and cannot mark the phase end.
       */
      finished_at: string | null
      /**
       * Format: date-time
       * @description Last time the preparation axis was written, including claim heartbeats and input checkpoints. This is the activity freshness the console reports, not a phase bound — use `started_at` and `finished_at` for that. A preparation that is still being built keeps advancing here even though its bounds do not.
       */
      updated_at: string
      failure_code: string | null
    }
    ArtifactStorage:
      | {
          /** @enum {string} */
          status: 'unavailable' | 'failed'
          error_code?: string
          message?: string
        }
      | {
          /** @enum {string} */
          status: 'available'
          artifact: {
            /** @enum {string} */
            kind: 'diagnostic_bundle'
            uri: string
            /** @enum {string} */
            media_type: 'application/tar+zstd'
            digest: string
            size_bytes: number
          }
        }
      | null
  }
  responses: {
    /** @description The request failed the contract's own schema. `code` names which part — `INVALID_QUERY`, `INVALID_BODY`, or `INVALID_PATH_PARAMETER`. */
    InvalidRequest: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description Missing or invalid bearer credential for the operation's security scheme. */
    Unauthorized: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description The referenced run was not found. */
    RunNotFound: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description The run is not in a state this operation may act on, such as abandoning a run that is not blocked. */
    Conflict: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description A deterministic publication failure; `code` carries the terminal reason (`PUBLICATION_STEP_*`). */
    DeterministicPublicationFailure: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description The request body exceeded the service's limit (1 MiB). Only operations that read a body can return this; the body is rejected before the contract's own schema sees it. */
    PayloadTooLarge: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description An internal fault. The response is deliberately opaque (it never carries the fault's message or `code`); the identity is logged server-side. Every operation can return it. */
    InternalError: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
  }
  parameters: never
  requestBodies: never
  headers: never
  pathItems: never
}
export type $defs = Record<string, never>
export interface operations {
  getHealth: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Process health. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            status: string
          }
        }
      }
      500: components['responses']['InternalError']
    }
  }
  getReadiness: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description PostgreSQL is reachable through the pool and the startup schema is present. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @enum {string} */
            status: 'ok'
          }
        }
      }
      500: components['responses']['InternalError']
      /** @description PostgreSQL, the connection pool, or the applied startup schema is unavailable. */
      503: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @enum {string} */
            status: 'unavailable'
          }
        }
      }
    }
  }
  listRuns: {
    parameters: {
      query?: {
        /** @description The list filters. Each declared property is a query parameter of the same name; any other query parameter is rejected. */
        filter?: {
          limit?: number
          cursor?: string
          /** @enum {string} */
          execution_status?:
            | 'pending'
            | 'queued'
            | 'running'
            | 'uncertain'
            | 'succeeded'
            | 'skipped'
            | 'failed'
          /** @enum {string} */
          publication_status?:
            'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
          /**
           * @description Matches the run's redacted preparation summary by state. Every readable run carries that summary, so the filter never has to decide what a missing one means: a stored run that lacks its preparation row is corrupt, is dropped from list reads, and therefore cannot appear under any value of this filter.
           * @enum {string}
           */
          preparation_status?: 'pending' | 'preparing' | 'submitted' | 'failed'
          /** @enum {string} */
          workflow?:
            'issue-review' | 'pull-request-review' | 'repository-review'
          /** Format: date-time */
          from?: string
          /** Format: date-time */
          to?: string
        }
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Paginated redacted runs. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            runs: components['schemas']['ObservedRun'][]
            next_cursor: string | null
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  admitRun: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @enum {string} */
          workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
          publish_context: {
            [key: string]: unknown
          }
          runner_input?: {
            [key: string]: unknown
          }
          preparation_input_version: string
          preparation_input: {
            [key: string]: unknown
          }
          /** @enum {string} */
          ingress_kind: 'github_webhook' | 'github_actions_dispatch'
          ingress_key: string
        }
      }
    }
    responses: {
      /** @description The admitted (or re-admitted) run. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ReviewRunAdmission']
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getRun: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Redacted run detail. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            run: components['schemas']['ObservedRun']
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      500: components['responses']['InternalError']
    }
  }
  listRunPublicationSteps: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Redacted publication-step summary. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            run_id: string
            publication_steps: components['schemas']['ObservedPublicationStep'][]
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      500: components['responses']['InternalError']
    }
  }
  listRunEvents: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The run's coordination events, oldest first. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            run_id: string
            events: components['schemas']['ReviewRunEvent'][]
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      500: components['responses']['InternalError']
    }
  }
  submitPreparedRun: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          preparation_token: string
          publish_context: {
            [key: string]: unknown
          }
          input: {
            [key: string]: unknown
          }
        }
      }
    }
    responses: {
      /** @description Queued acknowledgement. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            run_id: string
            /** @enum {string} */
            workflow:
              'issue-review' | 'pull-request-review' | 'repository-review'
            /** @enum {string} */
            status: 'queued'
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  renewPreparationClaim: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
        }
      }
    }
    responses: {
      /** @description Whether the claim was renewed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  claimNextPreparation: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The claimed preparation, or null when none is available. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['PreparationWork'] | null
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  checkpointPreparationInput: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          input: {
            [key: string]: unknown
          }
        }
      }
    }
    responses: {
      /** @description The checkpoint was persisted. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content?: never
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  failPreparation: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          failure: {
            code?: string | null
            message: string
          }
          /** @default false */
          retry?: boolean
          /** @description Delay before the durable preparation is claimable again. */
          retry_after_ms?: number
        }
      }
    }
    responses: {
      /** @description The preparation failure outcome. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            /** @description False when the failure is terminal or exhausted its retry budget. */
            retry_scheduled: boolean
          }
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  claimNextRunNotice: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The claimed notice, or null when none is available. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunNoticeWork'] | null
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  completeRunNotice: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The claimed notice identifier. */
        noticeId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json':
          | {
              token: string
              /** @enum {boolean} */
              delivered: true
              /**
               * Format: uri
               * @description The comment the requester can read.
               */
              comment_url: string
            }
          | {
              token: string
              /** @enum {boolean} */
              delivered: false
            }
      }
    }
    responses: {
      /** @description Whether the caller still owned the notice. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  claimNextPublication: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          wait_ms?: number
        }
      }
    }
    responses: {
      /** @description The claimed publication work, or null if none. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['PublicationWork'] | null
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  renewPublicationClaim: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
        }
      }
    }
    responses: {
      /** @description Whether the claim was renewed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  initializePublicationSteps: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          step_keys: string[]
        }
      }
    }
    responses: {
      /** @description Initialization acknowledgement (empty). */
      200: {
        headers: {
          [name: string]: unknown
        }
        content?: never
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      409: components['responses']['DeterministicPublicationFailure']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  requirePublicationStepClaim: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
        /** @description The publication step key, as supplied at initializePublicationSteps. */
        stepKey: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
        }
      }
    }
    responses: {
      /** @description Claim acknowledgement (empty). */
      200: {
        headers: {
          [name: string]: unknown
        }
        content?: never
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      409: components['responses']['DeterministicPublicationFailure']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  completePublicationStep: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
        /** @description The publication step key, as supplied at initializePublicationSteps. */
        stepKey: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          remote_object?: {
            /** @description The created object's numeric id in its canonical string form. It is persisted as text and read back with `Number(...)`; a `null` id means the step produced no remote object. */
            id?: string | null
            url?: string | null
          }
        }
      }
    }
    responses: {
      /** @description Whether the step completed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  settleExhaustedPublicationStep: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
        /** @description The publication step key, as supplied at initializePublicationSteps. */
        stepKey: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          /** @description Whether the connector found the side effect already present on the remote system. `false` means the connector looked and confirmed it is absent. */
          found: boolean
          /** @description The remote object the connector matched when `found` is true; ignored otherwise. */
          remote_object?: {
            id?: string | null
            url?: string | null
          }
        }
      }
    }
    responses: {
      /** @description Whether this call concluded the step. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  failPublicationStep: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
        /** @description The publication step key, as supplied at initializePublicationSteps. */
        stepKey: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          failure: {
            code?: string | null
            message: string
          }
          retry?: boolean
        }
      }
    }
    responses: {
      /** @description Whether the step failed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  completePublication: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
        }
      }
    }
    responses: {
      /** @description Whether publication completed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  failPublication: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          token: string
          failure: {
            code?: string | null
            message: string
          }
          retry: boolean
        }
      }
    }
    responses: {
      /** @description Whether publication failed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': boolean
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getInternalRun: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Full run record (includes runner_input/publish_context). */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ReviewRunRecord']
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      500: components['responses']['InternalError']
    }
  }
  listInternalPublicationSteps: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Full publication-step records. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['PublicationStepRecord'][]
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      500: components['responses']['InternalError']
    }
  }
  listParkedRuns: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Parked runs, oldest first. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': {
            blocks: components['schemas']['ParkedRun'][]
          }
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  abandonBlockedPreparation: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description Why this run is being abandoned; recorded on every event it writes. */
          reason: string
        }
      }
    }
    responses: {
      /** @description The run after its open axes were concluded. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ReviewRunRecord']
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  giveUpDisconnectedRun: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': {
          /** @description Why this outcome is being given up on; recorded on every event it writes. */
          reason: string
        }
      }
    }
    responses: {
      /** @description The run after the decision concluded its disconnected axis. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ReviewRunRecord']
        }
      }
      400: components['responses']['InvalidRequest']
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  resumeDisconnectedRun: {
    parameters: {
      query?: never
      header?: never
      path: {
        /** @description The run identifier Control Plane assigned at admission (a UUID). */
        runId: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The run after its disconnected axis was handed back to automatic recovery. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ReviewRunRecord']
        }
      }
      401: components['responses']['Unauthorized']
      404: components['responses']['RunNotFound']
      409: components['responses']['Conflict']
      500: components['responses']['InternalError']
    }
  }
  getPreparationHeartbeatInterval: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Preparation heartbeat interval in milliseconds. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': number
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  getPublicationHeartbeatInterval: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Publication heartbeat interval in milliseconds. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': number
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
}

/** Each operation's contract path and HTTP method, keyed by `operationId` and taken from
 * the document itself. The client builds every request from this map, so an operation cannot
 * be sent to another operation's URL or with another operation's method: the call site names
 * the operation, and the URL is looked up, never passed in. */
export const operationRoutes = {
  getHealth: { path: '/healthz', method: 'get' },
  getReadiness: { path: '/readyz', method: 'get' },
  listRuns: { path: '/v1/runs', method: 'get' },
  admitRun: { path: '/v1/runs', method: 'post' },
  getRun: { path: '/v1/runs/{runId}', method: 'get' },
  listRunPublicationSteps: {
    path: '/v1/runs/{runId}/publication-steps',
    method: 'get'
  },
  listRunEvents: { path: '/v1/runs/{runId}/events', method: 'get' },
  submitPreparedRun: { path: '/v1/runs/{runId}/submission', method: 'post' },
  renewPreparationClaim: {
    path: '/v1/runs/{runId}/preparation/claim',
    method: 'post'
  },
  claimNextPreparation: { path: '/v1/preparation/claims/next', method: 'post' },
  checkpointPreparationInput: {
    path: '/v1/runs/{runId}/preparation/checkpoint',
    method: 'post'
  },
  failPreparation: {
    path: '/v1/runs/{runId}/preparation/failure',
    method: 'post'
  },
  claimNextRunNotice: { path: '/v1/run-notices/claims/next', method: 'post' },
  completeRunNotice: {
    path: '/v1/run-notices/{noticeId}/complete',
    method: 'post'
  },
  claimNextPublication: { path: '/v1/publication/claims/next', method: 'post' },
  renewPublicationClaim: {
    path: '/v1/runs/{runId}/publication/claim',
    method: 'post'
  },
  initializePublicationSteps: {
    path: '/v1/runs/{runId}/publication/steps',
    method: 'post'
  },
  requirePublicationStepClaim: {
    path: '/v1/runs/{runId}/publication/steps/{stepKey}/claim',
    method: 'post'
  },
  completePublicationStep: {
    path: '/v1/runs/{runId}/publication/steps/{stepKey}/complete',
    method: 'post'
  },
  settleExhaustedPublicationStep: {
    path: '/v1/runs/{runId}/publication/steps/{stepKey}/settle-exhausted',
    method: 'post'
  },
  failPublicationStep: {
    path: '/v1/runs/{runId}/publication/steps/{stepKey}/fail',
    method: 'post'
  },
  completePublication: {
    path: '/v1/runs/{runId}/publication/complete',
    method: 'post'
  },
  failPublication: {
    path: '/v1/runs/{runId}/publication/fail',
    method: 'post'
  },
  getInternalRun: { path: '/v1/internal/runs/{runId}', method: 'get' },
  listInternalPublicationSteps: {
    path: '/v1/internal/runs/{runId}/publication/steps',
    method: 'get'
  },
  listParkedRuns: { path: '/v1/runs/parked', method: 'get' },
  abandonBlockedPreparation: {
    path: '/v1/admin/runs/{runId}/abandon',
    method: 'post'
  },
  giveUpDisconnectedRun: {
    path: '/v1/admin/runs/{runId}/give-up',
    method: 'post'
  },
  resumeDisconnectedRun: {
    path: '/v1/admin/runs/{runId}/resume',
    method: 'post'
  },
  getPreparationHeartbeatInterval: {
    path: '/v1/config/preparation-heartbeat-interval',
    method: 'get'
  },
  getPublicationHeartbeatInterval: {
    path: '/v1/config/publication-heartbeat-interval',
    method: 'get'
  }
} as const
