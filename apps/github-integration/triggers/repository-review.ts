import type { App } from 'octokit'

import type { GitHubAppOctokit } from '../infrastructure/github/octokit.js'
import { getRepositoryRefSha, splitRepoFullName } from '../infrastructure/github/repository-service.js'
import {
  startRepositoryReviewRun,
  type SubmittedRepositoryReviewRun
} from '../reviews/repositories/submit.js'
import type { RepairMode } from '../infrastructure/runner/input.js'
import { repositoryReviewPublishContext } from '../infrastructure/runner/publish-context.js'
import { runnerRunStore, type SaveRunnerRunArgs } from '../infrastructure/runner/run-store.js'
import { logInfo } from '../utils/logger.js'

export interface RepositoryReviewDispatchPayload {
  repo_full_name?: unknown
  target_branch?: unknown
  scan_mode?: unknown
  base_sha?: unknown
  head_sha?: unknown
  event_type?: unknown
  schedule?: unknown
  repair_mode?: unknown
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
  repair_mode: RepairMode | null
}

export function normalizeRepositoryReviewDispatchPayload (raw: unknown): RepositoryReviewDispatchPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {}
  }
  return raw as RepositoryReviewDispatchPayload
}

export async function resolveRepositoryReviewDispatch ({
  octokit,
  payload
}: {
  octokit: GitHubAppOctokit
  payload: RepositoryReviewDispatchPayload
}): Promise<ResolvedRepositoryReviewDispatch> {
  const repo_full_name = requiredString(payload.repo_full_name, 'repo_full_name')
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const target_branch = requiredString(payload.target_branch, 'target_branch')
  const event_type = normalizeRepositoryEventType(payload.event_type)
  const scan_mode = normalizeScanMode(payload.scan_mode, event_type)
  const repair_mode = normalizeRepairMode(payload.repair_mode)

  if (scan_mode !== 'incremental') {
    return {
      repo_full_name,
      target_branch,
      scan_mode,
      base_sha: null,
      head_sha: normalizeOptionalSha(payload.head_sha, 'head_sha'),
      event_type,
      repair_mode
    }
  }

  const head_sha = await resolveHeadSha({
    octokit,
    owner_login,
    repo_name,
    target_branch,
    head_sha: payload.head_sha
  })
  const base_sha = event_type === 'scheduled'
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
      base_sha: payload.base_sha
    })

  if (base_sha === head_sha) {
    throw new Error('incremental scan requires base_sha != head_sha.')
  }

  return {
    repo_full_name,
    target_branch,
    scan_mode,
    base_sha,
    head_sha,
    event_type,
    repair_mode
  }
}

export class RepositoryReviewDispatchValidationError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'RepositoryReviewDispatchValidationError'
  }
}

export interface DispatchRepositoryReviewCommandArgs {
  app: App
  payload: RepositoryReviewDispatchPayload
  deps?: Partial<DispatchRepositoryReviewCommandDeps>
}

interface DispatchRepositoryReviewCommandDeps {
  getInstallationOctokit: (repo_full_name: string) => Promise<GitHubAppOctokit>
  resolve_dispatch: typeof resolveRepositoryReviewDispatch
  submit_run: typeof startRepositoryReviewRun
  store: Pick<typeof runnerRunStore, 'save_queued_run'>
}

