import { createIssueCommentUnlessMarkerExists } from '../../infrastructure/github/comment-service.js'
import { findRepositorySecuritySummaryIssue } from '../../infrastructure/github/repository-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { completedRunnerRunResult, type RunnerRunStatus } from '../../infrastructure/runner/client.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../infrastructure/runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../infrastructure/runner/publish-error.js'
import { parseRepositoryReviewPublishContext } from '../../infrastructure/runner/publish-context.js'
import { createRepositoryDeliveryDraftPr } from './delivery-draft-pr.js'
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
import type {
  RepositoryScanTarget
} from '../../infrastructure/runner/input.js'
import {
  asList,
  isRecord,
  nonEmptyText,
  optionalNumber,
  type AnyRecord
} from '../view-utils.js'

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

function repositorySummaryRunMarker (run_id: string): string {
  return `<!-- sec-review-bot:repository-summary-run:${run_id} -->`
}

function asErrorMessage (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function repositoryResultFromRunStatus (status: RunnerRunStatus): RepositoryWorkflowResult | null {
  const completed = completedRunnerRunResult(status)
  if (completed === null) {
    return null
  }
  try {
    return parseRepositoryWorkflowResult(completed.result)
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

function deliveryCvssFieldsFromCases (delivery: RepositoryDelivery, case_results: RepositoryCaseResult[]): {
  case_count: number
  cvss_outcome: string | null
  cvss_base_score: number | null
  cvss_severity: string | null
} {
  const case_ids = new Set(asList(delivery.case_ids).map(nonEmptyText).filter((item) => item.length > 0))
  const matchedCases = asList<AnyRecord>(case_results).filter((item) => case_ids.has(nonEmptyText(item.case_id)))
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
    cvss_outcome: cvssCount > 0 && notScoredCount === cvssCount
      ? 'not-scored'
      : first_non_scored_outcome,
    cvss_base_score: null,
    cvss_severity: null
  }
}

async function publishDeliveryDraftPrs ({
  octokit,
  repo,
  workspace_ref,
  scan_target,
  deliveries,
  case_results,
  event_type
}: {
  octokit: GitHubAppOctokit
  repo: RepositoryContext
  workspace_ref: string
  scan_target?: RepositoryScanTarget
  deliveries: RepositoryDelivery[]
  case_results: RepositoryCaseResult[]
  event_type: 'manual' | 'scheduled'
}): Promise<PublishedDeliveryEntry[]> {
  const published_delivery_entries: PublishedDeliveryEntry[] = []
  const resolvedWorkspaceRef = String(workspace_ref ?? '').trim()
  if (!resolvedWorkspaceRef) {
    throw new Error('Repository publish context is missing workspace_ref before delivery branch creation.')
  }

  for (const delivery of deliveries) {
    try {
      const deliveryCvss = deliveryCvssFieldsFromCases(delivery, case_results)
      const draftPullRequest = await createRepositoryDeliveryDraftPr({
        octokit,
        repo,
        input: {
          workspace_ref: resolvedWorkspaceRef,
          ...(scan_target?.target_branch
            ? {
                scan_target: {
                  target_branch: scan_target.target_branch
                }
              }
            : {})
        },
        delivery,
        case_results
      }) as DraftPullRequestSummary
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
      const errorMessage = asErrorMessage(error)
      logError('delivery_draft_pr_failed', {
        delivery_id: delivery?.delivery_id ?? '(unknown)',
        error,
        error_message: errorMessage,
        event_type,
        repo: repo.repo_full_name
      })
      throw new Error(
        `Failed to publish repository delivery ${String(delivery?.delivery_id ?? '(unknown)')}: ${errorMessage}`,
        { cause: error }
      )
    }
  }

  return published_delivery_entries
}

async function ensureSummaryIssueNumber (
  octokit: GitHubAppOctokit,
  repo: RepositoryContext
): Promise<number> {
  const existing = await findRepositorySecuritySummaryIssue(octokit, {
    owner_login: repo.owner_login,
    repo_name: repo.repo_name,
    title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE
  })

  if (existing) {
    return existing.number
  }

  const created = await octokit.rest.issues.create({
    owner: repo.owner_login,
    repo: repo.repo_name,
    title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE,
    body: buildRepoReviewSummaryBody({ repo })
  })

  return created.data.number
}

async function publishRepositoryReviewResult ({
  octokit,
  repo,
  run_id,
  workspace_ref,
  scan_target,
  workflow_result,
  event_type
}: {
  octokit: unknown
  repo: RepositoryContext
  run_id: string
  workspace_ref: string
  scan_target?: RepositoryScanTarget
  workflow_result: RepositoryWorkflowResult
  event_type: 'manual' | 'scheduled'
}): Promise<void> {
  const github = octokit as GitHubAppOctokit
  const published_delivery_entries = await publishDeliveryDraftPrs({
    octokit: github,
    repo,
    workspace_ref,
    deliveries: workflow_result.deliveries ?? [],
    case_results: workflow_result.case_results ?? [],
    event_type,
    ...(scan_target ? { scan_target } : {})
  })

  const summaryIssueNumber = await ensureSummaryIssueNumber(
    github,
    repo
  )
  const marker = repositorySummaryRunMarker(run_id)
  const commentBody = [
    marker,
    renderRepositorySecuritySummaryComment({
    _repo: repo,
    workflow_result: buildRepositorySummaryWorkflowView(workflow_result, {
      run_id
    }),
    published_delivery_entries,
    event_type,
    target_branch: scan_target?.target_branch ?? repo.default_branch,
    ...(scan_target ? { scan_target } : {})
    })
  ].join('\n\n')
  const comment = await createIssueCommentUnlessMarkerExists(github, {
    owner_login: repo.owner_login,
    repo_name: repo.repo_name,
    issue_number: summaryIssueNumber,
    body: commentBody,
    marker
  })
  logInfo('repository_summary_comment_publish_completed', {
    comment_id: comment.id,
    comment_url: comment.html_url,
    event_type,
    issue: summaryIssueNumber,
    repo: repo.repo_full_name,
    reused: comment.reused
  })

}

export async function handleRepositoryReviewRun ({
  run,
  status,
  installation_octokit_for_repo
}: {
  run: CompletedRunnerRun
  status: RunnerRunStatus
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parseRepositoryReviewPublishContext(run.publish_context)
  const workflow_result = repositoryResultFromRunStatus(status)
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
    event_type: context.event_type
  })
}
