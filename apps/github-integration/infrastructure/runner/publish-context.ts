import type { IssueContext } from '../github/issue-service.js'
import type { PullRequestContext } from '../github/pull-request-service.js'
import type {
  SubmittedIssueReviewRun
} from '../../reviews/issues/submit.js'
import type {
  SubmittedPullRequestReviewRun
} from '../../reviews/pull-requests/submit.js'
import type {
  RepositoryContext,
  SubmittedRepositoryReviewRun
} from '../../reviews/repositories/submit.js'
import type { RepositoryScanTarget } from './input.js'

type JsonObject = Record<string, unknown>

export interface IssueReviewPublishContext {
  issue: IssueContext
  workspace_ref: string
  // Normalized review trigger; manual_review is an issue_comment command, not a GitHub action.
  event_type: 'opened' | 'manual_review'
}

export interface PullRequestReviewPublishContext {
  pr: PullRequestContext
  files: unknown[]
  // manual_review means someone asked for review in a PR comment; GitHub sends that as issue_comment.
  event_type: 'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
}

export interface RepositoryReviewPublishContext {
  repo: RepositoryContext
  workspace_ref: string
  scan_target: RepositoryScanTarget
  event_type: 'manual' | 'scheduled'
}

function isRecord (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function issueReviewPublishContext (
  submitted: SubmittedIssueReviewRun
): Record<string, unknown> {
  return {
    issue: submitted.issue as unknown as Record<string, unknown>,
    workspace_ref: submitted.workspace_ref,
    event_type: submitted.event_type
  }
}

export function pullRequestReviewPublishContext (
  submitted: SubmittedPullRequestReviewRun
): Record<string, unknown> {
  return {
    files: submitted.files,
    pr: submitted.pr as unknown as Record<string, unknown>,
    event_type: submitted.event_type
  }
}

export function repositoryReviewPublishContext (
  submitted: SubmittedRepositoryReviewRun
): Record<string, unknown> {
  return {
    repo: submitted.repo as unknown as Record<string, unknown>,
    workspace_ref: submitted.workspace_ref,
    scan_target: submitted.scan_target as unknown as Record<string, unknown>,
    event_type: submitted.event_type
  }
}

export function parseIssueReviewPublishContext (
  value: JsonObject
): IssueReviewPublishContext {
  const issue = isRecord(value.issue) ? value.issue : null
  if (issue === null) {
    throw new Error('Issue review publish context is missing issue.')
  }
  const workspace_ref = typeof value.workspace_ref === 'string' && value.workspace_ref.trim() !== ''
    ? value.workspace_ref.trim()
    : null
  if (workspace_ref === null) {
    throw new Error('Issue review publish context is missing workspace_ref.')
  }
  const rawEventType = typeof value.event_type === 'string' ? value.event_type.trim() : ''
  const event_type = rawEventType === 'opened' || rawEventType === 'manual_review'
    ? rawEventType
    : 'manual_review'

  return {
    issue: issue as unknown as IssueContext,
    workspace_ref,
    event_type
  }
}

export function parsePullRequestReviewPublishContext (
  value: JsonObject
): PullRequestReviewPublishContext {
  const pr = isRecord(value.pr) ? value.pr : null
  if (pr === null) {
    throw new Error('Pull request review publish context is missing pr.')
  }
  const rawEventType = typeof value.event_type === 'string' ? value.event_type.trim() : ''
  const event_type = ['opened', 'ready_for_review', 'synchronize', 'manual_review'].includes(rawEventType)
    ? rawEventType as PullRequestReviewPublishContext['event_type']
    : 'manual_review'

  return {
    pr: pr as unknown as PullRequestContext,
    files: Array.isArray(value.files) ? value.files : [],
    event_type
  }
}

export function parseRepositoryReviewPublishContext (
  value: JsonObject
): RepositoryReviewPublishContext {
  const repo = isRecord(value.repo) ? value.repo : null
  if (repo === null) {
    throw new Error('Repository review publish context is missing repo.')
  }
  const workspace_ref = typeof value.workspace_ref === 'string' && value.workspace_ref.trim() !== ''
    ? value.workspace_ref.trim()
    : null
  if (workspace_ref === null) {
    throw new Error('Repository review publish context is missing workspace_ref.')
  }
  const scan_target = isRecord(value.scan_target) ? value.scan_target : null
  if (scan_target === null) {
    throw new Error('Repository review publish context is missing scan_target.')
  }
  const rawEventType = typeof value.event_type === 'string' ? value.event_type.trim() : ''
  const event_type = rawEventType === 'manual' || rawEventType === 'scheduled'
    ? rawEventType
    : 'manual'

  return {
    repo: repo as unknown as RepositoryContext,
    workspace_ref,
    scan_target: scan_target as unknown as RepositoryScanTarget,
    event_type
  }
}
