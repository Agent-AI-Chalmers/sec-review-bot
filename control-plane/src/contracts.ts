/**
 * The smallest boundary owned by Control Plane.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Control Plane only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
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

export interface RunnerArtifactStorage {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: {
    kind: string
    uri: string
    media_type: string
    digest: string
    size_bytes: number
  }
  error_code?: string
  message?: string
}

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
