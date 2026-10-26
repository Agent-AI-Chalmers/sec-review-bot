import {
  EXECUTION_API_VERSION,
  type ExecutionApiVersion
} from '../../execution/execution-api-version.js'
import {
  createPullRequestReviewUnlessMarkerExists,
  findPullRequestReviewByMarker,
  type PullRequestReviewEvent
} from '../../github/comment-service.js'
import type { Octokit } from 'octokit'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../execution/publish-error-code.js'
import { DeterministicExecutionPublishError } from '../../execution/publish-error.js'
import {
  parsePullRequestReviewPublishContext,
  type PersistedPullRequest,
  type PersistedPullRequestFile
} from '../../control-plane/publish-context.js'
import { renderAnalysisSummaryCommentFromReviewRecord } from './renderer.js'
import {
  generateSuggestionCandidatesFromReviewRecord,
  publishSuggestionReview
} from './suggestion-service.js'
import { logError, logInfo } from '../../utils/logger.js'
import { asErrorWithResponse, asErrorMessage } from '../../utils/error-utils.js'
import {
  isPublicationStepExhausted,
  settleExhaustedStep
} from '../shared/settle-exhausted-step.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { isCurrentAppBotLogin } from '../../github/github-app-metadata-service.js'
import { assertWorkflowResult } from '../../execution/execution-api-schema.js'
import type { PublicationStepStore } from '../../control-plane/client.js'
import { classifyPublicationFailure } from '../../control-plane/publication-failure.js'
import {
  isPublicationClaimLostError,
  PublicationClaimLostError
} from '../../control-plane/publication-claim.js'

interface SuggestionReviewResult {
  review_id: number
  html_url: string
  state: string
  count: number
  reused: boolean
  comments: Array<{
    path: string
    line: number
    start_line: number
  }>
}

interface PublishedReviewRef {
  id: number
  url: string
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
  api_version: ExecutionApiVersion
  review_record: ReviewRecord
  [key: string]: unknown
}

type InstallationOctokitForRepo = (repo_full_name: string) => Promise<Octokit>
type CompletedExecutionRun = {
  run_id: string
  publish_context: Record<string, unknown>
}

function pullRequestReviewResultFromWorkflowResult(
  result: unknown
): PullRequestReviewWorkflowResult | null {
  try {
    assertWorkflowResult('pull-request-review', result)
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
      `Pull request review result is invalid: ${asErrorMessage(error)}`,
      EXECUTION_PUBLISH_ERROR_CODES.pull_request_result_invalid,
      { cause: error }
    )
  }
}

