import {
  CONTRACT_VERSION,
  type ContractVersion
} from '../../execution/contract-version.js'
import {
  createIssueCommentUnlessMarkerExists,
  findIssueCommentByMarker
} from '../../github/comment-service.js'
import type { PersistedIssue } from '../../control-plane/publish-context.js'
import type { Octokit } from 'octokit'
import {
  buildDraftBranchName,
  createDraftPullRequestFromIssueReviewRecord
} from './draft-pr.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../execution/publish-error-code.js'
import { DeterministicExecutionPublishError } from '../../execution/publish-error.js'
import { parseIssueReviewPublishContext } from '../../control-plane/publish-context.js'
import {
  buildSuggestedDraftPrPlanFromReviewRecord,
  renderIssueReviewCommentFromReviewRecord
} from './renderer.js'
import { logInfo } from '../../utils/logger.js'
import { asErrorMessage } from '../../utils/error-utils.js'
import {
  findOpenPullRequestByHeadBranch,
  isPublicationStepExhausted,
  settleExhaustedStep
} from '../shared/settle-exhausted-step.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { assertWorkflowResult } from '../../execution/contract-schema.js'
import type { PublicationStepStore } from '../../control-plane/client.js'
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
  contract_version: ContractVersion
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
      contract_version: ContractVersion
      review_record: unknown
    }
    return {
      contract_version: CONTRACT_VERSION,
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
  // Set when reconciliation concluded this step from the remote system instead of creating it.
  let stepSettledExternally = false
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
    const step = (await store.listPublicationSteps(run_id)).find(
      (item) => item.step_key === 'issue:draft-pr'
    )
    if (
      step?.status === 'succeeded' &&
      step.remote_object_id &&
      step.remote_object_url
    ) {
      draftPullRequest = {
        number: Number(step.remote_object_id),
        html_url: step.remote_object_url
      }
    } else {
      // A step that was already claimed once may have created the pull request before its
      // publisher died: `attempt_count > 1` means a previous owner started this side effect, so
      // this run is a retry, not a first attempt. The creation path is idempotent on its own
      // (the branch is run-specific and an existing branch is verified, then reused), but
      // recording the fact keeps the log honest about why it may be recovering.
      if (step !== undefined && step.attempt_count > 1) {
        logInfo('draft_pr_creation_retry', {
          event_type,
          issue: issue.issue_number,
          repo: issue.repo_full_name,
          previous_attempts: step.attempt_count
        })
      }
      try {
        await store.requirePublicationStepClaim(
          run_id,
          claim_token,
          'issue:draft-pr'
        )
      } catch (error) {
        // No attempts left. The publisher that started this step may already have created the
        // draft PR; concluding it as failed without looking would report an existing PR as
        // missing. The head branch is run-specific, so an open PR from it is this step's effect.
        if (!isPublicationStepExhausted(error)) throw error
        // The same name the creation path builds. Deriving it differently here - as a shorter
        // run segment, say - would look for this step's side effect under a branch it never
        // created.
        const branch = buildDraftBranchName(issue, run_id)
        const settled = await settleExhaustedStep({
          store,
          runId: run_id,
          token: claim_token,
          stepKey: 'issue:draft-pr',
          find: async () => {
            const existing = await findOpenPullRequestByHeadBranch(github, {
              owner_login: issue.owner_login,
              repo_name: issue.repo_name,
              branch_name: branch
            })
            return existing === null
              ? null
              : { id: existing.number, url: existing.html_url }
          }
        })
        // Only a recorded success lets this caller continue. A confirmed absence is already a
        // conclusion on the step, and a refusal means another owner owns it; neither leaves
        // anything for this caller to do but report the exhaustion it was given.
        if (settled.outcome !== 'recorded' || settled.step !== 'succeeded')
          throw error
        stepSettledExternally = true
        draftPullRequest = {
          number: Number(settled.remote.id),
          html_url: settled.remote.url ?? ''
        } as IssueDraftPullRequest
        logInfo('draft_pr_creation_reconciled', {
          event_type,
          issue: issue.issue_number,
          repo: issue.repo_full_name,
          draft_pr_number: draftPullRequest.number
        })
      }
      // The step is already settled when the reconciliation above found what a previous owner
      // created: it must not create anything again. `draftPullRequest` alone cannot say this,
      // because `null` is also the legitimate outcome of a creation that needed no PR.
      if (!stepSettledExternally) {
        try {
          // A lease is permission to start a side effect, not merely permission
          // to record it afterward. If ownership cannot be proved, fail closed.
          await assert_publication_claim()
          draftPullRequest = (await createDraftPullRequestFromIssueReviewRecord(
            {
              octokit: github,
              issue,
              run_id,
              workspace_ref,
              review_record,
              assert_publication_claim
            }
          )) as IssueDraftPullRequest | null
          const remote =
            draftPullRequest === null
              ? {}
              : { id: draftPullRequest.number, url: draftPullRequest.html_url }
          if (
            !(await store.completePublicationStep(
              run_id,
              claim_token,
              'issue:draft-pr',
              remote
            ))
          )
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
  try {
    await store.requirePublicationStepClaim(
      run_id,
      claim_token,
      'issue:summary-comment'
    )
  } catch (error) {
    // Exhaustion is not a verdict: the last attempt may have posted the comment and lost its
    // response. Look for this run's marker before letting the step be a failure.
    if (!isPublicationStepExhausted(error)) throw error
    const settled = await settleExhaustedStep({
      store,
      runId: run_id,
      token: claim_token,
      stepKey: 'issue:summary-comment',
      find: async () =>
        await findIssueCommentByMarker(github, {
          owner_login: issue.owner_login,
          repo_name: issue.repo_name,
          issue_number: issue.issue_number,
          marker
        }).then((found) =>
          found === null ? null : { id: found.id, url: found.html_url }
        )
    })
    // The comment already existed: nothing left to publish for this step.
    // The step is already recorded as succeeded, so there is nothing left to publish for it.
    if (settled.outcome === 'recorded' && settled.step === 'succeeded') return
    throw error
  }
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
      !(await store.completePublicationStep(
        run_id,
        claim_token,
        'issue:summary-comment',
        {
          id: comment.id,
          url: comment.html_url
        }
      ))
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
