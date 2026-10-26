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

/** Whether this parked run can be handed back to automatic recovery.
 *
 * Mirrors the server's rule rather than approximating it. Two things must hold, and the second
 * is the one that is easy to miss: a resumable axis alone is not enough, because axes can be
 * parked *together*. A run whose preparation and execution both disconnected would otherwise
 * look resumable through its execution while the preparation axis makes the resume a no-op.
 *
 * - No second parked axis may be in the way. Preparation parks only by contradicting execution,
 *   so a run with a disconnected preparation can never resume its execution or publication.
 * - The axis asked about must itself be resumable: an execution replays its persisted input, a
 *   publication re-claims without repeating side effects, and a preparation is taken only while
 *   execution is still pending - the claim path will not accept it otherwise, so resuming would
 *   leave the row stalled and invisible, which is worse than the parked state it replaced.
 *
 * Offering a button the server answers with 409 teaches an operator that the decision existed. */
export function canResumeRun(run: Run): boolean {
  if (run.preparation.status === 'disconnected') {
    return run.execution.status === 'pending'
  }
  if (run.execution.status === 'disconnected') return true
  if (run.publication.status === 'disconnected') return true
  return false
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
  return [
    run.preparation.updated_at,
    run.execution.updated_at,
    run.publication.updated_at
  ].reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest
  )
}

export function abbreviateDigest(digest: string): string {
  return abbreviate(digest.replace(/^sha256:/, ''), 12, 12)
}

/** Narrows a run's artifact record to the `available` arm of the contract's union, where the
 * artifact reference is guaranteed. The contract makes `available` the only status that carries
 * `artifact`, so the predicate can rely on the status alone. */
export function isDownloadableArtifact(
  value: ArtifactStorage | null
): value is Extract<NonNullable<ArtifactStorage>, { status: 'available' }> {
  return value?.status === 'available'
}

/** The failure codes coordination itself assigns, and what each one means for the operator.
 *
 * The set is open: a connector may report its own code, and those are shown verbatim because the
 * console cannot know what they mean. These are the ones Review Runs writes, so leaving
 * them unexplained would make an operator read `PREPARATION_RETRY_EXHAUSTED` as jargon when the
 * console already knows the sentence behind it. */
export const KNOWN_FAILURE_CODE_KEYS: Readonly<Record<string, Message>> = {
  PREPARATION_RETRY_EXHAUSTED: 'failureCodePreparationRetryExhausted',
  PREPARATION_ABANDONED: 'failureCodePreparationAbandoned',
  EXECUTION_ALREADY_ADVANCED: 'failureCodeExecutionAlreadyAdvanced',
  SUBMISSION_STATE_UNCERTAIN: 'failureCodeSubmissionUncertain',
  SUBMISSION_RECOVERY_EXHAUSTED: 'failureCodeSubmissionRecoveryExhausted',
  SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR:
    'failureCodeSubmissionRecoveryAbandoned',
  PREPARATION_GIVEN_UP_BY_OPERATOR: 'failureCodePreparationGivenUp',
  PUBLICATION_ABANDONED_BY_OPERATOR: 'failureCodePublicationGivenUp',
  EXECUTION_FAILED: 'failureCodeExecutionFailed',
  EXECUTION_RESULT_MISSING: 'failureCodeExecutionResultMissing',
  PUBLICATION_ABANDONED: 'failureCodePublicationAbandoned',
  PUBLICATION_STEP_RETRY_EXHAUSTED: 'failureCodePublicationStepRetryExhausted',
  GITHUB_VALIDATION_REJECTED: 'failureCodeGithubValidationRejected'
}

/** The message to show when abandoning a blocked run fails.
 *
 * The abandon route can answer 401 for three unrelated reasons: the BFF rejected the supplied
 * admin token (`admin_token_required`), the operator's session cookie is no longer valid
 * (`unauthorized`, emitted by the BFF's own /api/* gate), or Review Runs itself answered
 * 401 and the BFF proxied that status through. Only the first means the token was wrong; the
 * others would send the operator to re-type a token that was fine. */
export function abandonFailureMessageKey(error: unknown): Message {
  if (!(error instanceof ApiError)) return 'abandonFailed'
  if (error.code === 'admin_token_required') return 'abandonWrongToken'
  if (error.code === 'unauthorized') return 'sessionExpired'
  return 'abandonFailed'
}

/** Explain a failure code, or return the code itself when it is not one coordination assigns.
 *
 * `explanation` is null whenever there is no sentence to show, including when a code has a key
 * but the active language table lacks it. Testing the mapping alone was not enough: `t()` returns
 * `undefined` for a key that is not in the table, and a caller that checks only for null would
 * render an empty tooltip instead of falling back to the bare code. */
export function failureCodeLabel(
  code: string,
  t: Translator
): { code: string; explanation: string | null } {
  const key = KNOWN_FAILURE_CODE_KEYS[code]
  return {
    code,
    explanation: key === undefined ? null : (t(key) ?? null)
  }
}

/** Names the failure when the backend distinguished it, instead of reporting every
 * failure as one generic sentence. */
export function failureReason(
  error: unknown,
  t: Translator
): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code === 'review_runs_timeout') return t('errorTimeout')
  if (error.code === 'review_runs_unavailable') return t('errorUnreachable')
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