function asErrorMessage (error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

async function getRepositoryInstallationOctokit (app: App, repo_full_name: string): Promise<GitHubAppOctokit> {
  const { owner_login, repo_name } = splitRepoFullName(repo_full_name)
  const installation = await app.octokit.rest.apps.getRepoInstallation({
    owner: owner_login,
    repo: repo_name
  })
  return await app.getInstallationOctokit(installation.data.id) as unknown as GitHubAppOctokit
}

export async function dispatchRepositoryReview ({
  app,
  payload,
  deps = {}
}: DispatchRepositoryReviewCommandArgs): Promise<SubmittedRepositoryReviewRun> {
  const {
    getInstallationOctokit = async (repo_full_name) => getRepositoryInstallationOctokit(app, repo_full_name),
    resolve_dispatch = resolveRepositoryReviewDispatch,
    submit_run = startRepositoryReviewRun,
    store = runnerRunStore
  } = deps
  const repo_full_name = String(payload.repo_full_name ?? '').trim()
  const octokit = await getInstallationOctokit(repo_full_name)

  let resolved: Awaited<ReturnType<typeof resolveRepositoryReviewDispatch>>
  try {
    resolved = await resolve_dispatch({
      octokit,
      payload
    })
  } catch (error) {
    throw new RepositoryReviewDispatchValidationError(
      asErrorMessage(error) || 'Repository review dispatch request is invalid.'
    )
  }

  const submitted = await submit_run({
    octokit,
    ...resolved
  })

  const queuedRun: SaveRunnerRunArgs = {
    workflow: 'repository-review',
    run_id: submitted.run_id,
    publish_context: repositoryReviewPublishContext(submitted)
  }
  store.save_queued_run(queuedRun)

  logInfo('repository_review_dispatch_queued', {
    event: 'repository-review-dispatch',
    repo: resolved.repo_full_name,
    run_id: submitted.run_id,
    target_branch: resolved.target_branch ?? '(workflow-branch)',
    scan_mode: resolved.scan_mode,
    base_sha: resolved.base_sha ?? '(missing)',
    head_sha: resolved.head_sha ?? '(resolved-target-branch)',
    event_type: resolved.event_type,
    repair_mode: resolved.repair_mode ?? '(default)'
  })

  return submitted
}

function requiredString (value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new Error(`${label} is required.`)
  }
  return text
}

function optionalString (value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function normalizeScanMode (value: unknown, event_type: 'manual' | 'scheduled'): 'full' | 'incremental' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === '') {
    return event_type === 'scheduled' ? 'incremental' : 'full'
  }
  if (raw === 'full' || raw === 'incremental') {
    return raw
  }
  throw new Error(`Unsupported repository scan_mode: ${String(value)}`)
}

function normalizeRepositoryEventType (value: unknown): 'manual' | 'scheduled' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === '' || raw === 'manual') {
    return 'manual'
  }
  if (raw === 'scheduled') {
    return raw
  }
  throw new Error(`Unsupported repository event_type: ${String(value)}`)
}

function normalizeRepairMode (value: unknown): RepairMode | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    return null
  }
  if (raw === 'test-changes-allowed' || raw === 'no-test-changes') {
    return raw
  }
  throw new Error(`Unsupported repository repair_mode: ${String(value)}`)
}

function normalizeOptionalSha (value: unknown, label: string): string | null {
  const raw = optionalString(value)
  if (raw === null) {
    return null
  }
  return ensureLikelyGitSha(raw, label)
}

function ensureLikelyGitSha (value: string, label: string): string {
  if (!/^[a-f0-9]{7,40}$/i.test(value)) {
    throw new Error(`${label} must be a valid commit SHA (7-40 hex chars).`)
  }
  return value
}

async function resolveHeadSha ({
  octokit,
  owner_login,
  repo_name,
  target_branch,
  head_sha
}: {
  octokit: GitHubAppOctokit
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

async function resolveManualBaseSha ({
  octokit,
  owner_login,
  repo_name,
  base_sha
}: {
  octokit: GitHubAppOctokit
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

async function resolveScheduledBaseSha ({
  octokit,
  owner_login,
  repo_name,
  head_sha,
  schedule
}: {
  octokit: GitHubAppOctokit
  owner_login: string
  repo_name: string
  head_sha: string
  schedule: unknown
}): Promise<string> {
  // Scheduled scans derive base_sha by looking back roughly one schedule interval from head_sha.
  const rollbackDays = inferRollbackDaysFromCron(optionalString(schedule))
  const cutoff = new Date(Date.now() - rollbackDays * 24 * 60 * 60 * 1000).toISOString()
  const commits = await octokit.rest.repos.listCommits({
    owner: owner_login,
    repo: repo_name,
    sha: head_sha,
    until: cutoff,
    per_page: 1
  })
  const candidate = String(commits.data[0]?.sha ?? '').trim()
  if (!candidate || candidate === head_sha) {
    throw new Error(`scheduled incremental scan requires a resolvable base_sha before ${cutoff}.`)
  }
  return candidate
}

function inferRollbackDaysFromCron (expr: string | null): number {
  const parts = (expr || '').trim().split(/\s+/).filter((item) => item !== '')
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

function step (token: string | undefined): number | null {
  const match = String(token || '').match(/^\*\/([0-9]+)$/)
  if (!match) {
    return null
  }
  const value = Number.parseInt(match[1] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : null
}
