// Server-side vocabulary and helpers derived from the hand-written OpenAPI contract.
//
// The cross-package domain shapes (ReviewRunRecord, ReviewRunAdmission, PublicationWork,
// PublicationStepRecord, ObservedStep, ObservedRun) are owned by
// `contracts/control-plane-api/openapi.yaml` and re-exported here from
// `contract-types-generated.ts`. This module keeps only the server-internal bits that are
// not part of that contract: the small vocabulary unions, the store's create args, and the
// runner-artifact narrowing helper.
import type { RunnerArtifactStorage } from './contracts.js'
import type {
  ObservedRun,
  ObservedStep,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord
} from './contract-types-generated.js'

export type {
  ObservedRun,
  ObservedStep,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord
}

export type WorkflowName = 'issue-review' | 'pull-request-review' | 'repository-review'
export type IngressKind = 'github_webhook' | 'github_actions_dispatch'
export type RunnerStatus =
  'preparing' | 'recovering' | 'queued' | 'running' | 'succeeded' | 'failed'
export type PublicationStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
export type JsonObject = Record<string, unknown>

/** The durable record's artifact storage, narrowed from the runner's loose type. */
export type ArtifactStorage = ReviewRunRecord['artifact_storage']

/** The observed step summary is the step record minus the reconciliation id. */
export type PublicationStepSummary = Omit<PublicationStepRecord, 'remote_object_id'>

/** The arguments the store accepts for a new run. */
export type CreateReviewRunArgs = Pick<
  ReviewRunRecord,
  'run_id' | 'workflow' | 'publish_context' | 'runner_input' | 'ingress_kind' | 'ingress_key'
>

/** Narrow the runner's loose artifact-storage type into the status-discriminated contract
 * shape. The runner's OpenAPI types `artifact` and `media_type` loosely, so this is where
 * the observer makes the discrimination explicit rather than passing the flat record
 * through. */
export function normalizeArtifactStorage(storage: RunnerArtifactStorage | null): ArtifactStorage {
  if (storage === null) return null
  if (storage.status === 'available') {
    return {
      status: 'available',
      // The runner only reports `available` once an artifact is stored, and its
      // `media_type` is always the single value the observed contract pins down.
      artifact: storage.artifact as NonNullable<
        Extract<ArtifactStorage, { artifact: unknown }>
      >['artifact']
    }
  }
  return {
    status: storage.status,
    ...(storage.error_code == null ? {} : { error_code: storage.error_code }),
    ...(storage.message == null ? {} : { message: storage.message })
  }
}
