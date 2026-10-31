import {
  publishAndSubmitInputBundle,
  recoverInputBundlePublication,
  type InputBundlePublicationStore
} from '../artifacts/input-bundle-publication.js'
// Accepts repository-dispatch reviews, validates their local contract, and
// prepares a durable Execution submission under a fenced preparation claim.
import type { App } from 'octokit'
import { admitReviewRun } from '../review-runs/admission.js'
import {
  PreparationClaimLostError,
  startPreparationClaimHeartbeat
} from '../review-runs/preparation-claim.js'

import type { Octokit } from 'octokit'
import {
  getRepositoryRefSha,
  splitRepoFullName
} from '../github/repository-service.js'
import { prepareRepositoryReview } from '../reviews/repositories/prepare-review.js'
import type { TestChangesPolicy } from '../execution/input.js'
import { repositoryReviewPublishContext } from '../review-runs/publish-context.js'
import { reviewRunsClient } from '../review-runs/client.js'
import { isSetupDeclarationError } from '../github/setup-declaration.js'
import { ReviewRunsSubmissionError } from '../review-runs/client.js'
import { classifyPreparationFailure } from '../review-runs/preparation-failure.js'
import { logInfo } from '../utils/logger.js'
import { asErrorMessage } from '../utils/error-utils.js'
import { installationOctokitForRepo } from '../github/installation-client.js'

export interface RepositoryReviewDispatchPayload {
  repo_full_name?: unknown
  target_branch?: unknown
  scan_mode?: unknown
  base_sha?: unknown
  head_sha?: unknown
  event_type?: unknown
  schedule?: unknown
  test_changes?: unknown
  correlation_id?: unknown
  [key: string]: unknown
}

export interface ResolvedRepositoryReviewDispatch {
  repo_full_name: string
  target_branch: string
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string | null
  event_type: 'manual' | 'scheduled'
  test_changes: TestChangesPolicy | null
  correlation_id: string
}

interface ValidatedRepositoryReviewDispatch {
  repo_full_name: string
  target_branch: string
  scan_mode: 'full' | 'incremental'
  event_type: 'manual' | 'scheduled'
  test_changes: TestChangesPolicy | null
  correlation_id: string
  base_sha: string | null
  head_sha: string | null
}

export function normalizeRepositoryReviewDispatchPayload(
  raw: unknown
): RepositoryReviewDispatchPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  return raw as RepositoryReviewDispatchPayload
}

export function validateRepositoryReviewDispatchContract(
  payload: RepositoryReviewDispatchPayload
): ValidatedRepositoryReviewDispatch {
  const repo_full_name = requiredString(
    payload.repo_full_name,
    'repo_full_name'
  )
  splitRepoFullName(repo_full_name)
  const target_branch = requiredString(payload.target_branch, 'target_branch')
  const event_type = normalizeRepositoryEventType(payload.event_type)
  const scan_mode = normalizeScanMode(payload.scan_mode, event_type)
  const test_changes = normalizeTestChanges(payload.test_changes)
  const correlation_id = requiredString(
    payload.correlation_id,
    'correlation_id'
  )
  if (correlation_id.length > 128) {
    throw new Error('correlation_id must not exceed 128 characters.')
  }
  const head_sha = normalizeOptionalSha(payload.head_sha, 'head_sha')
  const base_sha = normalizeOptionalSha(payload.base_sha, 'base_sha')
  if (
    scan_mode === 'incremental' &&
    event_type === 'manual' &&
    base_sha === null
  ) {
    throw new Error('manual incremental scan requires base_sha.')
  }
  if (base_sha !== null && head_sha !== null && base_sha === head_sha) {
    throw new Error('incremental scan requires base_sha != head_sha.')
  }
  return {
    repo_full_name,
    target_branch,
    scan_mode,
    event_type,
    test_changes,
    correlation_id,
    base_sha,
    head_sha
  }
}

