import { splitRepoFullName } from '../../infrastructure/github/repository-service.js'
import { prepareRepositoryReviewInput } from './prepare-input.js'
import { fetchRepositoryTriggerConfig } from '../../infrastructure/github/repo-config-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { submitRunnerRun } from '../../infrastructure/runner/client.js'
import { logInfo } from '../../utils/logger.js'
import type {
  RepairMode,
  RepositoryScanTarget,
  RepositoryReviewInput
} from '../../infrastructure/runner/input.js'

export interface RepositoryContext {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
}

interface RunRepositoryReviewArgs {
  octokit: unknown
  repo_full_name: string
  target_branch?: string | null
  scan_mode: 'full' | 'incremental'
  base_sha?: string | null
  head_sha?: string | null
  event_type?: 'manual' | 'scheduled'
  repair_mode?: RepairMode | null
}

export interface SubmittedRepositoryReviewRun {
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target: RepositoryScanTarget
  workflow: string
  event_type: 'manual' | 'scheduled'
}

function assertRepositoryReviewInput (input: RepositoryReviewInput): asserts input is RepositoryReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Repository review input is missing before runner invocation.')
  }
}

async function materializeRepositoryReviewInput ({
  octokit,
  repo_full_name,
  target_branch = null,
  scan_mode,
  base_sha = null,
  head_sha = null,
  event_type = 'manual',
  repair_mode = null
}: RunRepositoryReviewArgs): Promise<{
  run_id: string
  repo: RepositoryContext
  workspace_ref: string
  input: RepositoryReviewInput
}> {
  logInfo('repository_review_workflow_started', {
    event_type,
    branch: target_branch ?? '(default-branch)',
    head_sha: head_sha ?? '(resolve-from-branch)',
    repo: repo_full_name
  })

  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const github = octokit as GitHubAppOctokit
  const pathConfig = await fetchRepositoryTriggerConfig(github, {
    owner_login,
    repo_name,
    ...(target_branch ? { ref: target_branch } : {})
  })

  const prepared = await prepareRepositoryReviewInput({
    octokit: github,
    repo_full_name,
    target_branch,
    scan_mode,
    base_sha,
    head_sha,
    event_type,
    paths_ignore: pathConfig.paths_ignore,
    repair_mode
  })
  const input = prepared.input
  const repo = prepared.repo

  return {
    run_id: prepared.run_id,
    input,
    repo,
    workspace_ref: prepared.workspace_ref
  }
}

export async function startRepositoryReviewRun ({
  octokit,
  repo_full_name,
  target_branch = null,
  scan_mode,
  base_sha = null,
  head_sha = null,
  event_type = 'manual',
  repair_mode = null
}: RunRepositoryReviewArgs): Promise<SubmittedRepositoryReviewRun> {
  const { run_id, input, repo, workspace_ref } = await materializeRepositoryReviewInput({
    octokit,
    repo_full_name,
    target_branch,
    scan_mode,
    base_sha,
    head_sha,
    event_type,
    repair_mode
  })

  assertRepositoryReviewInput(input)
  const submitted = await submitRunnerRun({
    workflow: 'repository-review',
    run_id,
    input
  })

  logInfo('repository_review_runner_run_submitted', {
    event_type,
    repo: repo.repo_full_name,
    run_id: run_id,
    workflow: submitted.workflow
  })

  return {
    repo,
    run_id,
    workspace_ref,
    scan_target: input.scan_target,
    workflow: submitted.workflow,
    event_type
  }
}
