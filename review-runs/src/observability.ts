import type { PublicationStepRecord, ReviewRunRecord } from './review-store.js'
import type { ObservedRun, PublicationStepSummary } from './shapes.js'

export type { ObservedRun, PublicationStepSummary } from './shapes.js'

export function observeRun(run: ReviewRunRecord): ObservedRun {
  // The record and observed-run shapes now agree on every axis, so this is a redaction rather
  // than a projection: it drops the connector-owned context, the Execution input, the connector
  // identity, and the failure detail, and keeps the rest verbatim.
  return {
    run_id: run.run_id,
    workflow: run.workflow,
    preparation: run.preparation,
    execution: run.execution,
    publication: run.publication,
    created_at: run.created_at,
    failure_code: run.failure_code,
    // `artifact_storage` is already normalized to the discriminated union in
    // `rowToRecord`, so it passes through unchanged here.
    artifact_storage: run.artifact_storage,
    // Whether the requester has been told is an operator concern, not connector-owned state, so
    // it survives redaction. It reports the axis and reason, never the delivery internals.
    notices: run.notices
  }
}

export function observePublicationStep(
  step: PublicationStepRecord
): PublicationStepSummary {
  return {
    step_key: step.step_key,
    status: step.status,
    attempt_count: step.attempt_count,
    remote_object_url: step.remote_object_url,
    failure_code: step.failure_code,
    failure_message: step.failure_message
  }
}
