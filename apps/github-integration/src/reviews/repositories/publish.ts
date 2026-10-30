import {
  createIssueCommentUnlessMarkerExists,
  findIssueCommentByMarker
} from '../../github/comment-service.js'
import { findRepositorySecuritySummaryIssue } from '../../github/repository-service.js'
import type { Octokit } from 'octokit'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../execution/publish-error-code.js'
import type { PublicationStepStore } from '../../review-runs/client.js'
import { classifyPublicationFailure } from '../../review-runs/publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from '../../review-runs/publication-claim.js'
import { DeterministicExecutionPublishError } from '../../execution/publish-error.js'
import { parseRepositoryReviewPublishContext } from '../../review-runs/publish-context.js'
import {
  buildRepositoryDeliveryBranchName,
  createRepositoryDeliveryDraftPr
} from './delivery-draft-pr.js'
import { buildDeliveryDraftPrTitle } from './delivery-title.js'
import {
  buildRepositorySummaryWorkflowView,
  buildRepoReviewSummaryBody,
  renderRepositorySecuritySummaryComment,
  REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE
} from './renderer.js'
import { logError, logInfo } from '../../utils/logger.js'
import { asErrorMessage } from '../../utils/error-utils.js'
import {
  findOpenPullRequestByHeadBranch,
  isPublicationStepExhausted,
  settleExhaustedStep
} from '../shared/settle-exhausted-step.js'
import { runPublicationStep } from '../shared/publication-step.js'
import {
  parseRepositoryWorkflowResult,
  type RepositoryCaseResult,
  type RepositoryDelivery,
  type RepositoryWorkflowResult
} from './result.js'
import type { RepositoryContext } from './submit.js'
import type { PersistedRepositoryScanTarget } from '../../review-runs/publish-context.js'

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
  file_changes: RepositoryDelivery['file_changes']
}

