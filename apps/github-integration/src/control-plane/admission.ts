import { randomUUID } from 'node:crypto'

import type { WorkflowName as ControlPlaneWorkflow } from '../runner/shapes.js'

interface ReviewRunAdmissionRequest {
  workflow: ControlPlaneWorkflow
  ingress_kind: 'github_webhook' | 'github_actions_dispatch'
  ingress_key: string
}
interface AdmittedReviewRun {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
  created: boolean
  preparation_token: string | null
}

interface StoredAdmission {
  record: {
    run_id: string
    workflow: ControlPlaneWorkflow
    runner_status: string
  }
  created: boolean
  preparation_token: string | null
}

export interface ReviewRunAdmissionStore {
  admit_review_run: (run: {
    run_id: string
    workflow: ControlPlaneWorkflow
    publish_context: Record<string, never>
    ingress_kind: ReviewRunAdmissionRequest['ingress_kind']
    ingress_key: string
  }) => StoredAdmission | Promise<StoredAdmission>
}

/**
 * Assigns identity before input preparation so every post-admission failure is
 * queryable. The store resolves ingress replays to the original run identity.
 */
export async function admitReviewRun(
  store: ReviewRunAdmissionStore,
  request: ReviewRunAdmissionRequest,
  createRunId: () => string = randomUUID
): Promise<AdmittedReviewRun> {
  const admission = await store.admit_review_run({
    run_id: createRunId(),
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
