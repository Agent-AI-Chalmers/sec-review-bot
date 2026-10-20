// Generated from contracts/integration-contract/v6/schemas. Do not edit by hand.
// Regenerate with `pnpm --dir contracts/integration-contract/tools run generate`.

export interface InputBundleArtifactRef {
  uri: string
  digest: string
  media_type: 'application/tar+zstd'
  size_bytes: number
}

export interface ReviewIntent {
  objective: 'audit' | 'repair'
  test_changes?: 'allow' | 'deny'
}

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
  incremental_changed_files: {
    path: string
    status:
      'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed'
    previous_path: string | null
  }[]
}

export const MAX_SCAN_TARGET_COMMIT_SHAS = 20000
export const MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES = 5000
export const MAX_SETUP_DECLARATION_TEXT = 65536
export const MAX_WORKFLOW_INPUT_BYTES = 1500000
export const MAX_PR_COMMIT_SHAS = 20000

export interface IssueReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  issue: {
    owner: string
    repo: string
    repo_full_name: string
    number: number
    title: string
    body: string | null
  }
  setup_declaration?: string
}

export interface PullRequestReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  pr: {
    owner: string
    repo: string
    repo_full_name: string
    number: number
    title: string
    body: string | null
    base_ref: string
    base_sha: string
    head_ref: string
    head_sha: string
    commit_shas: string[]
    review_window: {
      kind: 'full' | 'push'
      base_sha: string
      head_sha: string
      reason: string
    }
  }
  setup_declaration?: string
}

export interface RepositoryReviewInput {
  contract_version: 'v6'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
  setup_declaration?: string
}
