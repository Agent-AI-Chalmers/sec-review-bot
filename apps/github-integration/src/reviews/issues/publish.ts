import {
  EXECUTION_API_VERSION,
  type ExecutionApiVersion
} from '../../execution/execution-api-version.js'
import {
  createIssueCommentUnlessMarkerExists,
  findIssueCommentByMarker
} from '../../github/comment-service.js'
import type { PersistedIssue } from '../../review-runs/publish-context.js'
import type { Octokit } from 'octokit'
import {
  buildDraftBranchName,
  createDraftPullRequestFromIssueReviewRecord
} from './draft-pr.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../execution/publish-error-code.js'
import { DeterministicExecutionPublishError } from '../../execution/publish-error.js'
import { parseIssueReviewPublishContext } from '../../review-runs/publish-context.js'
import {
  buildSuggestedDraftPrPlanFromReviewRecord,
  renderIssueReviewCommentFromReviewRecord
} from './renderer.js'
import { logInfo } from '../../utils/logger.js'
import { asErrorMessage } from '../../utils/error-utils.js'
import { findOpenPullRequestByHeadBranch } from '../shared/settle-exhausted-step.js'
import { runPublicationStep } from '../shared/publication-step.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { assertWorkflowResult } from '../../execution/execution-api-schema.js'
import type { PublicationStepStore } from '../../review-runs/client.js'

interface IssueDraftPullRequest {
  number: number
  html_url: string
}

function issueReviewRunMarker(run_id: string): string {
  // The publisher may retry after GitHub accepted a comment but its response was lost.
  // A stable run marker makes that retry observable and idempotent.
  return `<!-- sec-review-bot:issue-review-run:${run_id} -->`
}

