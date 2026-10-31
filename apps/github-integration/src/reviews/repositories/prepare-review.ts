import { splitRepoFullName } from '../../github/repository-service.js'
import { prepareRepositoryReviewInput } from './prepare-input.js'
import { fetchTrustedRepositoryTriggerConfig } from '../../github/repo-config-service.js'
import type { Octokit } from 'octokit'
import { logInfo } from '../../utils/logger.js'
import type {
  TestChangesPolicy,
  RepositoryScanTarget,
  RepositoryReviewInput
} from '../../execution/input.js'

export interface RepositoryContext {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
}

interface PrepareRepositoryReviewArgs {
  run_id: string
  octokit: Octokit
  repo_full_name: string
  target_branch?: string | null
  scan_mode: 'full' | 'incremental'
  base_sha?: string | null
  head_sha?: string | null
  event_type?: 'manual' | 'scheduled'
  test_changes?: TestChangesPolicy | null
}

export interface PreparedRepositoryReviewRun {
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target: RepositoryScanTarget
  workflow: string
  event_type: 'manual' | 'scheduled'
}

function assertRepositoryReviewInput(
  input: RepositoryReviewInput
): asserts input is RepositoryReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Repository review input is missing after preparation.')
  }
}

export async function prepareRepositoryReview({
  run_id,
  octokit,
  repo_full_name,
  target_branch = null,
  scan_mode,
  base_sha = null,
  head_sha = null,
  event_type = 'manual',
  test_changes = null
}: PrepareRepositoryReviewArgs): Promise<{
  review: PreparedRepositoryReviewRun
  input: RepositoryReviewInput & Record<string, unknown>
}> {
  logInfo('repository_review_workflow_started', {
    event_type,
    branch: target_branch ?? '(default-branch)',
    head_sha: head_sha ?? '(resolve-from-branch)',
    repo: repo_full_name
  })

  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const github = octokit
  // Read trigger config from the API-resolved default branch, not the
  // user-selectable target_branch.
  const trusted = await fetchTrustedRepositoryTriggerConfig(github, {
    owner_login,
    repo_name
  })
  const pathConfig = trusted.config

  const prepared = await prepareRepositoryReviewInput({
    run_id,
    octokit: github,
    repo_full_name,
    trusted_default_branch: {
      default_branch: trusted.default_branch,
      head_sha: trusted.head_sha
    },
    target_branch,
    scan_mode,
    base_sha,
    head_sha,
    event_type,
    paths_ignore: pathConfig.paths_ignore,
    test_changes
  })
  const input = prepared.input
  assertRepositoryReviewInput(input)
  return {
    review: {
      repo: prepared.repo,
      run_id,
      workspace_ref: prepared.workspace_ref,
      scan_target: input.scan_target,
      workflow: 'repository-review',
      event_type
    },
    input
  }
}
