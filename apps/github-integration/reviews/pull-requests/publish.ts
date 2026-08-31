import { createPullRequestReview, type PullRequestReviewEvent } from '../../infrastructure/github/comment-service.js'
import type { PullRequestContext } from '../../infrastructure/github/pull-request-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { completedRunnerRunResult, type RunnerRunStatus } from '../../infrastructure/runner/client.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../infrastructure/runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../infrastructure/runner/publish-error.js'
import { parsePullRequestReviewPublishContext } from '../../infrastructure/runner/publish-context.js'
import {
  renderAnalysisSummaryCommentFromReviewRecord
} from './renderer.js'
import {
  generateSuggestionCandidatesFromReviewRecord,
  publishSuggestionReview
} from './suggestion-service.js'
import { logError, logInfo } from '../../utils/logger.js'
import { asErrorWithResponse } from '../../utils/error-utils.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { isRecord } from '../view-utils.js'
import { getGitHubAppMetadata } from '../../infrastructure/github/github-app-metadata-service.js'

interface SuggestionReviewResult {
  review_id: number
  html_url: string
  state: string
  count: number
  comments: Array<{
    path: string
    line: number
    start_line: number
  }>
}

interface SuggestionManifestLike {
  candidates: Array<unknown>
  skipped_reason?: string | null
  unmapped_changes?: Array<{
    path?: string
    reason?: string
    hunk?: {
      new_start?: number
      new_count?: number
    }
  }>
}

export interface PullRequestReviewWorkflowResult {
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

function pullRequestReviewResultFromRunStatus (status: RunnerRunStatus): PullRequestReviewWorkflowResult | null {
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
      `Pull request review result is invalid: ${asErrorMessage(error)}`,
      RUNNER_PUBLISH_ERROR_CODES.pull_request_result_invalid,
      { cause: error }
    )
  }
}

export async function handlePullRequestReviewRun ({
  run,
  status,
  installation_octokit_for_repo
}: {
  run: CompletedRunnerRun
  status: RunnerRunStatus
  installation_octokit_for_repo: InstallationOctokitForRepo
}): Promise<void> {
  const context = parsePullRequestReviewPublishContext(run.publish_context)
  const workflow_result = pullRequestReviewResultFromRunStatus(status)
  if (workflow_result === null) {
    throw new Error(`Pull request review run ${run.run_id} is not ready to publish.`)
  }
  const octokit = await installation_octokit_for_repo(context.pr.repo_full_name)
  await publishPullRequestReviewResult({
    octokit,
    pr: context.pr,
    files: context.files,
    workflow_result,
    event_type: context.event_type
  })
}

function shouldPublishSuggestions (review_record: ReviewRecord | null | undefined): boolean {
  return typeof review_record?.mitigation?.patch_diff === 'string' &&
    review_record.mitigation.patch_diff.trim() !== ''
}

function normalizeLogin (login: unknown): string | null {
  return typeof login === 'string' && login.trim() !== ''
    ? login.trim().toLowerCase()
    : null
}

function isAuthoredByCurrentAppBot (pr: PullRequestContext): boolean {
  const author_login = normalizeLogin(pr.pr_author)
  const appBotLogin = normalizeLogin(getGitHubAppMetadata().bot_login)
  return author_login !== null && appBotLogin !== null && author_login === appBotLogin
}

function reviewEventForRecord (review_record: ReviewRecord, pr: PullRequestContext): PullRequestReviewEvent {
  // The app should leave evidence on its own PRs, not create reviewer state for itself.
  if (isAuthoredByCurrentAppBot(pr)) {
    return 'COMMENT'
  }

  if (review_record.analysis.verdict === 'no-actionable-finding') {
    return 'APPROVE'
  }
  if (
    review_record.analysis.verdict === 'confirmed-vulnerability' ||
    review_record.analysis.verdict === 'confirmed-defect' ||
    review_record.analysis.verdict === 'plausible-risk'
  ) {
    return 'REQUEST_CHANGES'
  }
  return 'COMMENT'
}

