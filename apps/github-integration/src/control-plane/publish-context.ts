/**
 * Defines the persisted context needed to publish completed review runs.
 *
 * The original webhook or Actions request has ended before publication begins,
 * so this module projects request-time objects into a small recovery record.
 * It validates that record both before persistence and after database reads.
 *
 * GitHub webhook or Actions dispatch
 *   -> prepare agent input and persist publish context
 *   -> submit the run to the Python Runner / agent
 *   -> end the original HTTP request
 *   -> retrieve the agent result later
 *   -> combine the result with publish context
 *   -> publish a comment, review, or repair PR to GitHub
 *
 * Agent results describe what to publish. Publish context identifies where and
 * under which trigger context the result should be published to GitHub. It is
 * an internal recovery record, not a copy of the original request payload.
 */
import type { SubmittedIssueReviewRun } from '../reviews/issues/submit.js'
import type { SubmittedPullRequestReviewRun } from '../reviews/pull-requests/submit.js'
import type { SubmittedRepositoryReviewRun } from '../reviews/repositories/submit.js'
import { splitRepoFullName } from '../github/repository-service.js'
import { DeterministicRunnerPublishError } from '../runner/publish-error.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../runner/publish-error-code.js'

type JsonObject = Record<string, unknown>

export interface PersistedIssue {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
  issue_number: number
  issue_title: string
}

export interface PersistedPullRequest {
  owner_login: string
  repo_name: string
  repo_full_name: string
  pr_number: number
  pr_author: string | null
  head_sha: string
}

export interface PersistedPullRequestFile {
  filename: string
  patch?: string | null
}

export interface PersistedRepository {
  owner_login: string
  repo_name: string
  repo_full_name: string
  default_branch: string
}

export interface PersistedRepositoryScanTarget {
  target_branch: string
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string
}

export interface IssueReviewPublishContext extends JsonObject {
  issue: PersistedIssue
  workspace_ref: string
  event_type: 'opened' | 'manual_review'
}

export interface PullRequestReviewPublishContext extends JsonObject {
  pr: PersistedPullRequest
  files: PersistedPullRequestFile[]
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}

export interface RepositoryReviewPublishContext extends JsonObject {
  repo: PersistedRepository
  workspace_ref: string
  scan_target: PersistedRepositoryScanTarget
  event_type: 'manual' | 'scheduled'
}

export type PublishContext =
  IssueReviewPublishContext | PullRequestReviewPublishContext | RepositoryReviewPublishContext

function invalid(path: string, expectation: string): never {
  // Stored corruption cannot be repaired by another publication attempt.
  throw new DeterministicRunnerPublishError(
    `Persisted publish context is invalid at ${path}: expected ${expectation}.`,
    RUNNER_PUBLISH_ERROR_CODES.publish_context_invalid
  )
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'an object')
  }
  return value as JsonObject
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(path, 'a non-empty string')
  }
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(path, 'a positive integer')
  }
  return value
}

function nullableText(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== 'string') invalid(path, 'a string or null')
  return value as string | null
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalid(path, allowed.map((item) => JSON.stringify(item)).join(' or '))
  }
  return value as T
}

function repositoryIdentity(
  value: JsonObject,
  path: string
): Pick<PersistedRepository, 'owner_login' | 'repo_name' | 'repo_full_name'> {
  const owner_login = text(value.owner_login, `${path}.owner_login`)
  const repo_name = text(value.repo_name, `${path}.repo_name`)
  const repo_full_name = text(value.repo_full_name, `${path}.repo_full_name`)
  let fullNameParts: { owner_login: string; repo_name: string }
  try {
    fullNameParts = splitRepoFullName(repo_full_name)
  } catch {
    return invalid(`${path}.repo_full_name`, 'a valid GitHub owner/repository name')
  }

  // GitHub repository identity is case-insensitive. All three stored fields must
  // still name the same repository because different consumers use each form.
  if (
    fullNameParts.owner_login.toLowerCase() !== owner_login.toLowerCase() ||
    fullNameParts.repo_name.toLowerCase() !== repo_name.toLowerCase()
  ) {
    return invalid(`${path}.repo_full_name`, `the same repository as ${owner_login}/${repo_name}`)
  }
  return { owner_login, repo_name, repo_full_name }
}

function issue(value: unknown): PersistedIssue {
  const item = object(value, 'publish_context.issue')
  return {
    ...repositoryIdentity(item, 'publish_context.issue'),
    default_branch: text(item.default_branch, 'publish_context.issue.default_branch'),
    issue_number: positiveInteger(item.issue_number, 'publish_context.issue.issue_number'),
    issue_title: text(item.issue_title, 'publish_context.issue.issue_title')
  }
}