export async function resolveRepositoryReviewDispatch({
  octokit,
  payload
}: {
  octokit: Octokit
  payload: RepositoryReviewDispatchPayload
}): Promise<ResolvedRepositoryReviewDispatch> {
  const validated = validateRepositoryReviewDispatchContract(payload)
  const {
    repo_full_name,
    target_branch,
    event_type,
    scan_mode,
    test_changes,
    correlation_id
  } = validated
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)

  if (scan_mode !== 'incremental') {
    return {
      repo_full_name,
      target_branch,
      scan_mode,
      base_sha: null,
      head_sha: validated.head_sha,
      event_type,
      test_changes,
      correlation_id
    }
  }

  const head_sha = await resolveHeadSha({
    octokit,
    owner_login,
    repo_name,
    target_branch,
    head_sha: validated.head_sha
  })
  const base_sha =
    event_type === 'scheduled'
      ? await resolveScheduledBaseSha({
          octokit,
          owner_login,
          repo_name,
          head_sha,
          schedule: payload.schedule
        })
      : await resolveManualBaseSha({
          octokit,
          owner_login,
          repo_name,
          base_sha: validated.base_sha
        })

  if (base_sha === head_sha) {
    throw new RepositoryReviewDispatchValidationError(
      'incremental scan requires base_sha != head_sha.'
    )
  }

  return {
    repo_full_name,
    target_branch,
    scan_mode,
    base_sha,
    head_sha,
    event_type,
    test_changes,
    correlation_id
  }
}

export class RepositoryReviewDispatchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryReviewDispatchValidationError'
  }
}

export interface DispatchRepositoryReviewCommandArgs {
  app: App
  payload: RepositoryReviewDispatchPayload
  verified_repository: string
  claimed_preparation?: {
    run_id: string
    token: string
    attempt_count?: number
  }
  on_admitted?: (admission: {
    run_id: string
    status: string
    replayed: boolean
  }) => void
  deps?: Partial<DispatchRepositoryReviewCommandDeps>
}

export interface DispatchedRepositoryReview {
  run_id: string
  replayed: boolean
}

interface DispatchRepositoryReviewCommandDeps {
  getInstallationOctokit: (repo_full_name: string) => Promise<Octokit>
  resolve_dispatch: typeof resolveRepositoryReviewDispatch
  prepare_review: typeof prepareRepositoryReview
  store: InputBundlePublicationStore & {
    admitReviewRun: (
      ...args: Parameters<typeof reviewRunsClient.admitReviewRun>
    ) =>
      | Awaited<ReturnType<typeof reviewRunsClient.admitReviewRun>>
      | ReturnType<typeof reviewRunsClient.admitReviewRun>
    failPreparation: (
      ...args: Parameters<typeof reviewRunsClient.failPreparation>
    ) => unknown
    submitPreparedRun: (
      ...args: Parameters<typeof reviewRunsClient.submitPreparedRun>
    ) => unknown
    renewPreparationClaim: (
      ...args: Parameters<typeof reviewRunsClient.renewPreparationClaim>
    ) => Promise<boolean>
    preparationHeartbeatIntervalMs: typeof reviewRunsClient.preparationHeartbeatIntervalMs
  }
}

/**
 * Admit, resolve and submit one repository-review dispatch.
 *
 * This deliberately does not use `runPreparationCommand`: the dispatcher resolves the
 * workflow's inputs after admission, and that resolution has its own failure code
 * (`REVIEW_PREPARATION_FAILED`) and its own error type, because a rejected dispatch is the
 * workflow author's mistake rather than a review that could not start. The ingress kind also
 * differs — a GitHub Actions dispatch, not a webhook. Folding those differences into the
 * command would have meant a prepare hook plus a per-workflow failure policy, which is the
 * option bag the command exists to avoid.
 */
