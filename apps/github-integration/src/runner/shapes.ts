// Runner vocabulary this service restates on the store boundary.
//
// Neither type arrives over the runner's HTTP API: the workflow name is part of the request
// Control Plane makes, and the artifact shape is what Control Plane persisted and returns in
// a run record over `POST /v1/store`.
export type WorkflowName = 'issue-review' | 'pull-request-review' | 'repository-review'

export interface RunnerArtifactStorage {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: { kind: string; uri: string; media_type: string; digest: string; size_bytes: number }
  error_code?: string
  message?: string
}