export async function handlePullRequestReviewRun({
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
  const context = parsePullRequestReviewPublishContext(run.publish_context)
  const workflow_result = pullRequestReviewResultFromWorkflowResult(result)
  if (workflow_result === null) {
    throw new Error(
      `Pull request review run ${run.run_id} is not ready to publish.`
    )
  }
  const octokit = await installation_octokit_for_repo(context.pr.repo_full_name)
  await publishPullRequestReviewResult({
    octokit,
    pr: context.pr,
    files: context.files,
    workflow_result,
    event_type: context.event_type,
    run_id: run.run_id,
    store,
    claim_token,
    assert_publication_claim
  })
}

function shouldPublishSuggestions(
  review_record: ReviewRecord | null | undefined
): boolean {
  return (
    typeof review_record?.mitigation?.patch_diff === 'string' &&
    review_record.mitigation.patch_diff.trim() !== ''
  )
}

function pullRequestReviewRunMarker(run_id: string): string {
  // Publication retries use this identity to recover a review accepted by GitHub
  // when the response or the following local state update was lost.
  return `<!-- sec-review-bot:pull-request-review-run:${run_id} -->`
}

function reviewEventForRecord(
  review_record: ReviewRecord,
  pr: PersistedPullRequest
): PullRequestReviewEvent {
  // The app should leave evidence on its own PRs, not create reviewer state for itself.
  //
  // A stored PR context keeps the author as a login only, with no user `type`, so this uses the
  // shared login comparison rather than the full user check: passing a fabricated
  // `type: 'Bot'` to `wasAuthoredByCurrentAppBot` would make half of that guard unconditionally
  // true and read as if the bot-entity check had run. `isCurrentAppBotLogin` also fails closed
  // (throws) when the app's own login is unknown, which a local copy did not: that copy
  // answered `false` and would have approved the app's own PRs.
  if (isCurrentAppBotLogin(pr.pr_author)) {
    return 'COMMENT'
  }

  if (review_record.analysis.verdict === 'no-actionable-finding') {
    return 'APPROVE'
  }

  if (
    review_record.analysis.verdict === 'confirmed-vulnerability' ||
    review_record.analysis.verdict === 'confirmed-defect'
  ) {
    // Confirmed findings would normally request changes. A regular GitHub App
    // can submit REQUEST_CHANGES without becoming a requestable reviewer,
    // however, leaving no reliable Re-request review path to replace that
    // blocking state. Degrade to COMMENT until GitHub exposes that lifecycle:
    // https://github.com/SchweizerischeBundesbahnen/github-workflows-polarion/issues/70
    return 'COMMENT'
  }

  // Plausible risks require human judgment and are non-blocking by design.
  return 'COMMENT'
}

function appendUnmappedSuggestionSection(
  review_body: string,
  manifest: SuggestionManifestLike
): string {
  const unmapped = Array.isArray(manifest.unmapped_changes)
    ? manifest.unmapped_changes
    : []
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
    const reason =
      String(item.reason ?? '').trim() || 'Not anchorable to PR diff.'
    const hunk = item.hunk ?? {}
    const new_start = Number(hunk.new_start ?? 0)
    const new_count = Number(hunk.new_count ?? 0)
    const range =
      new_start > 0 && new_count > 0
        ? ` [new:${new_start}, count:${new_count}]`
        : ''
    lines.push(`- \`${path}\`${range}: ${reason}`)
  }

  if (unmapped.length > 10) {
    lines.push(`- (+${unmapped.length - 10} more unmapped change(s))`)
  }

  return `${review_body}\n${lines.join('\n')}`
}

