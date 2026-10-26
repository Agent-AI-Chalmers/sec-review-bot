// Generated from contracts/execution-api/v1/schemas. Do not edit by hand.
// Regenerate with `pnpm --dir contracts/execution-api/tools run generate`.

export type WorkflowName =
  'issue-review' | 'pull-request-review' | 'repository-review'

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

export type FileChange =
  | {
      path: string
      status: 'upsert'
      content: string
      content_encoding: 'utf-8' | 'base64'
      mode?: '100644' | '100755'
    }
  | {
      path: string
      status: 'deleted'
    }

export interface ReviewRecord {
  analysis: {
    verdict:
      | 'no-actionable-finding'
      | 'inconclusive'
      | 'plausible-risk'
      | 'confirmed-defect'
      | 'confirmed-vulnerability'
      | null
    overview: string | null
    narratives: Record<string, unknown>[]
  }
  mitigation: {
    overview: string | null
    file_changes: FileChange[]
    patch_diff: string | null
  }
  verification: {
    overview: string | null
    review_target_claim: string | null
    validation_level:
      | 'static'
      | 'logic-simulated'
      | 'runtime-partial'
      | 'runtime-endpoint'
      | null
    patch_coverage:
      | 'full'
      | 'partial'
      | 'local-only'
      | 'unresolved'
      | 'misaligned'
      | 'no-patch'
      | 'not-applicable'
      | null
    regression_status:
      'passed' | 'failed' | 'not-run' | 'not-applicable' | 'unresolved' | null
    resolution_next_step: 'none' | 'retry-ai' | 'manual-review' | null
    patch_findings: string[]
    verification_findings: string[]
    residual_risks: string[]
  }
  cvss: null | {
    outcome: 'scored' | 'not-scored' | 'skipped' | null
    base_score: number | null
    severity: string | null
    vector: string | null
    overview: string | null
    not_scored_reason: string | null
  }
}

export interface IssueReviewInput {
  api_version: 'v1'
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
  api_version: 'v1'
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
  api_version: 'v1'
  input_bundle: InputBundleArtifactRef
  review_intent: ReviewIntent
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
  setup_declaration?: string
}

export const MAX_SCAN_TARGET_COMMIT_SHAS = 20000
export const MAX_SCAN_SCOPE_INCREMENTAL_CHANGED_FILES = 5000
export const MAX_SETUP_DECLARATION_TEXT = 65536
export const MAX_WORKFLOW_INPUT_BYTES = 1500000
export const MAX_PR_COMMIT_SHAS = 20000
