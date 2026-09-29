import { createIssueCommentUnlessMarkerExists } from '../../infrastructure/github/comment-service.js'
import type { IssueContext } from '../../infrastructure/github/issue-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { createDraftPullRequestFromIssueReviewRecord } from './draft-pr.js'
import { completedRunnerRunResult, type RunnerRunStatus } from '../../infrastructure/runner/client.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../infrastructure/runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../infrastructure/runner/publish-error.js'
import { parseIssueReviewPublishContext } from '../../infrastructure/runner/publish-context.js'
import {
  buildSuggestedDraftPrPlanFromReviewRecord,
  renderIssueReviewCommentFromReviewRecord
} from './renderer.js'
import { logInfo } from '../../utils/logger.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { assertV4WorkflowResult } from '../../infrastructure/runner/result-schema.js'

interface IssueDraftPullRequest {
  number: number
  html_url: string
}

interface IssueReviewComment {
  id: number
  html_url: string
  reused: boolean
}

function issueReviewRunMarker (run_id: string): string {
  // The publisher may retry after GitHub accepted a comment but its response was lost.
  // A stable run marker makes that retry observable and idempotent.
  return `<!-- sec-review-bot:issue-review-run:${run_id} -->`
}

export interface IssueReviewWorkflowResult {
  contract_version: 'v4'
  review_record: ReviewRecord
  [key: string]: unknown
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<unknown>
type CompletedRunnerRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function asErrorMessage (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function issueReviewResultFromRunStatus (status: RunnerRunStatus): IssueReviewWorkflowResult | null {
  const completed = completedRunnerRunResult(status)
  if (completed === null) {
    return null
  }
  try {
    assertV4WorkflowResult('issue-review', completed.result)
    const rawResult = completed.result as { contract_version: 'v4', review_record: unknown }
    return {
      contract_version: 'v4',
      review_record: parseReviewRecord(rawResult.review_record)
    }
  } catch (error) {
    // The completed runner payload is already persisted; polling it again will
    // return the same invalid contract result.
    throw new DeterministicRunnerPublishError(
      `Issue review result is invalid: ${asErrorMessage(error)}`,
      RUNNER_PUBLISH_ERROR_CODES.issue_result_invalid,
      { cause: error }
    )
  }
}

export async function handleIssueReviewRun ({
  run,
  status,
  installation_octokit_for_repo
}: {
  run: CompletedRunnerRun
  status: RunnerRunStatus
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parseIssueReviewPublishContext(run.publish_context)
  const workflow_result = issueReviewResultFromRunStatus(status)
  if (workflow_result === null) {
    throw new Error(`Issue review run ${run.run_id} is not ready to publish.`)
  }
  const octokit = await installation_octokit_for_repo(context.issue.repo_full_name)
  await publishIssueReviewResult({
    octokit,
    issue: context.issue,
    run_id: run.run_id,
    workspace_ref: context.workspace_ref,
    workflow_result,
    event_type: context.event_type
  })
}

async function publishIssueReviewResult ({
  octokit,
  issue,
  run_id,
  workspace_ref,
  workflow_result,
  event_type
}: {
  octokit: unknown
  issue: IssueContext
  run_id: string
  workspace_ref: string
  workflow_result: IssueReviewWorkflowResult
  event_type: 'opened' | 'manual_review'
}): Promise<void> {
  let draftPullRequest: IssueDraftPullRequest | null = null
  const github = octokit as GitHubAppOctokit

  const review_record = workflow_result.review_record

  const draftPrPlan = review_record
    ? await buildSuggestedDraftPrPlanFromReviewRecord({
        issue,
        review_record
      })
    : null

  if (draftPrPlan?.patch_ready) {
    logInfo('draft_pr_creation_started', {
      event_type,
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })
    draftPullRequest = await createDraftPullRequestFromIssueReviewRecord({
      octokit: github,
      issue,
      run_id,
      workspace_ref,
      review_record
    }) as IssueDraftPullRequest | null
    if (draftPullRequest) {
      logInfo('draft_pr_creation_completed', {
        draft_pr_number: draftPullRequest.number,
        draft_pr_url: draftPullRequest.html_url,
        event_type,
        issue: issue.issue_number
      })
    }
  }

  const marker = issueReviewRunMarker(run_id)
  const commentBody = [
    marker,
    renderIssueReviewCommentFromReviewRecord({
      issue,
      review_record,
      draftPrPlan,
      draftPullRequest
    })
  ].join('\n\n')

  logInfo('issue_comment_publish_started', {
    event_type,
    issue: issue.issue_number,
    repo: issue.repo_full_name
  })

  const comment = await createIssueCommentUnlessMarkerExists(github, {
    owner_login: issue.owner_login,
    repo_name: issue.repo_name,
    issue_number: issue.issue_number,
    body: commentBody,
    marker
  }) as IssueReviewComment

  logInfo('issue_comment_publish_completed', {
    comment_id: comment.id,
    comment_url: comment.html_url,
    event_type,
    issue: issue.issue_number,
    reused: comment.reused
  })

}