function appendUnmappedSuggestionSection (review_body: string, manifest: SuggestionManifestLike): string {
  const unmapped = Array.isArray(manifest.unmapped_changes) ? manifest.unmapped_changes : []
  if (unmapped.length === 0) {
    return review_body
  }

  const lines = [
    '',
    '### Unmapped Mitigation Changes',
    '',
    'Some mitigation edits could not be anchored as inline suggestions in the current PR diff.',
    ''
  ]

  for (const item of unmapped.slice(0, 10)) {
    const path = String(item.path ?? '').trim() || '(unknown path)'
    const reason = String(item.reason ?? '').trim() || 'Not anchorable to PR diff.'
    const hunk = item.hunk ?? {}
    const new_start = Number(hunk.new_start ?? 0)
    const new_count = Number(hunk.new_count ?? 0)
    const range = new_start > 0 && new_count > 0
      ? ` [new:${new_start}, count:${new_count}]`
      : ''
    lines.push(`- \`${path}\`${range}: ${reason}`)
  }

  if (unmapped.length > 10) {
    lines.push(`- (+${unmapped.length - 10} more unmapped change(s))`)
  }

  return `${review_body}\n${lines.join('\n')}`
}

async function publishPullRequestReviewResult ({
  octokit,
  pr,
  files: reviewFiles,
  event_type,
  workflow_result
}: {
  octokit: unknown
  pr: PullRequestContext
  files: unknown[]
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  workflow_result: PullRequestReviewWorkflowResult
}): Promise<void> {
  let review: SuggestionReviewResult | null = null
  const review_record = workflow_result.review_record
  const commentBody = renderAnalysisSummaryCommentFromReviewRecord(review_record)
  const reviewEvent = reviewEventForRecord(review_record, pr)

  if (shouldPublishSuggestions(review_record)) {
    try {
      const suggestionManifest = await generateSuggestionCandidatesFromReviewRecord({
        files: reviewFiles as Parameters<typeof generateSuggestionCandidatesFromReviewRecord>[0]['files'],
        review_record
      })

      if (suggestionManifest.candidates.length > 0) {
        const reviewBodyWithUnmapped = appendUnmappedSuggestionSection(
          commentBody,
          suggestionManifest as SuggestionManifestLike
        )
        review = (await publishSuggestionReview(octokit, {
          pr,
          review_body: reviewBodyWithUnmapped,
          event: reviewEvent,
          candidates: suggestionManifest.candidates
        })) as SuggestionReviewResult
        logInfo('suggestion_review_completed', {
          comment_count: review.count,
          event_type,
          unmapped_count: Array.isArray((suggestionManifest as SuggestionManifestLike).unmapped_changes)
            ? ((suggestionManifest as SuggestionManifestLike).unmapped_changes?.length ?? 0)
            : 0,
          pr: pr.pr_number,
          review_id: review.review_id,
          review_url: review.html_url
        })
      } else {
        logInfo('suggestion_pipeline_completed', {
          event_type,
          pr: pr.pr_number,
          reason: suggestionManifest.skipped_reason ?? 'No eligible patch candidate.'
        })
      }
    } catch (error: unknown) {
      const errorInfo = asErrorWithResponse(error)
      logError('suggestion_review_failed', {
        error,
        error_message: errorInfo.message,
        event_type,
        pr: pr.pr_number,
        repo: pr.repo_full_name
      })
    }
  } else if (review_record?.mitigation) {
    logInfo('suggestion_pipeline_skipped', {
      event_type,
      pr: pr.pr_number,
      reason: 'mitigation_not_single_change'
    })
  }

  if (review) {
    logInfo('integrated_review_creation_completed', {
      event_type,
      pr: pr.pr_number,
      review_id: review.review_id,
      review_url: review.html_url
    })

    return
  }

  logInfo('analysis_review_publish_started', {
    event_type,
    pr: pr.pr_number,
    repo: pr.repo_full_name
  })

  const reviewComment = await createPullRequestReview(octokit as GitHubAppOctokit, {
    owner_login: pr.owner_login,
    repo_name: pr.repo_name,
    pr_number: pr.pr_number,
    commit_id: pr.head_sha,
    body: commentBody,
    event: reviewEvent,
    comments: []
  })

  logInfo('analysis_review_publish_completed', {
    event_type,
    pr: pr.pr_number,
    review_id: reviewComment.id,
    review_url: reviewComment.html_url
  })

}
