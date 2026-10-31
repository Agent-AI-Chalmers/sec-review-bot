// Connector-owned durable input: producers and recovery share the same shape.
import type { IssueContext } from '../github/issue-service.js'
import type { PullRequestContext } from '../github/pull-request-service.js'
import type { TrustedDefaultBranch } from '../github/default-branch-service.js'
import type { TestChangesPolicy } from '../execution/input.js'
import { isRecord } from '../utils/error-utils.js'
import { InvalidPreparationInputError } from './preparation-failure.js'

export type IssueReviewEventType = 'opened' | 'manual_review'
export type PullRequestReviewEventType =
  'opened' | 'ready_for_review' | 'synchronize' | 'manual_review'
export type PullRequestReference = Pick<
  PullRequestContext,
  'owner_login' | 'repo_name' | 'pr_number'
>

export type IssuePreparationInput = {
  kind: 'github_issue_review'
  issue: IssueContext
  trusted_default_branch: TrustedDefaultBranch
  event_type: IssueReviewEventType
  review_objective: 'audit' | 'repair' | null
  test_changes: TestChangesPolicy | null
  open_pr: boolean | null
}

export type PullRequestPreparationInput = {
  kind: 'github_pull_request_review'
  trusted_default_branch: TrustedDefaultBranch
  event_type: PullRequestReviewEventType
  test_changes: TestChangesPolicy | null
} & (
  | { pr: PullRequestContext; pr_reference?: never }
  | { pr_reference: PullRequestReference; pr?: never }
)

export function parseRepositoryPreparationInput(value: unknown): {
  payload: Record<string, unknown>
  verified_repository: string
} {
  const input = requireRecord(value, 'object')
  return {
    payload: requireRecord(input.payload, 'payload'),
    verified_repository: requireText(
      input.verified_repository,
      'verified_repository'
    )
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new InvalidPreparationInputError(
      `Preparation input has an invalid ${label}.`
    )
  return value
}

function optionalLogin(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireText(value, label)
}

function requireChoice<const T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string
): T {
  for (const choice of choices) if (value === choice) return choice
  throw new InvalidPreparationInputError(
    `Preparation input has an invalid ${label}.`
  )
}

function requireTestChanges(value: unknown): TestChangesPolicy | null {
  return value === null
    ? null
    : requireChoice(value, ['allow', 'deny'], 'test_changes')
}

export function parseIssuePreparationInput(
  value: unknown
): IssuePreparationInput {
  const input = requireRecord(value, 'object')
  return {
    kind: requireChoice(input.kind, ['github_issue_review'], 'kind'),
    issue: requireIssueContext(input.issue),
    trusted_default_branch: requireTrustedDefaultBranch(
      input.trusted_default_branch
    ),
    event_type: requireChoice(
      input.event_type,
      ['opened', 'manual_review'],
      'event_type'
    ),
    review_objective:
      input.review_objective === null
        ? null
        : requireChoice(
            input.review_objective,
            ['audit', 'repair'],
            'review_objective'
          ),
    test_changes: requireTestChanges(input.test_changes),
    open_pr:
      input.open_pr === null
        ? null
        : requireBooleanField(input, 'open_pr', 'input')
  }
}

export function parsePullRequestPreparationInput(
  value: unknown
): PullRequestPreparationInput {
  const input = requireRecord(value, 'object')
  const common = {
    kind: requireChoice(input.kind, ['github_pull_request_review'], 'kind'),
    trusted_default_branch: requireTrustedDefaultBranch(
      input.trusted_default_branch
    ),
    event_type: requireChoice(
      input.event_type,
      ['opened', 'ready_for_review', 'synchronize', 'manual_review'],
      'event_type'
    ),
    test_changes: requireTestChanges(input.test_changes)
  }
  // Existing checkpoints carry both fields. Their captured snapshot is authoritative.
  if (input.pr !== undefined)
    return { ...common, pr: requirePersistedPullRequest(input.pr) }
  const reference = requireRecord(input.pr_reference, 'pr_reference')
  const pr_number = requireNumberField(reference, 'pr_number', 'pr_reference')
  if (!Number.isInteger(pr_number) || pr_number <= 0)
    throw new InvalidPreparationInputError(
      'Preparation input has an invalid pr_reference.pr_number.'
    )
  return {
    ...common,
    pr_reference: {
      owner_login: requireStringField(reference, 'owner_login', 'pr_reference'),
      repo_name: requireStringField(reference, 'repo_name', 'pr_reference'),
      pr_number
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.`
    )
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.`
    )
  return value
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  label: string
): string {
  return requireText(record[field], `${label}.${field}`)
}

function requireNumberField(
  record: Record<string, unknown>,
  field: string,
  label: string
): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.${field}`
    )
  return value
}

function requireBooleanField(
  record: Record<string, unknown>,
  field: string,
  label: string
): boolean {
  const value = record[field]
  if (typeof value !== 'boolean')
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.${field}`
    )
  return value
}

