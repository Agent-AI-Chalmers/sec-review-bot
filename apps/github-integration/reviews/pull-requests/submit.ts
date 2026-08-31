import {
  type PullRequestContext,
  listFilesChangedBetweenCommits,
  listPullRequestFiles
} from '../../infrastructure/github/pull-request-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { preparePullRequestReviewInput } from './prepare-input.js'
import { submitRunnerRun } from '../../infrastructure/runner/client.js'
import { logInfo } from '../../utils/logger.js'
import type { PullRequestReviewInput, RepairMode } from '../../infrastructure/runner/input.js'

export interface SubmittedPullRequestReviewRun {
  pr: PullRequestContext
  run_id: string
  files: unknown[]
  workflow: string
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}

function assertPullRequestReviewInput (input: PullRequestReviewInput): asserts input is PullRequestReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Pull request review input is missing before runner invocation.')
  }
}

async function listSynchronizeScopeFiles ({
  octokit,
  pr
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
}) {
  if (pr.previous_head_sha) {
    const incrementalFiles = await listFilesChangedBetweenCommits(octokit, {
      owner_login: pr.owner_login,
      repo_name: pr.repo_name,
      previous_head_sha: pr.previous_head_sha,
      current_head_sha: pr.head_sha
    })

    if (incrementalFiles.length > 0) {
      return incrementalFiles
    }
  }

  return listPullRequestFiles(octokit, {
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    pr_number: pr.pr_number
  })
}

async function resolveEventFiles ({
  octokit,
  pr,
  event_type
}: {
  octokit: GitHubAppOctokit
  pr: PullRequestContext
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}) {
  if (event_type === 'synchronize') {
    return listSynchronizeScopeFiles({ octokit, pr })
  }

  return listPullRequestFiles(octokit, {
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    pr_number: pr.pr_number
  })
}

function describeFetchedFiles (
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review',
  files: Array<unknown>
): string {
  if (event_type === 'synchronize') {
    return `Fetched ${files.length} synchronize-scope changed files. Materializing analysis input...`
  }

  return `Fetched ${files.length} changed files. Materializing analysis input...`
}

async function materializePullRequestReviewInput ({
  octokit,
  pr,
  event_type,
  repair_mode = null
}: {
  octokit: unknown
  pr: PullRequestContext
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  repair_mode?: RepairMode | null
}): Promise<{ run_id: string, input: PullRequestReviewInput, files: unknown[] }> {
  logInfo('pull_request_review_workflow_started', {
    event_type,
    pr: pr.pr_number,
    repo: pr.repo_full_name
  })

  if (event_type === 'synchronize') {
    logInfo('synchronize_scope_completed', {
      current_head_sha: pr.head_sha,
      event_type,
      pr: pr.pr_number,
      previous_head_sha: pr.previous_head_sha ?? '(missing)'
    })
  } else {
    logInfo('pull_request_review_files_fetch_started', {
      event_type,
      pr: pr.pr_number,
      repo: pr.repo_full_name
    })
  }

  const files = await resolveEventFiles({
    octokit: octokit as GitHubAppOctokit,
    pr,
    event_type
  })

  logInfo('pull_request_review_files_fetch_completed', {
    event_type,
    file_count: files.length,
    mode: event_type === 'synchronize' ? 'synchronize_scope_completed' : 'pull_request_scope',
    note: describeFetchedFiles(event_type, files),
    pr: pr.pr_number
  })

  const prepared = await preparePullRequestReviewInput({
    octokit: octokit as GitHubAppOctokit,
    pr,
    files,
    repair_mode
  })
  const analysisInput = prepared?.input ?? null
  const reviewFiles = prepared?.files ?? files

  if (!analysisInput || typeof analysisInput !== 'object' || Array.isArray(analysisInput)) {
    throw new Error(`Pull request input materialization returned an invalid value for PR #${pr.pr_number}.`)
  }

  logInfo('pull_request_review_input_completed', {
    event_type,
    pr: pr.pr_number,
    repo: pr.repo_full_name,
    run_id: prepared.run_id
  })

  if (event_type === 'synchronize') {
    logInfo('pull_request_review_workspace_materialization_completed', {
      event_type,
      mode: 'synchronize_scoped_diffs',
      pr: pr.pr_number
    })
  }

  return {
    run_id: prepared.run_id,
    input: analysisInput,
    files: reviewFiles
  }
}

export async function startPullRequestReviewRun (args: {
  octokit: unknown
  pr: PullRequestContext
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  repair_mode?: RepairMode | null
}): Promise<SubmittedPullRequestReviewRun> {
  const prepared = await materializePullRequestReviewInput(args)
  assertPullRequestReviewInput(prepared.input)
  const submitted = await submitRunnerRun({
    workflow: 'pull-request-review',
    run_id: prepared.run_id,
    input: prepared.input
  })
  logInfo('pull_request_review_runner_run_submitted', {
    event_type: args.event_type,
    pr: args.pr.pr_number,
    repo: args.pr.repo_full_name,
    run_id: prepared.run_id,
    workflow: submitted.workflow
  })
  return {
    pr: args.pr,
    run_id: prepared.run_id,
    files: prepared.files,
    workflow: submitted.workflow,
    event_type: args.event_type
  }
}