async function publishPullRequestReviewResult({
  octokit,
  pr,
  files: reviewFiles,
  event_type,
  workflow_result,
  run_id,
  store,
  claim_token,
  assert_publication_claim
}: {
  octokit: Octokit
  pr: PersistedPullRequest
  files: PersistedPullRequestFile[]
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  workflow_result: PullRequestReviewWorkflowResult
  run_id: string
  store: PublicationStepStore
  claim_token: string
  assert_publication_claim: () => Promise<void>
}): Promise<void> {
  const stepKey = 'pull-request:review'
  await store.initializePublicationSteps(run_id, claim_token, [stepKey])
  const persisted = (await store.listPublicationSteps(run_id))[0]
  if (persisted?.status === 'succeeded') return
  try {
    await store.requirePublicationStepClaim(run_id, claim_token, stepKey)
  } catch (error) {
    // No attempts left is not a verdict: the review may already be on the pull request. The
    // attempt that posted it can lose its response, and the publisher that started it may have
    // died before recording it. Look for this run's marker before the step becomes a failure.
    if (!isPublicationStepExhausted(error)) throw error
    const marker = pullRequestReviewRunMarker(run_id)
    const settled = await settleExhaustedStep({
      store,
      runId: run_id,
      token: claim_token,
      stepKey,
      find: async () => {
        const existing = await findPullRequestReviewByMarker(octokit, {
          owner_login: pr.owner_login,
          repo_name: pr.repo_name,
          pr_number: pr.pr_number,
          marker
        })
        return existing === null
          ? null
          : { id: existing.id, url: existing.html_url }
      }
    })
    // The review was already submitted: nothing left to publish for this step.
    if (settled.outcome === 'recorded' && settled.step === 'succeeded') return
    throw error
  }
  try {
    // Never begin a GitHub mutation on the strength of an expired heartbeat.
    await assert_publication_claim()
    const remote = await publishPullRequestReviewSideEffect({
      octokit,
      pr,
      files: reviewFiles,
      event_type,
      workflow_result,
      run_id,
      assert_publication_claim
    })
    if (
      !(await store.completePublicationStep(
        run_id,
        claim_token,
        stepKey,
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
      stepKey,
      {
        code: failure.code,
        message: asErrorMessage(error)
      },
      { retry: failure.retry }
    )
    throw error
  }
}

async function publishPullRequestReviewSideEffect({
  octokit,
  pr,
  files: reviewFiles,
  event_type,
  workflow_result,
  run_id,
  assert_publication_claim
}: {
  octokit: Octokit
  pr: PersistedPullRequest
  files: PersistedPullRequestFile[]
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
  workflow_result: PullRequestReviewWorkflowResult
  run_id: string
  assert_publication_claim: () => Promise<void>
}): Promise<PublishedReviewRef> {
  let review: SuggestionReviewResult | null = null
  const review_record = workflow_result.review_record
  const marker = pullRequestReviewRunMarker(run_id)
  const commentBody = [
    marker,
    renderAnalysisSummaryCommentFromReviewRecord(review_record)
  ].join('\n\n')
  const reviewEvent = reviewEventForRecord(review_record, pr)

  if (shouldPublishSuggestions(review_record)) {
    let suggestionManifest: Awaited<
      ReturnType<typeof generateSuggestionCandidatesFromReviewRecord>
    > | null = null
    try {
      suggestionManifest = await generateSuggestionCandidatesFromReviewRecord({
        files: reviewFiles,
        review_record
      })
    } catch (error: unknown) {
      const errorInfo = asErrorWithResponse(error)
      logError('suggestion_generation_failed', {
        error,
        error_message: errorInfo.message,
        event_type,
        pr: pr.pr_number,
        repo: pr.repo_full_name
      })
    }

    if (suggestionManifest !== null) {
      if (suggestionManifest.candidates.length > 0) {
        const reviewBodyWithUnmapped = appendUnmappedSuggestionSection(
          commentBody,
          suggestionManifest as SuggestionManifestLike
        )
        review = (await publishSuggestionReview(octokit, {
          pr,
          review_body: reviewBodyWithUnmapped,
          event: reviewEvent,
          candidates: suggestionManifest.candidates,
          marker,
          assert_publication_claim
        })) as SuggestionReviewResult
        logInfo('suggestion_review_completed', {
          comment_count: review.count,
          event_type,
          unmapped_count: Array.isArray(
            (suggestionManifest as SuggestionManifestLike).unmapped_changes
          )
            ? ((suggestionManifest as SuggestionManifestLike).unmapped_changes
                ?.length ?? 0)
            : 0,
          pr: pr.pr_number,
          review_id: review.review_id,
          review_url: review.html_url,
          reused: review.reused
        })
      } else {
        logInfo('suggestion_pipeline_completed', {
          event_type,
          pr: pr.pr_number,
          reason:
            suggestionManifest.skipped_reason ?? 'No eligible patch candidate.'
        })
      }
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

    return { id: review.review_id, url: review.html_url }
  }

  logInfo('analysis_review_publish_started', {
    event_type,
    pr: pr.pr_number,
    repo: pr.repo_full_name
  })

  const reviewComment = await createPullRequestReviewUnlessMarkerExists(
    octokit,
    {
      owner_login: pr.owner_login,
      repo_name: pr.repo_name,
      pr_number: pr.pr_number,
      commit_id: pr.head_sha,
      body: commentBody,
      marker,
      event: reviewEvent,
      comments: [],
      assert_publication_claim
    }
  )

  logInfo('analysis_review_publish_completed', {
    event_type,
    pr: pr.pr_number,
    review_id: reviewComment.id,
    review_url: reviewComment.html_url,
    reused: reviewComment.reused
  })
  return { id: reviewComment.id, url: reviewComment.html_url }
}