/** The issue fields the recovered issue-review path reads. */
function requireIssueContext(value: unknown, label = 'issue'): IssueContext {
  const record = requireRecord(value, label)
  // JSON omits undefined logins produced by extractIssueContext.
  const sender_login = optionalLogin(
    record.sender_login,
    `${label}.sender_login`
  )
  const issue_author = optionalLogin(
    record.issue_author,
    `${label}.issue_author`
  )
  const issue_body = record.issue_body
  if (issue_body !== null && typeof issue_body !== 'string')
    throw new InvalidPreparationInputError(
      `Preparation input has an invalid ${label}.issue_body`
    )
  const labels = record.labels
  if (
    !Array.isArray(labels) ||
    !labels.every((item): item is string => typeof item === 'string')
  )
    throw new InvalidPreparationInputError(
      `Preparation input is missing ${label}.labels`
    )
  return {
    action: requireString(record['action'], `${label}.action`),
    repo_name: requireStringField(record, 'repo_name', label),
    repo_full_name: requireStringField(record, 'repo_full_name', label),
    owner_login: requireStringField(record, 'owner_login', label),
    sender_login,
    default_branch: requireStringField(record, 'default_branch', label),
    issue_number: requireNumberField(record, 'issue_number', label),
    issue_title: requireStringField(record, 'issue_title', label),
    issue_body,
    issue_author,
    issue_state: requireStringField(record, 'issue_state', label),
    labels,
    html_url: requireString(record['html_url'], `${label}.html_url`),
    api_url: requireString(record['api_url'], `${label}.api_url`),
    comments_url: requireString(
      record['comments_url'],
      `${label}.comments_url`
    ),
    is_pull_request: requireBooleanField(record, 'is_pull_request', label)
  }
}

/**
 * The pull request fields a recovered run reads.
 *
 * This is the parsed webhook payload shape that admission persists, not the
 * review subject: the subject is a preparation output (it carries the resolved
 * window and the commit list), while this input exists before preparation
 * starts. They are separate lifecycles and must not share a validator.
 */
function requirePersistedPullRequest(
  value: unknown,
  label = 'pr'
): PullRequestContext {
  const record = requireRecord(value, label)
  return {
    action: requireString(record['action'], `${label}.action`),
    previous_head_sha: optionalStringOrNull(record, 'previous_head_sha', label),
    repo_name: requireStringField(record, 'repo_name', label),
    repo_full_name: requireStringField(record, 'repo_full_name', label),
    owner_login: requireStringField(record, 'owner_login', label),
    sender_login: optionalStringOrNull(record, 'sender_login', label),
    pr_number: requireNumberField(record, 'pr_number', label),
    pr_title: requireStringField(record, 'pr_title', label),
    pr_body: optionalStringOrNull(record, 'pr_body', label),
    pr_author: optionalStringOrNull(record, 'pr_author', label),
    is_draft: requireBooleanField(record, 'is_draft', label),
    base_ref: requireStringField(record, 'base_ref', label),
    base_sha: requireStringField(record, 'base_sha', label),
    head_ref: requireStringField(record, 'head_ref', label),
    head_sha: requireStringField(record, 'head_sha', label),
    commits: requireNumberField(record, 'commits', label),
    changed_files: requireNumberField(record, 'changed_files', label),
    additions: requireNumberField(record, 'additions', label),
    deletions: requireNumberField(record, 'deletions', label),
    html_url: requireString(record['html_url'], `${label}.html_url`),
    api_url: requireString(record['api_url'], `${label}.api_url`),
    commits_url: requireString(record['commits_url'], `${label}.commits_url`),
    review_comments_url: requireString(
      record.review_comments_url,
      `${label}.review_comments_url`
    ),
    comments_url: requireString(
      record['comments_url'],
      `${label}.comments_url`
    ),
    issue_url: requireString(record['issue_url'], `${label}.issue_url`),
    head_repo_full_name: optionalStringOrNull(
      record,
      'head_repo_full_name',
      label
    ),
    base_repo_full_name: optionalStringOrNull(
      record,
      'base_repo_full_name',
      label
    ),
    from_fork: requireBooleanField(record, 'from_fork', label)
  }
}
function optionalStringOrNull(
  record: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const value = record[field]
  if (value !== null && typeof value !== 'string')
    throw new InvalidPreparationInputError(
      `Preparation input has an invalid ${label}.${field}`
    )
  return value
}

/** The two fields a trusted default branch is made of. */
function requireTrustedDefaultBranch(
  value: unknown,
  label = 'trusted_default_branch'
): TrustedDefaultBranch {
  const record = requireRecord(value, label)
  return {
    default_branch: requireStringField(record, 'default_branch', label),
    head_sha: requireStringField(record, 'head_sha', label)
  }
}
