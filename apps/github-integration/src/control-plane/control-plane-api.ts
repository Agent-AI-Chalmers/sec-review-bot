// Generated from ../contracts/control-plane-api/openapi.yaml. Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with `pnpm run generate:control-plane-types`.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get: operations['getHealth']
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
    get: operations['listRuns']
    put?: never
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
    post: operations['renewPreparationClaim']
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
    post: operations['failPreparation']
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
      runner_status: 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
      /** @enum {string} */
      publication_status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
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
      runner_status: 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
      /** @enum {string} */
      publication_status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
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
      execution_status: 'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
      /** @enum {string} */
      publication_status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
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
      publication_steps?: components['schemas']['ObservedPublicationStep'][]
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
  responses: never
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
    }
  }
  listRuns: {
    parameters: {
      query?: {
        limit?: number
        cursor?: string
        execution_status?:
          'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
        publication_status?: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
        workflow?: 'issue-review' | 'pull-request-review' | 'repository-review'
        from?: string
        to?: string
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
      /** @description The request was rejected; see `code` for the machine-readable reason. */
      400: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
      /** @description The referenced run was not found. */
      404: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
      /** @description The referenced run was not found. */
      404: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
            workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
            /** @enum {string} */
            status: 'queued'
          }
        }
      }
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
        }
      }
    }
    responses: {
      /** @description Fail acknowledgement (empty). */
      200: {
        headers: {
          [name: string]: unknown
        }
        content?: never
      }
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
            id?: string | number | null
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
      /** @description The referenced run was not found. */
      404: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
      /** @description The referenced run was not found. */
      404: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
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
      /** @description Missing or invalid bearer credential for the operation's security scheme. */
      401: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ErrorResponse']
        }
      }
    }
  }
}
