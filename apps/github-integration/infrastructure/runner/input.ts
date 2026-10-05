// GitHub integration prepared input shapes. The Python runner normalizer remains the
// authoritative runtime contract.

export interface RepositoryScanTarget {
  target_branch: string
  default_branch: string
  event_type: 'manual' | 'scheduled'
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string
  commit_shas: string[]
}

export interface RepositoryScanScope {
  paths_ignore: string[]
  incremental_changed_files: Array<{
    path: string
    status: string
    previous_path: string | null
  }>
}

export type RepairMode = 'test-changes-allowed' | 'no-test-changes'
export type ReviewObjective = 'audit' | 'repair'

export interface ReviewIntent {
  objective: ReviewObjective
  repair_mode?: RepairMode
}

export interface InputBundleArtifactRef {
  uri: string
  digest: `sha256:${string}`
  media_type: 'application/vnd.sec-review.input-bundle.v1+tar+zstd'
  size_bytes: number
}

interface RunnerWorkflowInputBase {
  contract_version: 'v5'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
}

export interface IssueReviewInput extends RunnerWorkflowInputBase {
  issue: Record<string, unknown>
}

export interface PullRequestReviewInput extends RunnerWorkflowInputBase {
  pr: Record<string, unknown>
}

export interface RepositoryReviewInput extends RunnerWorkflowInputBase {
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
}