interface DraftPullRequestSummary {
  title: string
  html_url: string
  number: number
  reused: boolean
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<Octokit>
type CompletedExecutionRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function repositorySummaryRunMarker(run_id: string): string {
  return `<!-- sec-review-bot:repository-summary-run:${run_id} -->`
}

function repositoryResultFromWorkflowResult(
  result: unknown
): RepositoryWorkflowResult | null {
  try {
    return parseRepositoryWorkflowResult(result)
  } catch (error) {
    // The completed execution payload is already persisted; polling it again will
    // return the same invalid contract result.
    throw new DeterministicExecutionPublishError(
      `Repository review result is invalid: ${asErrorMessage(error)}`,
      EXECUTION_PUBLISH_ERROR_CODES.repository_result_invalid,
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
  const case_ids = new Set(delivery.case_ids)
  const matchedCases = case_results.filter((item) => case_ids.has(item.case_id))
  const case_count = delivery.case_count
  let best_score: number | null = null
  let best_severity: string | null = null
  let first_non_scored_outcome: string | null = null
  let notScoredCount = 0
  let cvssCount = 0

  for (const item of matchedCases) {
    const cvss = item.review_record.cvss
    if (cvss === null) {
      continue
    }
    cvssCount += 1

    const outcome = cvss.outcome
    if (outcome === 'not-scored') {
      notScoredCount += 1
    } else if (outcome && outcome !== 'scored' && !first_non_scored_outcome) {
      first_non_scored_outcome = outcome
    }

    const score = cvss.base_score
    if (score == null) {
      continue
    }
    if (best_score == null || score > best_score) {
      best_score = score
      best_severity = cvss.severity
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
      cvssCount > 0 && notScoredCount === cvssCount
        ? 'not-scored'
        : first_non_scored_outcome,
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
  octokit: Octokit
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target?: PersistedRepositoryScanTarget
  deliveries: RepositoryDelivery[]
  case_results: RepositoryCaseResult[]
  event_type: 'manual' | 'scheduled'
  store: PublicationStepStore
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
    (await store.listPublicationSteps(run_id)).map((step) => [
      step.step_key,
      step
    ])
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
      const draftPullRequest: DraftPullRequestSummary =
        persisted?.status === 'succeeded' &&
        persisted.remote_object_id &&
        persisted.remote_object_url
          ? {
              title: String(buildDeliveryDraftPrTitle(delivery)),
              html_url: persisted.remote_object_url,
              number: Number(persisted.remote_object_id),
              reused: true
            }
          : await publishOrReconcileDeliveryDraftPr({
              octokit,
              store,
              create_delivery_draft_pr,
              run_id,
              claim_token,
              stepKey,
              repo,
              delivery,
              case_results,
              resolvedWorkspaceRef,
              scan_target,
              event_type,
              assert_publication_claim
            })
      published_delivery_entries.push({
        delivery_id: String(delivery.delivery_id ?? ''),
        case_count: deliveryCvss.case_count,
        cvss_outcome: deliveryCvss.cvss_outcome,
        cvss_base_score: deliveryCvss.cvss_base_score,
        cvss_severity: deliveryCvss.cvss_severity,
        title: draftPullRequest.title,
        html_url: draftPullRequest.html_url,
        file_changes: Array.isArray(delivery.file_changes)
          ? delivery.file_changes
          : []
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
      if (failure.scope === 'publication') {
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
  octokit: Octokit,
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

/** Claim the summary issue step, or conclude it from the issue a previous owner already created.
 *
 * The summary issue is identified by its fixed title, so an existing one answers whether this
 * step's side effect happened — including when the publisher that created it died before
 * recording it, or when no attempt is left to record it. */
async function claimOrReconcileSummaryIssue({
  octokit,
  store,
  run_id,
  claim_token,
  repo,
  event_type,
  assert_publication_claim
}: {
  octokit: Octokit
  store: PublicationStepStore
  run_id: string
  claim_token: string
  repo: RepositoryContext
  event_type: string
  assert_publication_claim: () => Promise<void>
}): Promise<number> {
  const stepKey = 'repository:summary-issue'
  const step = await runPublicationStep({
    store,
    runId: run_id,
    token: claim_token,
    stepKey,
    assertClaim: assert_publication_claim,
    find: async () => {
      const existing = await findRepositorySecuritySummaryIssue(octokit, {
        owner_login: repo.owner_login,
        repo_name: repo.repo_name,
        title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE
      })
      return existing === null ? null : { id: existing.number }
    },
    effect: async () => ({
      id: await ensureSummaryIssueNumber(
        octokit,
        repo,
        assert_publication_claim
      )
    })
  })
  const issueNumber = Number(step.remote.id)
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new Error(
      'Repository summary issue step is succeeded without a recorded issue number.'
    )
  if (step.reconciled)
    logInfo('repository_summary_issue_reconciled', {
      event_type,
      repo: repo.repo_full_name,
      issue_number: issueNumber
    })
  return issueNumber
}

/** Create a delivery's draft PR, or conclude the step from one a previous owner already opened.
 *
 * A delivery step that runs out of attempts may still have its draft PR on GitHub: the publisher
 * that opened it can die before recording it. The head branch embeds the run and delivery ids, so
 * an open PR from it is unambiguously this step's side effect. Reconciliation only reports what
 * it found; the step is concluded through `settleExhaustedPublicationStep`, which is also what
 * makes a confirmed absence a terminal failure.
 *
 * This step deliberately does not use `runPublicationStep`: a delivery's failure is recorded by
 * the batch that owns all deliveries, which decides whether the publication aborts or continues
 * with the remaining ones. Recording it here as well would write the same failure twice and take
 * the continue-or-abort decision away from the only caller that can make it. */
async function publishOrReconcileDeliveryDraftPr({
  octokit,
  store,
  create_delivery_draft_pr,
  run_id,
  claim_token,
  stepKey,
  repo,
  delivery,
  case_results,
  resolvedWorkspaceRef,
  scan_target,
  event_type,
  assert_publication_claim
}: {
  octokit: Octokit
  store: PublicationStepStore
  create_delivery_draft_pr: typeof createRepositoryDeliveryDraftPr
  run_id: string
  claim_token: string
  stepKey: string
  repo: RepositoryContext
  delivery: RepositoryDelivery
  case_results: RepositoryCaseResult[]
  resolvedWorkspaceRef: string
  scan_target: { target_branch?: string } | undefined
  event_type: string
  assert_publication_claim: () => Promise<void>
}): Promise<DraftPullRequestSummary> {
  try {
    await store.requirePublicationStepClaim(run_id, claim_token, stepKey)
  } catch (error) {
    if (!isPublicationStepExhausted(error)) throw error
    const settled = await settleExhaustedStep({
      store,
      runId: run_id,
      token: claim_token,
      stepKey,
      find: async () => {
        const existing = await findOpenPullRequestByHeadBranch(octokit, {
          owner_login: repo.owner_login,
          repo_name: repo.repo_name,
          branch_name: buildRepositoryDeliveryBranchName(run_id, delivery)
        })
        return existing === null
          ? null
          : { id: existing.number, url: existing.html_url }
      }
    })
    if (settled.outcome !== 'recorded' || settled.step !== 'succeeded')
      throw error
    logInfo('delivery_draft_pr_reconciled', {
      delivery_id: delivery.delivery_id,
      draft_pr_number: Number(settled.remote.id),
      event_type,
      repo: repo.repo_full_name
    })
    return {
      title: String(buildDeliveryDraftPrTitle(delivery)),
      html_url: settled.remote.url ?? '',
      number: Number(settled.remote.id),
      reused: true
    }
  }

  await assert_publication_claim()
  const draftPullRequest = (await create_delivery_draft_pr({
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
  return draftPullRequest
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
  octokit: Octokit
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target?: PersistedRepositoryScanTarget
  workflow_result: RepositoryWorkflowResult
  event_type: 'manual' | 'scheduled'
  store: PublicationStepStore
  claim_token: string
  assert_publication_claim: () => Promise<void>
}): Promise<void> {
  const github = octokit
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
  const summaryIssueStep = steps.find(
    (step) => step.step_key === 'repository:summary-issue'
  )
  const summaryIssueNumber =
    summaryIssueStep?.status === 'succeeded' &&
    summaryIssueStep.remote_object_id
      ? Number(summaryIssueStep.remote_object_id)
      : await claimOrReconcileSummaryIssue({
          octokit: github,
          store,
          run_id,
          claim_token,
          repo,
          event_type,
          assert_publication_claim
        })
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
  // No attempts left is not a verdict: the summary comment may already be posted under this
  // run's marker, in which case the step is done and reporting a failure would contradict what
  // is on GitHub.
  let reused = false
  const commentStep = await runPublicationStep({
    store,
    runId: run_id,
    token: claim_token,
    stepKey: 'repository:summary-comment',
    assertClaim: assert_publication_claim,
    find: async () => {
      const existing = await findIssueCommentByMarker(github, {
        owner_login: repo.owner_login,
        repo_name: repo.repo_name,
        issue_number: summaryIssueNumber,
        marker
      })
      return existing === null
        ? null
        : { id: existing.id, url: existing.html_url }
    },
    effect: async () => {
      const comment = await createIssueCommentUnlessMarkerExists(github, {
        owner_login: repo.owner_login,
        repo_name: repo.repo_name,
        issue_number: summaryIssueNumber,
        body: commentBody,
        marker,
        assert_publication_claim
      })
      reused = comment.reused
      return { id: comment.id, url: comment.html_url }
    }
  })
  if (commentStep.alreadySucceeded) return
  logInfo('repository_summary_comment_publish_completed', {
    comment_id: commentStep.remote.id,
    comment_url: commentStep.remote.url,
    event_type,
    issue: summaryIssueNumber,
    repo: repo.repo_full_name,
    reused
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
  run: CompletedExecutionRun
  result: unknown
  store: PublicationStepStore
  claim_token: string
  assert_publication_claim: () => Promise<void>
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parseRepositoryReviewPublishContext(run.publish_context)
  const workflow_result = repositoryResultFromWorkflowResult(result)
  if (workflow_result === null) {
    throw new Error(
      `Repository review run ${run.run_id} is not ready to publish.`
    )
  }
  const octokit = await installation_octokit_for_repo(
    context.repo.repo_full_name
  )
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
