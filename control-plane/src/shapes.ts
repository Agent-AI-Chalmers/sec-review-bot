// Server-side vocabulary and helpers derived from the hand-written OpenAPI contract.
//
// The cross-package domain shapes (ReviewRunRecord, ReviewRunAdmission, PublicationWork,
// PublicationStepRecord, ObservedStep, ObservedRun) are owned by
// `contracts/control-plane-api/openapi.yaml` and re-exported here from
// `contract-types-generated.ts`. This module keeps only the server-internal bits that are
// not part of that contract: the small vocabulary unions, the store's create args, and the
// runner-artifact narrowing helper.
import type { RunnerArtifactStorage } from './contracts.js'
import type { components } from './contract-types-generated.js'
import type {
  ObservedRun,
  ObservedStep,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord
} from './contract-types-generated.js'

/** One coordination state transition, as the read endpoint reports it. */
export type ReviewRunEvent = components['schemas']['ReviewRunEvent']

export type {
  ObservedRun,
  ObservedStep,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord
}

export type WorkflowName =
  'issue-review' | 'pull-request-review' | 'repository-review'
export type IngressKind = 'github_webhook' | 'github_actions_dispatch'
export type RunnerStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'uncertain'
  | 'succeeded'
  | 'skipped'
  | 'failed'
export type PublicationStatus =
  'pending' | 'publishing' | 'published' | 'failed' | 'skipped'
/** The redacted preparation summary's state, as both the contract and the run record use it. */
export type PreparationStatus = NonNullable<
  ReviewRunRecord['preparation']
>['status']
export type JsonObject = Record<string, unknown>

/** The durable record's artifact storage, narrowed from the runner's loose type. */
export type ArtifactStorage = ReviewRunRecord['artifact_storage']

/** The observed step summary is the step record minus the reconciliation id and the
 * publisher's attempt bookkeeping. Those describe how Control Plane retried the step, which the
 * console does not show; keeping them here would widen the redacted surface by accident whenever
 * the durable record gains a diagnostic column. */
export type PublicationStepSummary = Omit<
  PublicationStepRecord,
  'remote_object_id' | 'attempt_count' | 'last_attempt_at'
>

/** The arguments the store accepts for a new run. */
export type CreateReviewRunArgs = Pick<
  ReviewRunRecord,
  | 'run_id'
  | 'workflow'
  | 'publish_context'
  | 'runner_input'
  | 'ingress_kind'
  | 'ingress_key'
> & {
  preparation_input?: JsonObject
  preparation_input_version?: string
}

/** Narrow the runner's loose artifact-storage type into the status-discriminated contract
 * shape. The runner's own contract types `artifact` loosely — `RunnerArtifactStorage` requires
 * only `status`, and `artifact` is nullable — because the same schema covers the
 * `unavailable`/`failed` cases where there is no artifact. The contract's `ArtifactStorage`
 * is stricter: the `available` branch requires `artifact`.
 *
 * `parseArtifactStorage` in `runner-client.ts` is what already closes that gap: it rejects an
 * `available` record whose `artifact` is missing, null, or malformed, and returns a
 * fully-checked reference. Every value reaching here has crossed it, so the narrowing below
 * restates an invariant rather than guessing one — and asserts it instead of casting, so a
 * future caller that skips that boundary fails loudly instead of persisting a record the
 * contract forbids.
 *
 * `context` names the record being normalized (the run id) so a violation surfaces in logs
 * as an actionable fault rather than a bare "Internal error". The store calls this on the
 * write path too, so a value that reaches the database has been narrowed once already; a
 * stored record can therefore only fail here if it was written outside this store (a manual
 * edit, or a future code path that bypasses the write methods), and the read-side check is
 * the backstop for exactly that case. */
export function normalizeArtifactStorage(
  storage: RunnerArtifactStorage | null,
  context = 'artifact_storage'
): ArtifactStorage {
  if (storage === null) return null
  if (storage.status === 'available') {
    const artifact = storage.artifact
    if (artifact == null) {
      throw new Error(
        `${context} is an available artifact storage record without its artifact reference; ` +
          'it does not satisfy the contract.'
      )
    }
    return {
      status: 'available',
      artifact: artifact as NonNullable<
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
