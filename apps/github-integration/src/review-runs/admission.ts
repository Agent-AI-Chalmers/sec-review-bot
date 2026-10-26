// Defines the integration-side admission boundary: every accepted connector
// request receives a Review Runs run identity and replayable preparation input.
import type { components } from './review-runs-api.js'

type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']

interface ReviewRunAdmissionRequest {
  workflow: ReviewRunAdmission['record']['workflow']
  ingress_kind: 'github_webhook' | 'github_actions_dispatch'
  ingress_key: string
  preparation_input: Record<string, unknown>
}
interface AdmittedReviewRun {
  run_id: string
  workflow: ReviewRunAdmission['record']['workflow']
  status: string
  created: boolean
  preparation_token: string | null
}

export interface ReviewRunAdmissionStore {
  admitReviewRun: (run: {
    workflow: ReviewRunAdmission['record']['workflow']
    publish_context: Record<string, never>
    ingress_kind: ReviewRunAdmissionRequest['ingress_kind']
    ingress_key: string
    preparation_input_version: string
    preparation_input: Record<string, unknown>
  }) => ReviewRunAdmission | Promise<ReviewRunAdmission>
}

/**
 * Assigns identity before input preparation so every post-admission failure is
 * queryable. The store resolves ingress replays to the original run identity, and Control
 * Plane owns the run id — it generates one on admission and returns it in `record.run_id`.
 */
export async function admitReviewRun(
  store: ReviewRunAdmissionStore,
  request: ReviewRunAdmissionRequest
): Promise<AdmittedReviewRun> {
  const admission = await store.admitReviewRun({
    workflow: request.workflow,
    publish_context: {},
    ingress_kind: request.ingress_kind,
    ingress_key: request.ingress_key,
    preparation_input_version: 'v1',
    preparation_input: request.preparation_input
  })
  return {
    run_id: admission.record.run_id,
    workflow: admission.record.workflow,
    status: admission.record.execution.status,
    created: admission.created,
    preparation_token: admission.preparation_token
  }
}
