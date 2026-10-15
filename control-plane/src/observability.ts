import type { PublicationStepRecord, ReviewRunRecord } from './review-store.js'
import type { ObservedRun, PublicationStepSummary } from './shapes.js'

export type { ObservedRun, PublicationStepSummary } from './shapes.js'

export function observeRun(run: ReviewRunRecord): ObservedRun {
  return {
    run_id: run.run_id,
    workflow: run.workflow,
    execution_status: run.runner_status,
    publication_status: run.publication_status,
    created_at: run.created_at,
    execution_updated_at: run.execution_updated_at,
    publication_updated_at: run.publication_updated_at,
    published_at: run.published_at,
    failure_code: run.failure_code,
    // `artifact_storage` is already normalized to the discriminated union in
    // `rowToRecord`, so it passes through unchanged here.
    artifact_storage: run.artifact_storage
  }
}

export function observePublicationStep(
  step: PublicationStepRecord
): PublicationStepSummary {
  return {
    step_key: step.step_key,
    status: step.status,
    failure_count: step.failure_count,
    remote_object_url: step.remote_object_url,
    failure_code: step.failure_code,
    failure_message: step.failure_message
  }
}