export async function dispatchRepositoryReview({
  app,
  payload,
  verified_repository,
  claimed_preparation,
  on_admitted,
  deps = {}
}: DispatchRepositoryReviewCommandArgs): Promise<DispatchedRepositoryReview> {
  const {
    getInstallationOctokit = async (repo_full_name) =>
      installationOctokitForRepo(app, repo_full_name),
    resolve_dispatch = resolveRepositoryReviewDispatch,
    prepare_review = prepareRepositoryReview,
    store = reviewRunsClient
  } = deps
  let validated: ValidatedRepositoryReviewDispatch
  try {
    validated = validateRepositoryReviewDispatchContract(payload)
  } catch (error) {
    throw new RepositoryReviewDispatchValidationError(asErrorMessage(error))
  }
  const { repo_full_name, correlation_id } = validated
  const admission =
    claimed_preparation === undefined
      ? await admitReviewRun(store, {
          workflow: 'repository-review',
          ingress_kind: 'github_actions_dispatch',
          ingress_key: `${verified_repository}:${correlation_id}`,
          preparation_input: {
            kind: 'github_repository_review',
            payload,
            verified_repository
          }
        })
      : null
  if (admission !== null) {
    on_admitted?.({
      run_id: admission.run_id,
      status: admission.status,
      replayed: !admission.created
    })
    if (!admission.created) {
      return { run_id: admission.run_id, replayed: true }
    }
  }
  const run_id = claimed_preparation?.run_id ?? admission?.run_id
  const preparationToken =
    claimed_preparation?.token ?? admission?.preparation_token
  const preparationAttempt = claimed_preparation?.attempt_count ?? 1
  if (run_id === undefined)
    throw new Error('Preparation admission did not return a run id.')
  if (!preparationToken)
    throw new Error(
      `Newly admitted review run ${run_id} has no preparation claim.`
    )
  const heartbeat = await startPreparationClaimHeartbeat(
    store,
    run_id,
    preparationToken
  )

  let octokit: Octokit
  let resolved: Awaited<ReturnType<typeof resolveRepositoryReviewDispatch>>
  try {
    if (await recoverInputBundlePublication(store, run_id, preparationToken)) {
      await heartbeat.stop()
      return { run_id, replayed: false }
    }
    octokit = await getInstallationOctokit(repo_full_name)
    resolved = await resolve_dispatch({ octokit, payload })
  } catch (error) {
    const classification = classifyPreparationFailure(
      error,
      preparationAttempt,
      error instanceof RepositoryReviewDispatchValidationError
    )
    if (
      (await heartbeat.stop()) &&
      !(error instanceof ReviewRunsSubmissionError) &&
      !(error instanceof PreparationClaimLostError)
    ) {
      await store.failPreparation(
        run_id,
        preparationToken,
        {
          code: 'REVIEW_PREPARATION_FAILED',
          message:
            asErrorMessage(error) || 'Repository review preparation failed.'
        },
        {
          retry: classification.retry,
          ...(classification.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classification.retryAfterMs })
        }
      )
    }
    throw new RepositoryReviewDispatchValidationError(
      asErrorMessage(error) || 'Repository review dispatch request is invalid.'
    )
  }

  try {
    const prepared = await prepare_review({
      octokit,
      run_id,
      ...resolved
    })
    await heartbeat.assertOwned()
    await publishAndSubmitInputBundle(
      store,
      run_id,
      preparationToken,
      repositoryReviewPublishContext(prepared.review),
      prepared.input
    )
  } catch (error) {
    const ownsClaim = await heartbeat.stop()
    if (
      ownsClaim &&
      !(error instanceof ReviewRunsSubmissionError) &&
      !(error instanceof PreparationClaimLostError)
    ) {
      const classification = classifyPreparationFailure(
        error,
        preparationAttempt,
        isSetupDeclarationError(error)
      )
      await store.failPreparation(
        run_id,
        preparationToken,
        {
          code: isSetupDeclarationError(error)
            ? 'SETUP_DECLARATION_INVALID'
            : 'REVIEW_START_FAILED',
          message:
            asErrorMessage(error) || 'Repository review could not be started.'
        },
        {
          retry: classification.retry,
          ...(classification.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classification.retryAfterMs })
        }
      )
    }
    throw error
  } finally {
    await heartbeat.stop()
  }

  logInfo('repository_review_dispatch_queued', {
    event: 'repository-review-dispatch',
    repo: resolved.repo_full_name,
    run_id,
    target_branch: resolved.target_branch ?? '(workflow-branch)',
    scan_mode: resolved.scan_mode,
    base_sha: resolved.base_sha ?? '(missing)',
    head_sha: resolved.head_sha ?? '(resolved-target-branch)',
    event_type: resolved.event_type,
    test_changes: resolved.test_changes ?? '(default)'
  })

  return { run_id, replayed: false }
}

function requiredString(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new Error(`${label} is required.`)
  }
  return text
}

function optionalString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function normalizeScanMode(
  value: unknown,
  event_type: 'manual' | 'scheduled'
): 'full' | 'incremental' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === '') {
    return event_type === 'scheduled' ? 'incremental' : 'full'
  }
  if (raw === 'full' || raw === 'incremental') {
    return raw
  }
  throw new Error(`Unsupported repository scan_mode: ${String(value)}`)
}

