import { createIssueCommentUnlessMarkerExists } from '../../github/comment-service.js'
import { findRepositorySecuritySummaryIssue } from '../../github/repository-service.js'
import type { GitHubAppOctokit } from '../../github/octokit.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../runner/publish-error-code.js'
import type { ControlPlaneClient } from '../../control-plane/client.js'
import { classifyPublicationFailure } from '../../control-plane/publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from '../../control-plane/publication-claim.js'
import { DeterministicRunnerPublishError } from '../../runner/publish-error.js'
import { parseRepositoryReviewPublishContext } from '../../control-plane/publish-context.js'
import { createRepositoryDeliveryDraftPr } from './delivery-draft-pr.js'
import { buildDeliveryDraftPrTitle } from './delivery-title.js'
import {
  buildRepositorySummaryWorkflowView,
  buildRepoReviewSummaryBody,
  renderRepositorySecuritySummaryComment,
  REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE
} from './renderer.js'
import { logError, logInfo } from '../../utils/logger.js'
import {
  parseRepositoryWorkflowResult,
  type RepositoryCaseResult,
  type RepositoryDelivery,
  type RepositoryWorkflowResult
} from './result.js'
import type { RepositoryContext } from './submit.js'
import type { PersistedRepositoryScanTarget } from '../../control-plane/publish-context.js'
import { asList, isRecord, nonEmptyText, optionalNumber, type AnyRecord } from '../view-utils.js'

interface PublishedDeliveryEntry {
  // Publish-time view for the summary renderer. It is not an agent result:
  // title/html_url only exist after the draft PR publish step.
  delivery_id: string
  case_count: number
  cvss_outcome: string | null
  cvss_base_score: number | null
  cvss_severity: string | null
  title: string
  html_url: string
  file_changes: unknown[]
}

