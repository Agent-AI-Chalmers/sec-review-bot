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
  '/v1/preparation/failure-notices/claims/next': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Claim one connector-owned terminal preparation-failure notice. Returns null when no undelivered notice is available; an expired notice claim is eligible again. */
    post: operations['claimNextPreparationFailureNotice']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{runId}/preparation/failure-notice/complete': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Complete a terminal preparation-failure notice the caller still owns. `delivered` is false when the connector intentionally has no user-visible target. */
    post: operations['completePreparationFailureNotice']
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
      /** @enum {string} */
      ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
      ingress_key?: string
      /** @enum {string} */
      runner_status:
        | 'preparing'
        | 'recovering'
        | 'queued'
        | 'running'
        | 'succeeded'
        | 'failed'
      /** @enum {string} */
      publication_status:
        'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
      /** Format: date-time */
      created_at: string
      /** Format: date-time */
      execution_updated_at: string
      /** Format: date-time */
      publication_updated_at: string
      /** Format: date-time */
      published_at: string | null
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
      /** @enum {string} */
      ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
      ingress_key?: string
      /** @enum {string} */
      runner_status:
        | 'preparing'
        | 'recovering'
        | 'queued'
        | 'running'
        | 'succeeded'
        | 'failed'
      /** @enum {string} */
      publication_status:
        'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
      /** Format: date-time */
      created_at: string
      /** Format: date-time */
      execution_updated_at: string
      /** Format: date-time */
      publication_updated_at: string
      /** Format: date-time */
      published_at: string | null
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
      /** @enum {string} */
      execution_status:
        | 'preparing'
        | 'recovering'
        | 'queued'
        | 'running'
        | 'succeeded'
        | 'failed'
      /** @enum {string} */
      publication_status:
        'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
      /** Format: date-time */
      created_at: string
      /** Format: date-time */
      execution_updated_at: string
      /** Format: date-time */
      publication_updated_at: string
      /** Format: date-time */
      published_at: string | null
      failure_code: string | null
      artifact_storage: components['schemas']['ArtifactStorage']
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
            | 'preparing'
            | 'recovering'
            | 'queued'
            | 'running'
            | 'succeeded'
            | 'failed'
          /** @enum {string} */
          publication_status?:
            'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
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
  claimNextPreparationFailureNotice: {
    path: '/v1/preparation/failure-notices/claims/next',
    method: 'post'
  },
  completePreparationFailureNotice: {
    path: '/v1/runs/{runId}/preparation/failure-notice/complete',
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
  getPreparationHeartbeatInterval: {
    path: '/v1/config/preparation-heartbeat-interval',
    method: 'get'
  },
  getPublicationHeartbeatInterval: {
    path: '/v1/config/publication-heartbeat-interval',
    method: 'get'
  }
} as const