function normalizeRepositoryEventType(value: unknown): 'manual' | 'scheduled' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === '' || raw === 'manual') {
    return 'manual'
  }
  if (raw === 'scheduled') {
    return raw
  }
  throw new Error(`Unsupported repository event_type: ${String(value)}`)
}

function normalizeTestChanges(value: unknown): TestChangesPolicy | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    return null
  }
  if (raw === 'allow' || raw === 'deny') {
    return raw
  }
  throw new Error(`Unsupported repository test_changes: ${String(value)}`)
}

function normalizeOptionalSha(value: unknown, label: string): string | null {
  const raw = optionalString(value)
  if (raw === null) {
    return null
  }
  return ensureLikelyGitSha(raw, label)
}

function ensureLikelyGitSha(value: string, label: string): string {
  if (!/^[a-f0-9]{7,40}$/i.test(value)) {
    throw new Error(`${label} must be a valid commit SHA (7-40 hex chars).`)
  }
  return value
}

async function resolveHeadSha({
  octokit,
  owner_login,
  repo_name,
  target_branch,
  head_sha
}: {
  octokit: Octokit
  owner_login: string
  repo_name: string
  target_branch: string
  head_sha: unknown
}): Promise<string> {
  const explicitHeadSha = normalizeOptionalSha(head_sha, 'head_sha')
  if (explicitHeadSha) {
    return getRepositoryRefSha(octokit, {
      owner_login,
      repo_name,
      ref: explicitHeadSha
    })
  }
  return getRepositoryRefSha(octokit, {
    owner_login,
    repo_name,
    ref: target_branch
  })
}

async function resolveManualBaseSha({
  octokit,
  owner_login,
  repo_name,
  base_sha
}: {
  octokit: Octokit
  owner_login: string
  repo_name: string
  base_sha: unknown
}): Promise<string> {
  const explicitBaseSha = normalizeOptionalSha(base_sha, 'base_sha')
  if (!explicitBaseSha) {
    throw new Error('manual incremental scan requires base_sha.')
  }
  return getRepositoryRefSha(octokit, {
    owner_login,
    repo_name,
    ref: explicitBaseSha
  })
}

async function resolveScheduledBaseSha({
  octokit,
  owner_login,
  repo_name,
  head_sha,
  schedule
}: {
  octokit: Octokit
  owner_login: string
  repo_name: string
  head_sha: string
  schedule: unknown
}): Promise<string> {
  // Scheduled scans derive base_sha by looking back roughly one schedule interval from head_sha.
  const rollbackDays = inferRollbackDaysFromCron(optionalString(schedule))
  const cutoff = new Date(
    Date.now() - rollbackDays * 24 * 60 * 60 * 1000
  ).toISOString()
  const commits = await octokit.rest.repos.listCommits({
    owner: owner_login,
    repo: repo_name,
    sha: head_sha,
    until: cutoff,
    per_page: 1
  })
  const candidate = String(commits.data[0]?.sha ?? '').trim()
  if (!candidate || candidate === head_sha) {
    throw new Error(
      `scheduled incremental scan requires a resolvable base_sha before ${cutoff}.`
    )
  }
  return candidate
}

function inferRollbackDaysFromCron(expr: string | null): number {
  const parts = (expr || '')
    .trim()
    .split(/\s+/)
    .filter((item) => item !== '')
  if (parts.length !== 5) {
    return 7
  }
  const [, hour, dom, month, dow] = parts
  const domStep = step(dom)
  if (dom !== '*' || domStep !== null) {
    return domStep ?? 31
  }
  const dowStep = step(dow)
  if (dow !== '*' || dowStep !== null) {
    return dowStep !== null ? 7 * dowStep : 7
  }
  if (month !== '*') {
    return 31
  }
  const hourStep = step(hour)
  if (hourStep !== null) {
    return Math.max(1, Math.ceil(hourStep / 24))
  }
  return 1
}

function step(token: string | undefined): number | null {
  const match = String(token || '').match(/^\*\/([0-9]+)$/)
  if (!match) {
    return null
  }
  const value = Number.parseInt(match[1] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : null
}
