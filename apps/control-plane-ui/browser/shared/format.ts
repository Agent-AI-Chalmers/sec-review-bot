import { ApiError } from './api-client.js'
import type { Message } from './i18n.js'

type Translator = (key: Message) => string

export function workflowLabel(workflow: string, t: Translator): string {
  if (workflow === 'issue-review') return t('workflowIssueReview')
  if (workflow === 'pull-request-review') return t('workflowPullRequestReview')
  if (workflow === 'repository-review') return t('workflowRepositoryReview')
  return workflow
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function abbreviate(value: string, head: number, tail: number): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function failureReason(
  error: unknown,
  t: Translator
): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code === 'review_runs_timeout') return t('errorTimeout')
  if (error.code === 'review_runs_unavailable') return t('errorUnreachable')
  if (error.code === 'memory_catalog_timeout') return t('errorMemoryTimeout')
  if (error.code === 'memory_catalog_unavailable')
    return t('errorMemoryUnreachable')
  return error.status >= 500
    ? t('errorStatus').replace('{status}', String(error.status))
    : undefined
}
