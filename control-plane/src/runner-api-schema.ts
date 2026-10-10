// Generated from ../contracts/integration-contract/openapi.json. Do not edit.
//
// That document is owned by the agents package and checked there against the service code,
// so this file is a projection of a contract rather than a second copy of one. Regenerate
// it with `pnpm run generate:runner-api`.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** Healthz */
    get: operations['healthz_healthz_get']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/status': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Get Run Statuses */
    post: operations['get_run_statuses_v1_runs_status_post']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/runs/{run_id}': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** Get Run */
    get: operations['get_run_v1_runs__run_id__get']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/workflows/{workflow}/runs': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** Create Run */
    post: operations['create_run_v1_workflows__workflow__runs_post']
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
    /**
     * CreateRunRequest
     * @description A request to start one workflow run.
     */
    CreateRunRequest: {
      /** Input */
      input: {
        [key: string]: unknown
      }
      /** Run Id */
      run_id: string
      /** Runtime */
      runtime?: {
        [key: string]: unknown
      } | null
    }
    /** HTTPValidationError */
    HTTPValidationError: {
      /** Detail */
      detail?: components['schemas']['ValidationError'][]
    }
    /** HealthResponse */
    HealthResponse: {
      /**
       * Status
       * @constant
       */
      status: 'ok'
    }
    /**
     * RunResponse
     * @description One run as the runner reports it.
     *
     *     `result`, `error`, and `artifact_storage` are omitted rather than null until they exist,
     *     which is why the route serializes with `exclude_none`.
     */
    RunResponse: {
      artifact_storage?: components['schemas']['RunnerArtifactStorage'] | null
      /** Error */
      error?: {
        [key: string]: unknown
      } | null
      /** Result */
      result?: unknown
      /** Run Id */
      run_id?: string | null
      /**
       * Status
       * @enum {string}
       */
      status: 'queued' | 'running' | 'succeeded' | 'failed'
      /** Workflow */
      workflow?: string | null
    }
    /**
     * RunStatusQuery
     * @description Which runs a status query wants status tokens for.
     */
    RunStatusQuery: {
      /** Run Ids */
      run_ids: string[]
    }
    /** RunStatusResponse */
    RunStatusResponse: {
      /**
       * Missing
       * @description Requested run IDs the runner holds no record for.
       */
      missing: string[]
      /** Runs */
      runs: components['schemas']['RunStatusToken'][]
    }
    /**
     * RunStatusToken
     * @description One run's status, without its record.
     *
     *     A polling caller asks whether anything changed far more often than it needs results, so
     *     this carries no result: the full record is fetched once per terminal run.
     */
    RunStatusToken: {
      /** Run Id */
      run_id: string
      /** Status */
      status: string
    }
    /**
     * RunnerArtifactRef
     * @description A stored diagnostic bundle, as `store_run_artifacts` reports it.
     */
    RunnerArtifactRef: {
      /** Digest */
      digest: string
      /**
       * Kind
       * @constant
       */
      kind: 'diagnostic_bundle'
      /** Media Type */
      media_type: string
      /** Size Bytes */
      size_bytes: number
      /** Uri */
      uri: string
    }
    /**
     * RunnerArtifactStorage
     * @description Where a terminal run's diagnostics went, or why they are not there.
     *
     *     The runner only attaches this once a run reaches a terminal state, and reports a failed
     *     upload as a status rather than an error, because storage is diagnostic metadata and not
     *     the business result.
     */
    RunnerArtifactStorage: {
      artifact?: components['schemas']['RunnerArtifactRef'] | null
      /** Error Code */
      error_code?: string | null
      /** Message */
      message?: string | null
      /**
       * Status
       * @enum {string}
       */
      status: 'available' | 'unavailable' | 'failed'
    }
    /**
     * RunnerError
     * @description The envelope every runner error carries.
     */
    RunnerError: {
      /**
       * Category
       * @enum {string}
       */
      category: 'input' | 'workflow' | 'llm' | 'runtime' | 'internal'
      /**
       * Code
       * @description Stable machine-readable error code.
       */
      code: string
      /** Details */
      details?: {
        [key: string]: unknown
      }
      /** Message */
      message: string
      /** Retryable */
      retryable: boolean
    }
    /**
     * RunnerErrorResponse
     * @description An error body.
     *
     *     `run_id` and `workflow` are present when the runner already knows which run the request
     *     concerned, so a caller can attribute a failure without echoing its own request back.
     */
    RunnerErrorResponse: {
      error: components['schemas']['RunnerError']
      /** Run Id */
      run_id?: string | null
      /** Workflow */
      workflow?: string | null
    }
    /** ValidationError */
    ValidationError: {
      /** Context */
      ctx?: Record<string, never>
      /** Input */
      input?: unknown
      /** Location */
      loc: (string | number)[]
      /** Message */
      msg: string
      /** Error Type */
      type: string
    }
  }
  responses: never
  parameters: never
  requestBodies: never
  headers: never
  pathItems: never
}
export type $defs = Record<string, never>
export interface operations {
  healthz_healthz_get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['HealthResponse']
        }
      }
    }
  }
  get_run_statuses_v1_runs_status_post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['RunStatusQuery']
      }
    }
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunStatusResponse']
        }
      }
      /** @description Bad Request */
      400: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunnerErrorResponse']
        }
      }
      /** @description Validation Error */
      422: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['HTTPValidationError']
        }
      }
    }
  }
  get_run_v1_runs__run_id__get: {
    parameters: {
      query?: never
      header?: never
      path: {
        run_id: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunResponse']
        }
      }
      /** @description Not Found */
      404: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunnerErrorResponse']
        }
      }
      /** @description Validation Error */
      422: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['HTTPValidationError']
        }
      }
    }
  }
  create_run_v1_workflows__workflow__runs_post: {
    parameters: {
      query?: never
      header?: never
      path: {
        workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
      }
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['CreateRunRequest']
      }
    }
    responses: {
      /** @description Successful Response */
      202: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunResponse']
        }
      }
      /** @description Bad Request */
      400: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunnerErrorResponse']
        }
      }
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['RunnerErrorResponse']
        }
      }
      /** @description Validation Error */
      422: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['HTTPValidationError']
        }
      }
    }
  }
}
