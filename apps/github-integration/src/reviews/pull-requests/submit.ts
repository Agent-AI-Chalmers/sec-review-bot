import {
  type PullRequestContext,
  listFilesChangedBetweenCommits,
  listPullRequestFiles
} from '../../github/pull-request-service.js'
import { resolveReviewWindowFiles, type ReviewWindow } from './review-window.js'
import type { Octokit } from 'octokit'
import type { TrustedDefaultBranch } from '../../github/default-branch-service.js'
import { preparePullRequestReviewInput } from './prepare-input.js'
import { logInfo } from '../../utils/logger.js'
import type {
  PullRequestReviewInput,
  TestChangesPolicy
} from '../../runner/input.js'

export interface SubmittedPullRequestReviewRun {
  pr: PullRequestContext
  run_id: string
  files: unknown[]
  workflow: string
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}

function assertPullRequestReviewInput(
  input: PullRequestReviewInput
): asserts input is PullRequestReviewInput & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'Pull request review input is missing before runner invocation.'
    )
  }
}

async function resolveEventWindow({
  octokit,
  pr,
  event_type
}: {
  octokit: Octokit
  pr: PullRequestContext
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}): Promise<{
  window: ReviewWindow
  files: Awaited<ReturnType<typeof listPullRequestFiles>>
}> {
  const resolved = await resolveReviewWindowFiles({
    pr,
    event_type,
    list_push_window_files: (base_sha) =>
      listFilesChangedBetweenCommits(octokit, {
        owner_login: pr.owner_login,
        repo_name: pr.repo_name,
        previous_head_sha: base_sha,
        current_head_sha: pr.head_sha
      }),
    list_full_window_files: () =>
      listPullRequestFiles(octokit, {
        owner_login: pr.owner_login,
        repo_name: pr.repo_name,
        pr_number: pr.pr_number
      })
  })
  return resolved
}

function describeFetchedFiles(
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review',
  files: Array<unknown>
): string {
  if (event_type === 'synchronize') {
    return `Fetched ${files.length} synchronize-scope changed files. Materializing analysis input...`
  }

  return `Fetched ${files.length} changed files. Materializing analysis input...`
}

async function materializePullRequestReviewInput({
  run_id,
  octokit,
  pr,
  trusted_default_branch,
  event_type,
  test_changes = null
}: {
  run_id: string
  octokit: Octokit
  pr: PullRequestContext
  trusted_default_branch: TrustedDefaultBranch
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  test_changes?: TestChangesPolicy | null
}): Promise<{
  run_id: string
  input: PullRequestReviewInput
  files: unknown[]
}> {
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

  const { window, files } = await resolveEventWindow({
    octokit,
    pr,
    event_type
  })

  logInfo('pull_request_review_window_resolved', {
    event_type,
    file_count: files.length,
    pr: pr.pr_number,
    window_base_sha: window.base_sha,
    window_head_sha: window.head_sha,
    window_kind: window.kind,
    window_reason: window.reason
  })

  logInfo('pull_request_review_files_fetch_completed', {
    event_type,
    file_count: files.length,
    mode:
      event_type === 'synchronize'
        ? 'synchronize_scope_completed'
        : 'pull_request_scope',
    note: describeFetchedFiles(event_type, files),
    pr: pr.pr_number
  })

  const prepared = await preparePullRequestReviewInput({
    run_id,
    octokit,
    trusted_default_branch,
    pr,
    files,
    window,
    test_changes
  })
  const analysisInput = prepared?.input ?? null
  const reviewFiles = prepared?.files ?? files

  if (
    !analysisInput ||
    typeof analysisInput !== 'object' ||
    Array.isArray(analysisInput)
  ) {
    throw new Error(
      `Pull request input materialization returned an invalid value for PR #${pr.pr_number}.`
    )
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

export async function startPullRequestReviewRun(args: {
  run_id: string
  octokit: Octokit
  pr: PullRequestContext
  trusted_default_branch: TrustedDefaultBranch
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  test_changes?: TestChangesPolicy | null
  // The caller hands the prepared input to Control Plane for durable submission.
  on_prepared?: (
    submitted: SubmittedPullRequestReviewRun,
    input: PullRequestReviewInput & Record<string, unknown>
  ) => void | Promise<void>
}): Promise<SubmittedPullRequestReviewRun> {
  const prepared = await materializePullRequestReviewInput(args)
  assertPullRequestReviewInput(prepared.input)
  const preparedRun: SubmittedPullRequestReviewRun = {
    pr: args.pr,
    run_id: prepared.run_id,
    files: prepared.files,
    workflow: 'pull-request-review',
    event_type: args.event_type
  }
  if (args.on_prepared === undefined)
    throw new Error('Pull request review submission callback is required.')
  await args.on_prepared(preparedRun, prepared.input)
  logInfo('pull_request_review_runner_run_submitted', {
    event_type: args.event_type,
    pr: args.pr.pr_number,
    repo: args.pr.repo_full_name,
    run_id: prepared.run_id,
    workflow: preparedRun.workflow
  })
  return preparedRun
}
