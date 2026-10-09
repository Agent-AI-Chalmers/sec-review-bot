/**
 * The smallest boundary owned by Control Plane.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Control Plane only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
export type ControlPlaneWorkflow = 'issue-review' | 'pull-request-review' | 'repository-review'

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
