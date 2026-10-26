// Generated from contracts/memory-catalog-api/v1/openapi.yaml. Do not edit.
export interface paths {
  '/healthz': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Report whether the Memory Catalog process is serving requests. */
    get: operations['health']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/extractions': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description List completed extractions newest first with stable cursor pagination. */
    get: operations['listExtractions']
    put?: never
    /** @description Register one completed extraction and its optional observation, or replay identical content. */
    post: operations['registerExtraction']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/extractions/{extraction_id}': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Return one completed extraction, its transcript reference, and its optional observation. */
    get: operations['getExtraction']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/observation-backlog': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Summarize observations that have not yet been consumed by a memory revision. */
    get: operations['getObservationBacklog']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/observations': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description List observations newest first with stable cursor pagination and processing filters. */
    get: operations['listObservations']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/overview': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Summarize completed extraction coverage, observation outcomes, and a selectable trend range. All-time trends are aggregated by month; bounded trends are aggregated by day. */
    get: operations['getCatalogOverview']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/maintenance-input': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Return a bounded observation set and the active memory state it must be maintained against. */
    get: operations['getMaintenanceInput']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/memory-tree/revisions': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description List immutable memory tree revisions in descending revision order. */
    get: operations['listMemoryTreeRevisions']
    put?: never
    /** @description Create an immutable memory tree revision with compare-and-swap and consume its source observations. */
    post: operations['createMemoryTreeRevision']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/memory-tree': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Return the current memory tree revision and its artifact reference, if one exists. */
    get: operations['getMemoryTree']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/memory-tree/restore': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Move the active memory pointer to an existing revision without creating a revision. */
    post: operations['restoreMemoryTree']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/maintenance-control': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Return whether automatic memory maintenance is currently allowed. */
    get: operations['getMaintenanceControl']
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/maintenance-control/pause': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Idempotently transition automatic maintenance from enabled to paused. */
    post: operations['pauseMaintenance']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/maintenance-control/resume': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    get?: never
    put?: never
    /** @description Idempotently transition automatic maintenance from paused to enabled. */
    post: operations['resumeMaintenance']
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  '/v1/memory-tree/revisions/{revision}': {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    /** @description Return one immutable memory tree revision and its maintenance transcript. */
    get: operations['getMemoryTreeRevision']
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
    ArtifactReference: {
      uri: string
      digest: string
      media_type: string
      size_bytes: number
    }
    ExtractionId: string
    MaintenanceId: string
    OperationId: string
    Actor: {
      /** @enum {string} */
      kind: 'user' | 'service'
      id: string
    }
    ExtractionObservation: {
      body_markdown: string
    }
    ExtractionRegistration: {
      extraction_id: components['schemas']['ExtractionId']
      source_workflow: string
      source_run_id: string
      source_unit_id: string
      diagnostic_bundle_digest: string
      transcript_reference: components['schemas']['ArtifactReference']
      observation: components['schemas']['ExtractionObservation'] | null
    }
    ExtractionRegistrationResult: {
      /** @constant */
      ok: true
      created: boolean
    }
    ExtractionRecord: {
      extraction_id: components['schemas']['ExtractionId']
      source_workflow: string
      source_run_id: string
      source_unit_id: string
      diagnostic_bundle_digest: string
      transcript_reference: components['schemas']['ArtifactReference']
      observation: components['schemas']['ExtractionObservation'] | null
      /** Format: date-time */
      created_at: string
    }
    ExtractionList: {
      extractions: components['schemas']['ExtractionRecord'][]
      next_cursor: string | null
    }
    ObservationRecord: {
      extraction_id: components['schemas']['ExtractionId']
      source_run_id: string
      source_unit_id: string
      body_markdown: string
      consumed_revision: number | null
      /** Format: date-time */
      created_at: string
    }
    ObservationList: {
      observations: components['schemas']['ObservationRecord'][]
      next_cursor: string | null
    }
    ObservationBacklog: {
      pending_count: number
      /** Format: date-time */
      oldest_pending_created_at: string | null
    }
    CatalogOverviewTotals: {
      completed_extraction_count: number
      extracted_unit_count: number
      units_with_observation_count: number
      /** @description Distinct source run/unit pairs whose completed extractions have never produced an observation. */
      units_without_observation_count: number
      observation_count: number
      pending_observation_count: number
      consumed_observation_count: number
    }
    CatalogOverviewPoint: {
      /**
       * Format: date
       * @description Inclusive UTC start date of the day or month represented by this point.
       */
      period_start: string
      extracted_unit_count: number
      units_with_observation_count: number
    }
    CatalogOverviewWorkflow: {
      source_workflow: string
      extracted_unit_count: number
      units_with_observation_count: number
      units_without_observation_count: number
    }
    CatalogOverview: {
      totals: components['schemas']['CatalogOverviewTotals']
      /** @enum {string} */
      trend_granularity: 'day' | 'month'
      trend_points: components['schemas']['CatalogOverviewPoint'][]
      workflows: components['schemas']['CatalogOverviewWorkflow'][]
    }
    MaintenanceObservation: {
      extraction_id: components['schemas']['ExtractionId']
      body_markdown: string
    }
    MaintenanceInput: {
      /** @description Active revision that must still be current when this maintenance input is committed. */
      expected_active_revision: number
      active_memory_tree_reference:
        components['schemas']['ArtifactReference'] | null
      observations: components['schemas']['MaintenanceObservation'][]
    }
    MaintenanceInputResult: {
      input: components['schemas']['MaintenanceInput'] | null
    }
    MaintenanceRevisionSource: {
      /** @constant */
      kind: 'maintenance'
      maintenance_id: components['schemas']['MaintenanceId']
      extraction_ids: components['schemas']['ExtractionId'][]
      transcript_reference: components['schemas']['ArtifactReference']
    }
    OperatorRevisionSource: {
      /** @constant */
      kind: 'operator'
      operation_id: components['schemas']['OperationId']
      actor: components['schemas']['Actor']
    }
    MemoryTreeRevisionSource:
      | components['schemas']['MaintenanceRevisionSource']
      | components['schemas']['OperatorRevisionSource']
    MemoryTreeRevisionCreation: {
      /** @description Active revision that must still be current for this compare-and-swap commit. */
      expected_active_revision: number
      memory_tree_reference: components['schemas']['ArtifactReference']
      source: components['schemas']['MemoryTreeRevisionSource']
    }
    MemoryTreeRevisionCreationResult: {
      created: boolean
      revision: number
      source:
        | {
            /** @constant */
            kind: 'maintenance'
            maintenance_id: components['schemas']['MaintenanceId']
          }
        | {
            /** @constant */
            kind: 'operator'
            operation_id: components['schemas']['OperationId']
          }
    }
    MemoryTree: {
      revision: number
      memory_tree_reference: components['schemas']['ArtifactReference'] | null
    }
    MemoryTreeRevision: {
      revision: number
      /** @description Revision that was active when this revision was created; null for the first revision. */
      predecessor_revision: number | null
      memory_tree_reference: components['schemas']['ArtifactReference']
      source: components['schemas']['MemoryTreeRevisionSource']
      /** Format: date-time */
      created_at: string
    }
    MemoryTreeRestoreOperation: {
      operation_id: components['schemas']['OperationId']
      expected_active_revision: number
      restored_revision: number
      actor: components['schemas']['Actor']
    }
    MemoryTreeRestoreOperationResult: {
      created: boolean
      active_revision: number
      operation_id: components['schemas']['OperationId']
    }
    MemoryTreeRevisionList: {
      revisions: components['schemas']['MemoryTreeRevision'][]
      next_before_revision: number | null
    }
    MaintenanceControl: {
      /** @enum {string} */
      state: 'enabled' | 'paused'
      generation: number
      changed_by: components['schemas']['Actor']
      /** Format: date-time */
      changed_at: string
    }
    MaintenanceControlOperation: {
      operation_id: components['schemas']['OperationId']
      expected_generation: number
      actor: components['schemas']['Actor']
    }
    MaintenanceControlOperationResult: {
      created: boolean
      control: components['schemas']['MaintenanceControl']
    }
    Health: {
      /** @constant */
      status: 'ok'
    }
    ErrorResponse: {
      error: string
      /** @enum {string} */
      code?:
        | 'INVALID_BODY'
        | 'UNAUTHORIZED'
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'INTERNAL_ERROR'
    }
  }
  responses: {
    /** @description The JSON body does not match the operation schema. */
    InvalidBody: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description Missing or invalid catalog bearer token. */
    Unauthorized: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description An immutable identity differs from existing content, or a revision compare-and-swap precondition failed. */
    Conflict: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description The requested catalog record does not exist. */
    NotFound: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description Opaque internal server error. */
    InternalError: {
      headers: {
        [name: string]: unknown
      }
      content: {
        'application/json': components['schemas']['ErrorResponse']
      }
    }
    /** @description The request body exceeds the service limit. */
    PayloadTooLarge: {
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
  health: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Service is running. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['Health']
        }
      }
      500: components['responses']['InternalError']
    }
  }
  listExtractions: {
    parameters: {
      query?: {
        cursor?: string
        limit?: string
        source_workflow?: string
        source_run_id?: string
        has_observation?: 'true' | 'false'
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description One page of completed extractions. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExtractionList']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  registerExtraction: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['ExtractionRegistration']
      }
    }
    responses: {
      /** @description Extraction accepted or identically replayed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExtractionRegistrationResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getExtraction: {
    parameters: {
      query?: never
      header?: never
      path: {
        extraction_id: components['schemas']['ExtractionId']
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The requested extraction. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ExtractionRecord']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      404: components['responses']['NotFound']
      500: components['responses']['InternalError']
    }
  }
  getObservationBacklog: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Pending observation count and age. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ObservationBacklog']
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  listObservations: {
    parameters: {
      query?: {
        cursor?: string
        limit?: string
        status?: 'pending' | 'consumed'
        consumed_revision?: string
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description One page of observations and their consumption state. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['ObservationList']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  getCatalogOverview: {
    parameters: {
      query?: {
        range?: '30d' | '90d' | 'all'
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Aggregate Memory Catalog statistics. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['CatalogOverview']
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  getMaintenanceInput: {
    parameters: {
      query: {
        limit: string
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Current memory state and bounded pending observations, or null when none are pending. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceInputResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  listMemoryTreeRevisions: {
    parameters: {
      query?: {
        before_revision?: string
        limit?: string
      }
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description One page of immutable memory tree revision history. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRevisionList']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  createMemoryTreeRevision: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MemoryTreeRevisionCreation']
      }
    }
    responses: {
      /** @description An identical maintenance submission had already created this revision. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRevisionCreationResult']
        }
      }
      /** @description The revision was created. */
      201: {
        headers: {
          Location?: string
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRevisionCreationResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getMemoryTree: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Current memory tree revision and artifact reference. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTree']
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  restoreMemoryTree: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MemoryTreeRestoreOperation']
      }
    }
    responses: {
      /** @description An identical restore operation was replayed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRestoreOperationResult']
        }
      }
      /** @description The active memory pointer was restored. */
      201: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRestoreOperationResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getMaintenanceControl: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description Current durable maintenance control state. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceControl']
        }
      }
      401: components['responses']['Unauthorized']
      500: components['responses']['InternalError']
    }
  }
  pauseMaintenance: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MaintenanceControlOperation']
      }
    }
    responses: {
      /** @description An identical control operation was replayed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceControlOperationResult']
        }
      }
      /** @description Automatic maintenance was paused. */
      201: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceControlOperationResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  resumeMaintenance: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: {
      content: {
        'application/json': components['schemas']['MaintenanceControlOperation']
      }
    }
    responses: {
      /** @description An identical control operation was replayed. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceControlOperationResult']
        }
      }
      /** @description Automatic maintenance was enabled. */
      201: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MaintenanceControlOperationResult']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      409: components['responses']['Conflict']
      413: components['responses']['PayloadTooLarge']
      500: components['responses']['InternalError']
    }
  }
  getMemoryTreeRevision: {
    parameters: {
      query?: never
      header?: never
      path: {
        revision: string
      }
      cookie?: never
    }
    requestBody?: never
    responses: {
      /** @description The requested immutable memory tree revision. */
      200: {
        headers: {
          [name: string]: unknown
        }
        content: {
          'application/json': components['schemas']['MemoryTreeRevision']
        }
      }
      400: components['responses']['InvalidBody']
      401: components['responses']['Unauthorized']
      404: components['responses']['NotFound']
      500: components['responses']['InternalError']
    }
  }
}
