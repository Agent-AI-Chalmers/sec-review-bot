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
  // `uncertain` is not terminal: a recovery will resolve it to queued or failed.
  if (run.execution.status === 'failed' || run.execution.status === 'skipped')
    return true
  return (
    run.execution.status === 'succeeded' &&
    ['published', 'failed', 'skipped'].includes(run.publication.status)
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
  // Whichever axis was written most recently. Each axis reports its own write time, so a
  // preparation being built or a publication that is still running keeps advancing here even
  // though the phase bounds (`started_at`, `finished_at`) intentionally do not. Preparation is
  // included because it is the only axis that moves while execution is still `pending`, and
  // without it a long preparation would freeze the column at the run's creation time.
  return [run.preparation.updated_at, run.execution.updated_at, run.publication.updated_at]
    .reduce((latest, value) =>
      Date.parse(value) > Date.parse(latest) ? value : latest
    )
}

export function abbreviateDigest(digest: string): string {
  return abbreviate(digest.replace(/^sha256:/, ''), 12, 12)
}

export function isDownloadableArtifact(
  value: ArtifactStorage | null
): value is ArtifactStorage & {
  status: 'available'
  artifact: NonNullable<ArtifactStorage['artifact']>
} {
  return value?.status === 'available' && value.artifact !== undefined
}

/** Names the failure when the backend distinguished it, instead of reporting every
 * failure as one generic sentence. */
export function failureReason(
  error: unknown,
  t: Translator
): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code === 'control_plane_timeout') return t('errorTimeout')
  if (error.code === 'control_plane_unavailable') return t('errorUnreachable')
  return error.status >= 500
    ? `${t('errorUpstream')} (${error.status})`
    : undefined
}

/** A finished phase reports how long it took; an in-flight one reports how long it has
 * been in that state — a fact about the clock, not about the stored timestamps. */
/** Elapsed time of a phase measured from its real start.
 *
 * `endAt` is the phase's completion time, or null while it is still running. The start is the
 * phase's own start (execution: `execution.started_at`, not `created_at`), so a phase that has
 * not begun is never timed and a running phase counts from when it actually began. */
export function phaseElapsed(
  startAt: string,
  endAt: string | null,
  t: Translator
): string {
  return endAt !== null
    ? `${t('took')} ${formatDuration(Date.parse(endAt) - Date.parse(startAt), t)}`
    : `${t('soFar')} ${formatDuration(Date.now() - Date.parse(startAt), t)}`
}

/** How long ago the run's state was last observed, for the states that are learned by polling.
 *
 * While a run is `queued` or `running`, the only writer of `execution.updated_at` is the
 * observation heartbeat, so its age is how long ago we last confirmed the state. Outside those
 * states nothing is polling, so there is no freshness to report and this returns null. */
export function observationAgeMs(
  run: Run,
  now: number = Date.now()
): number | null {
  if (run.execution.status !== 'queued' && run.execution.status !== 'running')
    return null
  return Math.max(0, now - Date.parse(run.execution.updated_at))
}

/** A polled state is stale once we have not confirmed it for a while (the coordinator polls
 * every few seconds; two minutes without a confirmation means something is wrong). */
export const STALE_OBSERVATION_MS = 120_000

export function isObservationStale(
  run: Run,
  now: number = Date.now()
): boolean {
  const age = observationAgeMs(run, now)
  return age !== null && age > STALE_OBSERVATION_MS
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
  if (seconds > 0 || parts.length === 0)
    parts.push(`${seconds}${t('durationSeconds')}`)
  return parts.slice(0, 2).join(' ')
}
