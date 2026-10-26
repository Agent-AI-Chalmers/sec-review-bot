// Generated from contracts/control-plane-api/v1/openapi.yaml (path relative to the repository root). Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with `pnpm --dir contracts/control-plane-api/tools run generate`.
//
// The shapes the console reads. The console has no access to the server's source, so it imports
// these aliases rather than restating the contract: a hand-written copy would drift silently,
// and a flattened copy of a discriminated union (ArtifactStorage) cannot express which fields a
// given status requires.

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
      execution_input?: {
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
      execution_input?: {
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
       * @description The execution lifecycle as coordinated through Execution API provider. `pending` means the run has been admitted but its prepared input has not yet been submitted to the Execution API provider; preparation progress is reported separately by `preparation`. `skipped` means execution never ran because preparation failed; the reason is on `preparation`, not here. `uncertain` means a submission may have reached the Execution API provider but its result could not be confirmed; a recovery replays it under the same identity. `disconnected` means automatic recovery stopped after its finite budget without a conclusive answer, so it is not a failure.
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
       * @description Immutable instant the prepared Execution input was accepted and execution began; null while the run is still pending, and also null for `skipped`, which is concluded without ever having started. Written once, so a recovery replay does not move it.
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
       * @description Preparation lifecycle. `preparing` means a preparer currently owns the claim; it is the preparation axis's own "in progress" state and is unrelated to the Execution API provider, which is only submitted to once preparation reaches `submitted`.
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

export type ArtifactStorage = components['schemas']['ArtifactStorage']
export type Run = components['schemas']['ObservedRun']
export type RunEvent = components['schemas']['ReviewRunEvent']
export type PublicationStep = components['schemas']['ObservedPublicationStep']
export type ParkedRun = components['schemas']['ParkedRun']
