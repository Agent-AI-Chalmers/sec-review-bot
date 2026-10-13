// Generated from ../contracts/control-plane-api/openapi.yaml. Do not edit.
//
// The hand-written openapi.yaml owns the domain shapes; these aliases are its server-side
// projection, so the server's types follow the contract instead of a parallel schema.
// Regenerate it with `pnpm run generate:control-plane-types`.

export interface components {
  schemas: {
    ErrorResponse: {
      error: string
      /** @enum {string} */
      code?:
        | 'INVALID_QUERY'
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
      artifact_storage:
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
      artifact_storage:
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
      artifact_storage:
        | null
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
      publication_steps?: components['schemas']['ObservedPublicationStep'][]
    }
  }
  responses: never
  parameters: never
  requestBodies: never
  headers: never
  pathItems: never
}

export type ReviewRunRecord = components['schemas']['ReviewRunRecord']
export type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']
export type PublicationWork = components['schemas']['PublicationWork']
export type PublicationStepRecord = components['schemas']['PublicationStepRecord']
export type ObservedStep = components['schemas']['ObservedPublicationStep']
export type ObservedRun = components['schemas']['ObservedRun']
