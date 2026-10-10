import { ApiError, type ArtifactStorage, type Run } from './api.js'
import type { Message } from './i18n.js'

type Translator = (key: Message) => string

export function workflowLabel(workflow: string, t: Translator): string {
  if (workflow === 'issue-review') return t('workflowIssueReview')
  if (workflow === 'pull-request-review') return t('workflowPullRequestReview')
  if (workflow === 'repository-review') return t('workflowRepositoryReview')
  return workflow
}

export function safeExternalUrl(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function isRunTerminal(run: Run): boolean {
  if (run.execution_status === 'failed') return true
  return (
    run.execution_status === 'succeeded' &&
    ['published', 'failed', 'skipped'].includes(run.publication_status)
  )
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function abbreviate(value: string, head: number, tail: number): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function lastActivity(run: Run): string {
  return Date.parse(run.publication_updated_at) > Date.parse(run.execution_updated_at)
    ? run.publication_updated_at
    : run.execution_updated_at
}

export function abbreviateDigest(digest: string): string {
  return abbreviate(digest.replace(/^sha256:/, ''), 12, 12)
}

export function isDownloadableArtifact(value: ArtifactStorage | null): value is ArtifactStorage & {
  status: 'available'
  artifact: NonNullable<ArtifactStorage['artifact']>
} {
  return value?.status === 'available' && value.artifact !== undefined
}

/** Names the failure when the backend distinguished it, instead of reporting every
 * failure as one generic sentence. */
export function failureReason(error: unknown, t: Translator): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code === 'control_plane_timeout') return t('errorTimeout')
  if (error.code === 'control_plane_unavailable') return t('errorUnreachable')
  return error.status >= 500 ? `${t('errorUpstream')} (${error.status})` : undefined
}

/** A finished phase reports how long it took; an in-flight one reports how long it has
 * been in that state — a fact about the clock, not about the stored timestamps. */
export function phaseElapsed(
  updatedAt: string,
  createdAt: string,
  finished: boolean,
  t: Translator
): string {
  return finished
    ? `${t('took')} ${formatDuration(Date.parse(updatedAt) - Date.parse(createdAt), t)}`
    : `${t('soFar')} ${formatDuration(Date.now() - Date.parse(updatedAt), t)}`
}

/** Compact elapsed time, e.g. `2m 33s` or `1h 4m`. */
export function formatDuration(milliseconds: number, t: Translator): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}${t('durationDays')}`)
  if (hours > 0) parts.push(`${hours}${t('durationHours')}`)
  if (minutes > 0) parts.push(`${minutes}${t('durationMinutes')}`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}${t('durationSeconds')}`)
  return parts.slice(0, 2).join(' ')
}
