import { logInfo } from './logger.js'

function asRecord (value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString (value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function displayString (value: unknown): string {
  const text = asString(value).trim()
  return text || '(missing)'
}

function displayNumber (value: unknown): number | string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : '(missing)'
}

function asBoolean (value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function logPullRequestPayload (payload: unknown): void {
  const rawPayload = asRecord(payload)
  const repository = asRecord(rawPayload.repository)
  const sender = asRecord(rawPayload.sender)
  const pullRequest = asRecord(rawPayload.pull_request)
  const pullRequestUser = asRecord(pullRequest.user)
  const pullRequestBase = asRecord(pullRequest.base)
  const pullRequestHead = asRecord(pullRequest.head)
  const pullRequestBaseRepo = asRecord(pullRequestBase.repo)
  const pullRequestHeadRepo = asRecord(pullRequestHead.repo)

  const pr_number = displayNumber(pullRequest.number)
  const pr_title = displayString(pullRequest.title)
  const pr_author = asString(pullRequestUser.login, '') || undefined
  const repo_full_name = displayString(repository.full_name)
  const action = displayString(rawPayload.action)
  const sender_login = asString(sender.login, '') || undefined

  const base_ref = displayString(pullRequestBase.ref)
  const head_ref = displayString(pullRequestHead.ref)
  const base_sha = displayString(pullRequestBase.sha)
  const head_sha = displayString(pullRequestHead.sha)
  const previous_head_sha = asString(rawPayload.before, '') || null

  const is_draft = asBoolean(pullRequest.draft)
  const changed_files = displayNumber(pullRequest.changed_files)
  const commits = displayNumber(pullRequest.commits)
  const additions = displayNumber(pullRequest.additions)
  const deletions = displayNumber(pullRequest.deletions)
  const from_fork = asString(pullRequestHeadRepo.full_name) !== asString(pullRequestBaseRepo.full_name)

  logInfo('webhook_received_completed', {
    action,
    additions,
    author: pr_author,
    base_ref: base_ref,
    base_sha: base_sha,
    changed_files: changed_files,
    commits,
    deletions,
    draft: is_draft,
    event: 'pull_request',
    from_fork: from_fork,
    head_ref: head_ref,
    head_sha: head_sha,
    previous_head_sha: previous_head_sha,
    pr: pr_number,
    repo: repo_full_name,
    sender: sender_login,
    title: pr_title
  })
}