function pullRequest(value: unknown): PersistedPullRequest {
  const item = object(value, 'publish_context.pr')
  return {
    ...repositoryIdentity(item, 'publish_context.pr'),
    pr_number: positiveInteger(item.pr_number, 'publish_context.pr.pr_number'),
    pr_author: nullableText(item.pr_author, 'publish_context.pr.pr_author'),
    head_sha: text(item.head_sha, 'publish_context.pr.head_sha')
  }
}

function pullRequestFile(value: unknown, index: number): PersistedPullRequestFile {
  const path = `publish_context.files[${index}]`
  const item = object(value, path)
  const patch = item.patch
  if (patch !== undefined && patch !== null && typeof patch !== 'string') {
    invalid(`${path}.patch`, 'a string or null when present')
  }
  return {
    filename: text(item.filename, `${path}.filename`),
    ...(patch === undefined ? {} : { patch: patch as string | null })
  }
}

function repository(value: unknown): PersistedRepository {
  const item = object(value, 'publish_context.repo')
  return {
    ...repositoryIdentity(item, 'publish_context.repo'),
    default_branch: text(item.default_branch, 'publish_context.repo.default_branch')
  }
}

function scanTarget(value: unknown): PersistedRepositoryScanTarget {
  const item = object(value, 'publish_context.scan_target')
  return {
    target_branch: text(item.target_branch, 'publish_context.scan_target.target_branch'),
    scan_mode: oneOf(item.scan_mode, 'publish_context.scan_target.scan_mode', [
      'full',
      'incremental'
    ]),
    base_sha: nullableText(item.base_sha, 'publish_context.scan_target.base_sha'),
    head_sha: text(item.head_sha, 'publish_context.scan_target.head_sha')
  }
}

export function issueReviewPublishContext(
  submitted: SubmittedIssueReviewRun
): IssueReviewPublishContext {
  return parseIssueReviewPublishContext({
    issue: submitted.issue,
    workspace_ref: submitted.workspace_ref,
    event_type: submitted.event_type
  })
}

export function pullRequestReviewPublishContext(
  submitted: SubmittedPullRequestReviewRun
): PullRequestReviewPublishContext {
  return parsePullRequestReviewPublishContext({
    pr: submitted.pr,
    files: submitted.files,
    event_type: submitted.event_type
  })
}

export function repositoryReviewPublishContext(
  submitted: SubmittedRepositoryReviewRun
): RepositoryReviewPublishContext {
  return parseRepositoryReviewPublishContext({
    repo: submitted.repo,
    workspace_ref: submitted.workspace_ref,
    scan_target: submitted.scan_target,
    event_type: submitted.event_type
  })
}

// Parse again after a database read. TypeScript types disappear at persistence
// boundaries, and a malformed recovery record must fail before any GitHub call.
export function parseIssueReviewPublishContext(value: unknown): IssueReviewPublishContext {
  const context = object(value, 'publish_context')
  return {
    issue: issue(context.issue),
    workspace_ref: text(context.workspace_ref, 'publish_context.workspace_ref'),
    event_type: oneOf(context.event_type, 'publish_context.event_type', ['opened', 'manual_review'])
  }
}

export function parsePullRequestReviewPublishContext(
  value: unknown
): PullRequestReviewPublishContext {
  const context = object(value, 'publish_context')
  if (!Array.isArray(context.files)) invalid('publish_context.files', 'an array')
  return {
    pr: pullRequest(context.pr),
    files: context.files.map(pullRequestFile),
    event_type: oneOf(context.event_type, 'publish_context.event_type', [
      'opened',
      'ready_for_review',
      'synchronize',
      'manual_review'
    ])
  }
}

export function parseRepositoryReviewPublishContext(
  value: unknown
): RepositoryReviewPublishContext {
  const context = object(value, 'publish_context')
  return {
    repo: repository(context.repo),
    workspace_ref: text(context.workspace_ref, 'publish_context.workspace_ref'),
    scan_target: scanTarget(context.scan_target),
    event_type: oneOf(context.event_type, 'publish_context.event_type', ['manual', 'scheduled'])
  }
}

export function parsePublishContextForWorkflow(workflow: string, value: unknown): PublishContext {
  if (workflow === 'issue-review') return parseIssueReviewPublishContext(value)
  if (workflow === 'pull-request-review') return parsePullRequestReviewPublishContext(value)
  if (workflow === 'repository-review') return parseRepositoryReviewPublishContext(value)
  return invalid('workflow', 'a supported review workflow')
}
