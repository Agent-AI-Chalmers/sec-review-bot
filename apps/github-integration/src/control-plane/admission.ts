import type { components } from './control-plane-api.js'

type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']

interface ReviewRunAdmissionRequest {
  workflow: ReviewRunAdmission['record']['workflow']
  ingress_kind: 'github_webhook' | 'github_actions_dispatch'
  ingress_key: string
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
    ingress_key: request.ingress_key
  })
  return {
    run_id: admission.record.run_id,
    workflow: admission.record.workflow,
    status: admission.record.runner_status,
    created: admission.created,
    preparation_token: admission.preparation_token
  }
}
