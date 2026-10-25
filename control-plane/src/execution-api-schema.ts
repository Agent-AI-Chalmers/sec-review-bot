// Generated from contracts/integration-contract/openapi.yaml (path relative to the repository root). Do not edit.
//
// This file is a generated projection of the contract. Regenerate it with
// `pnpm --dir contracts/integration-contract/tools run generate`.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /**
     * Healthz
     * @description Report whether the Execution API process is serving requests. Requires no credential.
     */
    get: operations['health']
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
    /**
     * Get Run Statuses
     * @description Return status tokens for a bounded set of run IDs.
     */
    post: operations['getRunStatuses']
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
    /**
     * Get Run
     * @description Return the current public record for one execution run.
     */
    get: operations['getRun']
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
    /**
     * Create Run
     * @description Validate and submit one workflow run for asynchronous execution.
     */
    post: operations['createRun']
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
    /**
     * ExecutionArtifactStorage
     * @description Where a terminal run's diagnostics went, or why they are not there.
     *
     *     The Execution API provider only attaches this once a run reaches a terminal state, and reports a failed
     *     upload as a status rather than an error, because storage is diagnostic metadata and not
     *     the business result.
     */
    ExecutionArtifactStorage: {
      artifact?: components['schemas']['ExecutionDiagnosticArtifact'] | null
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
     * ExecutionDiagnosticArtifact
     * @description The Execution's public projection of one stored diagnostic bundle.
     */
    ExecutionDiagnosticArtifact: {
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
     * ExecutionError
     * @description The envelope every execution error carries.
     */
    ExecutionError: {
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
     * ExecutionErrorResponse
     * @description An error body.
     *
     *     `run_id` and `workflow` are present when the Execution API provider already knows which run the request
     *     concerned, so a caller can attribute a failure without echoing its own request back.
     */
    ExecutionErrorResponse: {
      error: components['schemas']['ExecutionError']
      /** Run Id */
      run_id?: string | null
      /** Workflow */
      workflow?: string | null
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
     * @description One run as the Execution API provider reports it.
     *
     *     Optional result, diagnostic, and post-processing fields are omitted rather
     *     than null until they exist, which is why the route serializes with
     *     `exclude_none`.
     */
    RunResponse: {
      artifact_storage?:
        components['schemas']['ExecutionArtifactStorage'] | null
      /** Error */
      error?: components['schemas']['ExecutionError'] | null
      /** Memory Processing */
      memory_processing?: {
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
       * @description Requested run IDs the Execution API provider holds no record for.
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
      /**
       * Status
       * @description The run's status as the workflow gateway reports it.
       */
      status: string
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
  health: {
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
      /** @description Internal Server Error */
      500: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
    }
  }
  getRunStatuses: {
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
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Payload Too Large */
      413: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Internal Server Error */
      500: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
    }
  }
  getRun: {
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
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Internal Server Error */
      500: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
    }
  }
  createRun: {
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
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Payload Too Large */
      413: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
      /** @description Internal Server Error */
      500: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExecutionErrorResponse']
        }
      }
    }
  }
}

export interface InputBundleArtifactRef {
  uri: string
  digest: string
  media_type: 'application/tar+zstd'
  size_bytes: number
}

export interface ReviewIntent {
  objective: 'audit' | 'repair'
  test_changes?: 'allow' | 'deny'
}

export interface RepositoryScanTarget {
  target_branch: string
  default_branch: string
  event_type: 'manual' | 'scheduled'
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string
  commit_shas: string[]
}

export interface RepositoryScanScope {
  paths_ignore: string[]
  incremental_changed_files: {
    path: string
    status:
      'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed'
    previous_path: string | null
  }[]
}

export interface IssueReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  issue: {
    owner: string
    repo: string
    repo_full_name: string
    number: number
    title: string
    body: string | null
  }
  setup_declaration?: string
}

export interface PullRequestReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  pr: {
    owner: string
    repo: string
    repo_full_name: string
    number: number
    title: string
    body: string | null
    base_ref: string
    base_sha: string
    head_ref: string
    head_sha: string
    commit_shas: string[]
    review_window: {
      kind: 'full' | 'push'
      base_sha: string
      head_sha: string
      reason: string
    }
  }
  setup_declaration?: string
}

export interface RepositoryReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
  setup_declaration?: string
}

export interface WorkflowInputByName {
  'issue-review': IssueReviewInput
  'pull-request-review': PullRequestReviewInput
  'repository-review': RepositoryReviewInput
}

export type ExecutionWorkflow = keyof WorkflowInputByName

export type CreateRunRequestFor<Workflow extends ExecutionWorkflow> = Omit<
  components['schemas']['CreateRunRequest'],
  'input'
> & {
  input: WorkflowInputByName[Workflow]
}
