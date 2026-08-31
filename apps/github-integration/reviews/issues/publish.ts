import { createIssueComment } from '../../infrastructure/github/comment-service.js'
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
import { logError, logInfo } from '../../utils/logger.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { isRecord } from '../view-utils.js'

interface IssueDraftPullRequest {
  number: number
  html_url: string
}

interface IssueReviewComment {
  id: number
  html_url: string
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
    if (!isRecord(completed.result)) {
      throw new Error('result must be an object.')
    }
    const rawResult = completed.result
    if (rawResult.contract_version !== 'v4') {
      throw new Error('contract_version must be v4.')
    }
    return {
      ...rawResult,
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
    try {
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
    } catch (error) {
      logError('draft_pr_creation_failed', {
        error,
        error_message: asErrorMessage(error),
        event_type,
        issue: issue.issue_number,
        repo: issue.repo_full_name
      })
    }
  }

  const commentBody = renderIssueReviewCommentFromReviewRecord({
    issue,
    review_record,
    draftPrPlan,
    draftPullRequest
  })

  logInfo('issue_comment_publish_started', {
    event_type,
    issue: issue.issue_number,
    repo: issue.repo_full_name
  })

  const comment = await createIssueComment(github, {
    owner_login: issue.owner_login,
    repo_name: issue.repo_name,
    issue_number: issue.issue_number,
    body: commentBody
  }) as IssueReviewComment

  logInfo('issue_comment_publish_completed', {
    comment_id: comment.id,
    comment_url: comment.html_url,
    event_type,
    issue: issue.issue_number
  })

}
