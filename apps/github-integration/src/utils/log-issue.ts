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

export function logIssuePayload (payload: unknown): void {
  const rawPayload = asRecord(payload)
  const repository = asRecord(rawPayload.repository)
  const sender = asRecord(rawPayload.sender)
  const issue = asRecord(rawPayload.issue)
  const issueUser = asRecord(issue.user)

  const issue_number = displayNumber(issue.number)
  const issue_title = displayString(issue.title)
  const issue_author = asString(issueUser.login, '') || undefined
  const repo_full_name = displayString(repository.full_name)
  const action = displayString(rawPayload.action)
  const sender_login = asString(sender.login, '') || undefined
  const labels = Array.isArray(issue.labels)
    ? issue.labels
      .map((label) => label?.name)
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
    : []

  logInfo('webhook_received_completed', {
    action,
    author: issue_author,
    event: 'issues',
    issue: issue_number,
    labels,
    repo: repo_full_name,
    sender: sender_login,
    state: displayString(issue.state),
    title: issue_title
  })
}
