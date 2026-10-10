import { createIssueCommentUnlessMarkerExists } from '../../github/comment-service.js'
import type { PersistedIssue } from '../../control-plane/publish-context.js'
import type { GitHubAppOctokit } from '../../github/octokit.js'
import { createDraftPullRequestFromIssueReviewRecord } from './draft-pr.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../runner/publish-error.js'
import { parseIssueReviewPublishContext } from '../../control-plane/publish-context.js'
import {
  buildSuggestedDraftPrPlanFromReviewRecord,
  renderIssueReviewCommentFromReviewRecord
} from './renderer.js'
import { logInfo } from '../../utils/logger.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { assertV5WorkflowResult } from '../../runner/contract-schema.js'
import type { ControlPlaneClient } from '../../control-plane/client.js'
import { classifyPublicationFailure } from '../../control-plane/publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from '../../control-plane/publication-claim.js'

interface IssueDraftPullRequest {
  number: number
  html_url: string
}

interface IssueReviewComment {
  id: number
  html_url: string
  reused: boolean
}

function issueReviewRunMarker(run_id: string): string {
  // The publisher may retry after GitHub accepted a comment but its response was lost.
  // A stable run marker makes that retry observable and idempotent.
  return `<!-- sec-review-bot:issue-review-run:${run_id} -->`
}

export interface IssueReviewWorkflowResult {
  contract_version: 'v5'
  review_record: ReviewRecord
  [key: string]: unknown
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<unknown>
type CompletedRunnerRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function issueReviewResultFromWorkflowResult(result: unknown): IssueReviewWorkflowResult | null {
  try {
    assertV5WorkflowResult('issue-review', result)
    const rawResult = result as { contract_version: 'v5'; review_record: unknown }
    return {
      contract_version: 'v5',
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

export async function handleIssueReviewRun({
  run,
  result,
  store,
  claim_token,
  assert_publication_claim,
  installation_octokit_for_repo
}: {
  run: CompletedRunnerRun
  result: unknown
  store: ControlPlaneClient
  claim_token: string
  assert_publication_claim: () => Promise<void>
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parseIssueReviewPublishContext(run.publish_context)
  const workflow_result = issueReviewResultFromWorkflowResult(result)
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
    event_type: context.event_type,
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
  store,
  claim_token,
  assert_publication_claim
}: {
  octokit: unknown
  issue: PersistedIssue
  run_id: string
  workspace_ref: string
  workflow_result: IssueReviewWorkflowResult
  event_type: 'opened' | 'manual_review'
  store: ControlPlaneClient
  claim_token: string
  assert_publication_claim: () => Promise<void>
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

  await store.initializePublicationSteps(run_id, claim_token, [
    ...(draftPrPlan?.patch_ready ? ['issue:draft-pr'] : []),
    'issue:summary-comment'
  ])

  if (draftPrPlan?.patch_ready) {
    logInfo('draft_pr_creation_started', {
      event_type,
      issue: issue.issue_number,
      repo: issue.repo_full_name
    })
    const step = (await store.listPublicationSteps(run_id)).find(
      (item) => item.step_key === 'issue:draft-pr'
    )
    if (step?.status === 'succeeded' && step.remote_object_id && step.remote_object_url) {
      draftPullRequest = { number: Number(step.remote_object_id), html_url: step.remote_object_url }
    } else {
      await store.requirePublicationStepClaim(run_id, claim_token, 'issue:draft-pr')
      try {
        // A lease is permission to start a side effect, not merely permission
        // to record it afterward. If ownership cannot be proved, fail closed.
        await assert_publication_claim()
        draftPullRequest = (await createDraftPullRequestFromIssueReviewRecord({
          octokit: github,
          issue,
          run_id,
          workspace_ref,
          review_record,
          assert_publication_claim
        })) as IssueDraftPullRequest | null
        const remote =
          draftPullRequest === null
            ? {}
            : { id: draftPullRequest.number, url: draftPullRequest.html_url }
        if (!(await store.completePublicationStep(run_id, claim_token, 'issue:draft-pr', remote)))
          throw new PublicationClaimLostError(run_id)
      } catch (error) {
        if (isPublicationClaimLostError(error)) throw error
        const failure = classifyPublicationFailure(error)
        await store.failPublicationStep(
          run_id,
          claim_token,
          'issue:draft-pr',
          {
            code: failure.code,
            message: asErrorMessage(error)
          },
          { retry: failure.retry }
        )
        throw error
      }
    }
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

  const commentStep = (await store.listPublicationSteps(run_id)).find(
    (item) => item.step_key === 'issue:summary-comment'
  )
  if (commentStep?.status === 'succeeded') return
  await store.requirePublicationStepClaim(run_id, claim_token, 'issue:summary-comment')
  let comment: IssueReviewComment
  try {
    await assert_publication_claim()
    comment = (await createIssueCommentUnlessMarkerExists(github, {
      owner_login: issue.owner_login,
      repo_name: issue.repo_name,
      issue_number: issue.issue_number,
      body: commentBody,
      marker,
      assert_publication_claim
    })) as IssueReviewComment
    if (
      !(await store.completePublicationStep(run_id, claim_token, 'issue:summary-comment', {
        id: comment.id,
        url: comment.html_url
      }))
    )
      throw new PublicationClaimLostError(run_id)
  } catch (error) {
    if (isPublicationClaimLostError(error)) throw error
    const failure = classifyPublicationFailure(error)
    await store.failPublicationStep(
      run_id,
      claim_token,
      'issue:summary-comment',
      {
        code: failure.code,
        message: asErrorMessage(error)
      },
      { retry: failure.retry }
    )
    throw error
  }

  logInfo('issue_comment_publish_completed', {
    comment_id: comment.id,
    comment_url: comment.html_url,
    event_type,
    issue: issue.issue_number,
    reused: comment.reused
  })
}
