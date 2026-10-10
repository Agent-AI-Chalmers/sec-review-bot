/**
 * The smallest boundary owned by Control Plane.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Control Plane only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
import type { components } from './runner-api-schema.js'

export type ControlPlaneWorkflow = 'issue-review' | 'pull-request-review' | 'repository-review'

/**
 * The operations `POST /v1/store` accepts.
 *
 * The GitHub integration sends these by name over HTTP and Control Plane dispatches them
 * by name, so this list is the boundary's surface rather than an implementation detail:
 * the server refuses anything absent from it, and the client must send nothing else.
 * `apps/github-integration` asserts that its own sends stay inside this list, because the
 * two sides are separate packages whose operation lists can drift silently — which they
 * had: two methods kept sending names Control Plane had stopped accepting.
 */
export const controlPlaneOperations = [
  'submit_prepared_run',
  'admit_review_run',
  'getRun',
  'failPreparation',
  'renewPreparationClaim',
  'preparationHeartbeatIntervalMs',
  'claimNextPublication',
  'renewPublicationClaim',
  'initializePublicationSteps',
  'listPublicationSteps',
  'requirePublicationStepClaim',
  'completePublicationStep',
  'failPublicationStep',
  'completePublication',
  'failPublication'
] as const

export type ControlPlaneOperation = (typeof controlPlaneOperations)[number]

/**
 * Where a terminal run's diagnostics went.
 *
 * The runner owns this shape and publishes it in its OpenAPI document, which
 * `runner-api-schema.ts` projects here. This name is kept because the rest of the package
 * imports it, but the definition has one home rather than three.
 */
export type RunnerArtifactStorage = components['schemas']['RunnerArtifactStorage']

export interface InputArtifactRef {
  uri: string
  media_type: string
  size_bytes: number
  digest: `sha256:${string}`
}

export interface AdmittedReviewRun {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
  created: boolean
  preparation_token: string | null
}

export interface ReviewRunAdmissionRequest {
  workflow: ControlPlaneWorkflow
  ingress_kind: 'github_webhook' | 'github_actions_dispatch'
  ingress_key: string
}

export interface ReviewRunCoordinator {
  admit(request: ReviewRunAdmissionRequest): Promise<AdmittedReviewRun>
}
