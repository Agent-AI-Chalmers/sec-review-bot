// Generated from contracts/control-plane-api/openapi.yaml (path relative to the repository root). Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with `pnpm --dir contracts/control-plane-api/tools run generate`.
//
// The hand-written openapi.yaml owns the domain shapes and the request shapes; these
// interfaces are its server-side projection, so the server's types follow the contract
// instead of a parallel schema.

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
    PreparationFailureNoticeWork: {
      run_id: string
      input: {
        [key: string]: unknown
      }
      failure_code: string | null
      claim_token: string
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
      workflow_result: unknown
      claim_token: string
    }
    PublicationStepRecord: {
      step_key: string
      /** @enum {string} */
      status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
      failure_count: number
      remote_object_id: string | null
      /** Format: uri */
      remote_object_url: string | null
      failure_code: string | null
      failure_message: string | null
    }
    ObservedPublicationStep: {
      step_key: string
      /** @enum {string} */
      status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
      failure_count: number
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
    }
    ExecutionSummary: {
      /**
       * @description The Runner lifecycle, retained under its established public name. `pending` means the run has been admitted but its prepared input has not yet been submitted to the Runner; preparation progress is reported separately by `preparation`. `skipped` means execution never ran because preparation failed; the reason is on `preparation`, not here. `uncertain` means a submission may have reached the Runner but its result could not be confirmed; a recovery replays it to resolve the run to `queued` or `failed`, so it is not a failure.
       * @enum {string}
       */
      status:
        | 'pending'
        | 'queued'
        | 'running'
        | 'uncertain'
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
       * @description Immutable instant the execution axis reached a terminal state (`succeeded`, `failed`, or `skipped`); null while it is pending, queued, running, or uncertain. Together with `started_at` it times the phase (only when `started_at` is non-null, since `skipped` has an end without a start).
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
      status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
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
      axis: 'runner' | 'preparation' | 'publication' | 'notice'
      /** @description State before the transition; null for the first event on an axis. */
      from_status: string | null
      to_status: string
      /** @description Machine-readable cause for a failure or reversion, when there is one. */
      reason_code: string | null
      /** Format: date-time */
      occurred_at: string
    }
    /** @description Durable preparation state for the run's preparation axis. This is an operational summary only; it never exposes connector-owned preparation input. It is not nullable: admission creates a run, its preparation, and its execution in one transaction and nothing deletes an axis on its own, so every readable run carries a summary. A row whose preparation is missing is corrupt — the Control Plane drops it from list reads and answers 404 for a single-run read, logging the fault — rather than reported with a null summary. */
    PreparationSummary: {
      /**
       * @description Preparation lifecycle. `preparing` means a preparer currently owns the claim; it is the preparation axis's own "in progress" state and is unrelated to the Runner, which is only submitted to once preparation reaches `submitted`.
       * @enum {string}
       */
      status: 'pending' | 'preparing' | 'submitted' | 'failed'
      attempt_count: number
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
      /** @enum {string|null} */
      failure_notice_status:
        'pending' | 'delivering' | 'delivered' | 'skipped' | null
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
  claimNextPreparationFailureNotice: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The claimed failure notice, or null when none is available. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json':
            components['schemas']['PreparationFailureNoticeWork'] | null
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  completePreparationFailureNotice: {
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
          delivered: boolean
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

export type ReviewRunRecord = components['schemas']['ReviewRunRecord']
export type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']
export type PublicationWork = components['schemas']['PublicationWork']
export type PublicationStepRecord =
  components['schemas']['PublicationStepRecord']
export type ObservedStep = components['schemas']['ObservedPublicationStep']
export type ObservedRun = components['schemas']['ObservedRun']