export interface IssueReviewWorkflowResult {
  api_version: ExecutionApiVersion
  review_record: ReviewRecord
  [key: string]: unknown
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<Octokit>
type CompletedExecutionRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function issueReviewResultFromWorkflowResult(
  result: unknown
): IssueReviewWorkflowResult | null {
  try {
    assertWorkflowResult('issue-review', result)
    const rawResult = result as {
      api_version: ExecutionApiVersion
      review_record: unknown
    }
    return {
      api_version: EXECUTION_API_VERSION,
      review_record: parseReviewRecord(rawResult.review_record)
    }
  } catch (error) {
    // The completed execution payload is already persisted; polling it again will
    // return the same invalid contract result.
    throw new DeterministicExecutionPublishError(
      `Issue review result is invalid: ${asErrorMessage(error)}`,
      EXECUTION_PUBLISH_ERROR_CODES.issue_result_invalid,
      { cause: error }
    )
  }
}

export async function handleIssueReviewRun({
  run,
  result,
  store,
  claim_token,
  assert_publication_claim,
  installation_octokit_for_repo
}: {
  run: CompletedExecutionRun
  result: unknown
  store: PublicationStepStore
  claim_token: string
  assert_publication_claim: () => Promise<void>
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parseIssueReviewPublishContext(run.publish_context)
  const workflow_result = issueReviewResultFromWorkflowResult(result)
  if (workflow_result === null) {
    throw new Error(`Issue review run ${run.run_id} is not ready to publish.`)
  }
  const octokit = await installation_octokit_for_repo(
    context.issue.repo_full_name
  )
  await publishIssueReviewResult({
    octokit,
    issue: context.issue,
    run_id: run.run_id,
    workspace_ref: context.workspace_ref,
    workflow_result,
    event_type: context.event_type,
    open_pr: context.open_pr,
    store,
    claim_token,
    assert_publication_claim
  })
}

async function publishIssueReviewResult({
  octokit,
  issue,
  run_id,
  workspace_ref,
  workflow_result,
  event_type,
  open_pr,
  store,
  claim_token,
  assert_publication_claim
}: {
  octokit: Octokit
  issue: PersistedIssue
  run_id: string
  workspace_ref: string
  workflow_result: IssueReviewWorkflowResult
  event_type: 'opened' | 'manual_review'
  open_pr: boolean
  store: PublicationStepStore
  claim_token: string
  assert_publication_claim: () => Promise<void>
}): Promise<void> {
  let draftPullRequest: IssueDraftPullRequest | null = null
  const github = octokit

  const review_record = workflow_result.review_record

  const draftPrPlan = review_record
    ? await buildSuggestedDraftPrPlanFromReviewRecord({
        issue,
        review_record
      })
    : null

  // A ready patch is necessary but not sufficient: the run must also have opted in to
  // opening a PR. Without the flag the patch stays in the summary comment only.
  const should_open_pr = draftPrPlan?.patch_ready === true && open_pr

  await store.initializePublicationSteps(run_id, claim_token, [
    ...(should_open_pr ? ['issue:draft-pr'] : []),
    'issue:summary-comment'
  ])

  if (should_open_pr) {
    logInfo('draft_pr_creation_started', {
      event_type,
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })
    // The same name the creation path builds. Deriving it differently here - as a shorter run
    // segment, say - would look for this step's side effect under a branch it never created.
    const branch = buildDraftBranchName(issue, run_id)
    const draftPrStep = await runPublicationStep({
      store,
      runId: run_id,
      token: claim_token,
      stepKey: 'issue:draft-pr',
      assertClaim: assert_publication_claim,
      find: async () => {
        const existing = await findOpenPullRequestByHeadBranch(github, {
          owner_login: issue.owner_login,
          repo_name: issue.repo_name,
          branch_name: branch
        })
        return existing === null
          ? null
          : { id: existing.number, url: existing.html_url }
      },
      effect: async () => {
        // The creation path is idempotent on its own: the branch is run-specific and an
        // existing branch is verified, then reused.
        const created = await createDraftPullRequestFromIssueReviewRecord({
          octokit: github,
          issue,
          run_id,
          workspace_ref,
          review_record,
          assert_publication_claim
        })
        return created === null
          ? null
          : { id: created.number, url: created.html_url }
      }
    })
    // A step that was already claimed once may have created the pull request before its
    // publisher died, so this run is a retry rather than a first attempt. Recording the fact
    // keeps the log honest about why it may be recovering.
    if (draftPrStep.previousAttempts > 1 && !draftPrStep.alreadySucceeded)
      logInfo('draft_pr_creation_retry', {
        event_type,
        issue: issue.issue_number,
        repo: issue.repo_full_name,
        previous_attempts: draftPrStep.previousAttempts
      })
    if (draftPrStep.remote.id !== undefined && draftPrStep.remote.id !== null) {
      draftPullRequest = {
        number: Number(draftPrStep.remote.id),
        html_url: draftPrStep.remote.url ?? ''
      }
    }
    if (draftPrStep.reconciled && draftPullRequest !== null)
      logInfo('draft_pr_creation_reconciled', {
        event_type,
        issue: issue.issue_number,
        repo: issue.repo_full_name,
        draft_pr_number: draftPullRequest.number
      })
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

  // Exhaustion is not a verdict: the last attempt may have posted the comment and lost its
  // response, so the marker is looked for before the step is allowed to be a failure.
  let reused = false
  const commentStep = await runPublicationStep({
    store,
    runId: run_id,
    token: claim_token,
    stepKey: 'issue:summary-comment',
    assertClaim: assert_publication_claim,
    find: async () => {
      const found = await findIssueCommentByMarker(github, {
        owner_login: issue.owner_login,
        repo_name: issue.repo_name,
        issue_number: issue.issue_number,
        marker
      })
      return found === null ? null : { id: found.id, url: found.html_url }
    },
    effect: async () => {
      const comment = await createIssueCommentUnlessMarkerExists(github, {
        owner_login: issue.owner_login,
        repo_name: issue.repo_name,
        issue_number: issue.issue_number,
        body: commentBody,
        marker,
        assert_publication_claim
      })
      reused = comment.reused
      return { id: comment.id, url: comment.html_url }
    }
  })
  // The comment already existed: nothing left to publish for this step.
  if (commentStep.alreadySucceeded) return

  logInfo('issue_comment_publish_completed', {
    comment_id: commentStep.remote.id,
    comment_url: commentStep.remote.url,
    event_type,
    issue: issue.issue_number,
    reused
  })
}