interface DraftPullRequestSummary {
  title: string
  html_url: string
  number: number
  reused: boolean
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<unknown>
type CompletedRunnerRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function repositorySummaryRunMarker(run_id: string): string {
  return `<!-- sec-review-bot:repository-summary-run:${run_id} -->`
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function repositoryResultFromWorkflowResult(result: unknown): RepositoryWorkflowResult | null {
  try {
    return parseRepositoryWorkflowResult(result)
  } catch (error) {
    // The completed runner payload is already persisted; polling it again will
    // return the same invalid contract result.
    throw new DeterministicRunnerPublishError(
      `Repository review result is invalid: ${asErrorMessage(error)}`,
      RUNNER_PUBLISH_ERROR_CODES.repository_result_invalid,
      { cause: error }
    )
  }
}

function deliveryCvssFieldsFromCases(
  delivery: RepositoryDelivery,
  case_results: RepositoryCaseResult[]
): {
  case_count: number
  cvss_outcome: string | null
  cvss_base_score: number | null
  cvss_severity: string | null
} {
  const case_ids = new Set(
    asList(delivery.case_ids)
      .map(nonEmptyText)
      .filter((item) => item.length > 0)
  )
  const matchedCases = asList<AnyRecord>(case_results).filter((item) =>
    case_ids.has(nonEmptyText(item.case_id))
  )
  const case_count = optionalNumber(delivery.case_count) ?? case_ids.size
  let best_score: number | null = null
  let best_severity: string | null = null
  let first_non_scored_outcome: string | null = null
  let notScoredCount = 0
  let cvssCount = 0

  for (const item of matchedCases) {
    const review_record = isRecord(item.review_record) ? item.review_record : {}
    const cvss = isRecord(review_record.cvss) ? review_record.cvss : {}
    if (Object.keys(cvss).length === 0) {
      continue
    }
    cvssCount += 1

    const outcome = nonEmptyText(cvss.outcome)
    if (outcome === 'not-scored') {
      notScoredCount += 1
    } else if (outcome && outcome !== 'scored' && !first_non_scored_outcome) {
      first_non_scored_outcome = outcome
    }

    const score = optionalNumber(cvss.base_score)
    if (score == null) {
      continue
    }
    if (best_score == null || score > best_score) {
      best_score = score
      best_severity = nonEmptyText(cvss.severity) || null
    }
  }

  if (best_score != null) {
    return {
      case_count,
      cvss_outcome: 'scored',
      cvss_base_score: best_score,
      cvss_severity: best_severity
    }
  }

  return {
    case_count,
    cvss_outcome:
      cvssCount > 0 && notScoredCount === cvssCount ? 'not-scored' : first_non_scored_outcome,
    cvss_base_score: null,
    cvss_severity: null
  }
}

export async function publishDeliveryDraftPrs({
  octokit,
  repo,
  run_id,
  workspace_ref,
  scan_target,
  deliveries,
  case_results,
  event_type,
  store,
  claim_token,
  assert_publication_claim,
  create_delivery_draft_pr = createRepositoryDeliveryDraftPr
}: {
  octokit: GitHubAppOctokit
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target?: PersistedRepositoryScanTarget
  deliveries: RepositoryDelivery[]
  case_results: RepositoryCaseResult[]
  event_type: 'manual' | 'scheduled'
  store: ControlPlaneClient
  claim_token: string
  assert_publication_claim: () => Promise<void>
  create_delivery_draft_pr?: typeof createRepositoryDeliveryDraftPr
}): Promise<PublishedDeliveryEntry[]> {
  const published_delivery_entries: PublishedDeliveryEntry[] = []
  const resolvedWorkspaceRef = String(workspace_ref ?? '').trim()
  if (!resolvedWorkspaceRef) {
    throw new Error(
      'Repository publish context is missing workspace_ref before delivery branch creation.'
    )
  }
  const persistedSteps = new Map(
    (await store.listPublicationSteps(run_id)).map((step) => [step.step_key, step])
  )

  for (const delivery of deliveries) {
    const deliveryId = String(delivery.delivery_id ?? '')
    const stepKey = `repository:delivery:${deliveryId}`
    try {
      const deliveryCvss = deliveryCvssFieldsFromCases(delivery, case_results)
      const persisted = persistedSteps.get(stepKey)
      // A deterministic rejection is already final for this delivery. Later
      // publication retries still need to reach the summary and other deliveries.
      if (persisted?.status === 'terminal_failed') continue
      let draftPullRequest: DraftPullRequestSummary
      if (
        persisted?.status === 'succeeded' &&
        persisted.remote_object_id &&
        persisted.remote_object_url
      ) {
        draftPullRequest = {
          title: String(buildDeliveryDraftPrTitle(delivery)),
          html_url: persisted.remote_object_url,
          number: Number(persisted.remote_object_id),
          reused: true
        }
      } else {
        await store.requirePublicationStepClaim(run_id, claim_token, stepKey)
        await assert_publication_claim()
        draftPullRequest = (await create_delivery_draft_pr({
          octokit,
          repo,
          run_id,
          input: {
            workspace_ref: resolvedWorkspaceRef,
            ...(scan_target?.target_branch
              ? { scan_target: { target_branch: scan_target.target_branch } }
              : {})
          },
          delivery,
          case_results,
          assert_publication_claim
        })) as DraftPullRequestSummary
        if (
          !(await store.completePublicationStep(run_id, claim_token, stepKey, {
            id: draftPullRequest.number,
            url: draftPullRequest.html_url
          }))
        ) {
          throw new PublicationClaimLostError(run_id)
        }
      }
      published_delivery_entries.push({
        delivery_id: String(delivery.delivery_id ?? ''),
        case_count: deliveryCvss.case_count,
        cvss_outcome: deliveryCvss.cvss_outcome,
        cvss_base_score: deliveryCvss.cvss_base_score,
        cvss_severity: deliveryCvss.cvss_severity,
        title: draftPullRequest.title,
        html_url: draftPullRequest.html_url,
        file_changes: Array.isArray(delivery.file_changes) ? delivery.file_changes : []
      })
      logInfo('delivery_draft_pr_completed', {
        delivery_id: delivery.delivery_id,
        draft_pr_number: draftPullRequest.number,
        draft_pr_url: draftPullRequest.html_url,
        event_type,
        repo: repo.repo_full_name,
        reused: draftPullRequest.reused
      })
    } catch (error) {
      if (isPublicationClaimLostError(error)) throw error
      const errorMessage = asErrorMessage(error)
      const failure = classifyPublicationFailure(error)
      await store.failPublicationStep(
        run_id,
        claim_token,
        stepKey,
        {
          code: failure.code,
          message: errorMessage
        },
        { retry: failure.retry }
      )
      logError('delivery_draft_pr_failed', {
        delivery_id: delivery?.delivery_id ?? '(unknown)',
        error,
        error_message: errorMessage,
        event_type,
        repo: repo.repo_full_name
      })
      if (failure.retry) {
        throw new Error(
          `Failed to publish repository delivery ${String(delivery?.delivery_id ?? '(unknown)')}: ${errorMessage}`,
          { cause: error }
        )
      }
    }
  }

  return published_delivery_entries
}

export async function ensureSummaryIssueNumber(
  octokit: GitHubAppOctokit,
  repo: RepositoryContext,
  assertPublicationClaim: () => Promise<void>
): Promise<number> {
  const existing = await findRepositorySecuritySummaryIssue(octokit, {
    owner_login: repo.owner_login,
    repo_name: repo.repo_name,
    title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE
  })

  if (existing) {
    return existing.number
  }

  await assertPublicationClaim()
  const created = await octokit.rest.issues.create({
    owner: repo.owner_login,
    repo: repo.repo_name,
    title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE,
    body: buildRepoReviewSummaryBody({ repo })
  })

  return created.data.number
}

async function publishRepositoryReviewResult({
  octokit,
  repo,
  run_id,
  workspace_ref,
  scan_target,
  workflow_result,
  event_type,
  store,
  claim_token,
  assert_publication_claim
}: {
  octokit: unknown
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target?: PersistedRepositoryScanTarget
  workflow_result: RepositoryWorkflowResult
  event_type: 'manual' | 'scheduled'
  store: ControlPlaneClient
  claim_token: string
  assert_publication_claim: () => Promise<void>
}): Promise<void> {
  const github = octokit as GitHubAppOctokit
  const deliveryStepKeys = (workflow_result.deliveries ?? []).map(
    (delivery) => `repository:delivery:${String(delivery.delivery_id ?? '')}`
  )
  await store.initializePublicationSteps(run_id, claim_token, [
    ...deliveryStepKeys,
    'repository:summary-issue',
    'repository:summary-comment'
  ])
  const published_delivery_entries = await publishDeliveryDraftPrs({
    octokit: github,
    repo,
    run_id,
    workspace_ref,
    deliveries: workflow_result.deliveries ?? [],
    case_results: workflow_result.case_results ?? [],
    event_type,
    store,
    claim_token,
    assert_publication_claim,
    ...(scan_target ? { scan_target } : {})
  })

  const steps = await store.listPublicationSteps(run_id)
  const summaryIssueStep = steps.find((step) => step.step_key === 'repository:summary-issue')
  let summaryIssueNumber: number
  if (summaryIssueStep?.status === 'succeeded' && summaryIssueStep.remote_object_id) {
    summaryIssueNumber = Number(summaryIssueStep.remote_object_id)
  } else {
    await store.requirePublicationStepClaim(run_id, claim_token, 'repository:summary-issue')
    try {
      await assert_publication_claim()
      summaryIssueNumber = await ensureSummaryIssueNumber(github, repo, assert_publication_claim)
      if (
        !(await store.completePublicationStep(run_id, claim_token, 'repository:summary-issue', {
          id: summaryIssueNumber
        }))
      )
        throw new PublicationClaimLostError(run_id)
    } catch (error) {
      if (isPublicationClaimLostError(error)) throw error
      const failure = classifyPublicationFailure(error)
      await store.failPublicationStep(
        run_id,
        claim_token,
        'repository:summary-issue',
        {
          code: failure.code,
          message: asErrorMessage(error)
        },
        { retry: failure.retry }
      )
      throw error
    }
  }
  const marker = repositorySummaryRunMarker(run_id)
  const commentBody = [
    marker,
    renderRepositorySecuritySummaryComment({
      workflow_result: buildRepositorySummaryWorkflowView(workflow_result, {
        run_id
      }),
      published_delivery_entries,
      event_type,
      target_branch: scan_target?.target_branch ?? repo.default_branch,
      ...(scan_target ? { scan_target } : {})
    })
  ].join('\n\n')
  const summaryCommentStep = (await store.listPublicationSteps(run_id)).find(
    (step) => step.step_key === 'repository:summary-comment'
  )
  if (summaryCommentStep?.status === 'succeeded') return
  await store.requirePublicationStepClaim(run_id, claim_token, 'repository:summary-comment')
  let comment
  try {
    await assert_publication_claim()
    comment = await createIssueCommentUnlessMarkerExists(github, {
      owner_login: repo.owner_login,
      repo_name: repo.repo_name,
      issue_number: summaryIssueNumber,
      body: commentBody,
      marker,
      assert_publication_claim
    })
    if (
      !(await store.completePublicationStep(run_id, claim_token, 'repository:summary-comment', {
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
      'repository:summary-comment',
      {
        code: failure.code,
        message: asErrorMessage(error)
      },
      { retry: failure.retry }
    )
    throw error
  }
  logInfo('repository_summary_comment_publish_completed', {
    comment_id: comment.id,
    comment_url: comment.html_url,
    event_type,
    issue: summaryIssueNumber,
    repo: repo.repo_full_name,
    reused: comment.reused
  })
}

export async function handleRepositoryReviewRun({
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
  const context = parseRepositoryReviewPublishContext(run.publish_context)
  const workflow_result = repositoryResultFromWorkflowResult(result)
  if (workflow_result === null) {
    throw new Error(`Repository review run ${run.run_id} is not ready to publish.`)
  }
  const octokit = await installation_octokit_for_repo(context.repo.repo_full_name)
  await publishRepositoryReviewResult({
    octokit,
    repo: context.repo,
    run_id: run.run_id,
    workspace_ref: context.workspace_ref,
    scan_target: context.scan_target,
    workflow_result,
    event_type: context.event_type,
    store,
    claim_token,
    assert_publication_claim
  })
}
