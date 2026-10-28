import React from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconMinus,
  IconPlayerPlay
} from '@tabler/icons-react'
import { type ArtifactStorage, type Run } from './api.js'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'

export type PublicationStepStatus =
  | 'pending'
  | 'running'
  | 'uncertain'
  | 'disconnected'
  | 'succeeded'
  | 'failed'
  | 'terminal_failed'

type StatusTone = 'waiting' | 'active' | 'complete' | 'failed' | 'neutral'

export function statusToneColor(tone: StatusTone): string {
  if (tone === 'active') return 'blue'
  if (tone === 'complete') return 'green'
  if (tone === 'failed') return 'red'
  return 'gray'
}

function StatusText({
  label,
  tone
}: {
  label: string
  tone: StatusTone
}): React.JSX.Element {
  return (
    <span className="status-text">
      <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function executionTone(status: Run['execution']['status']): StatusTone {
  if (status === 'running') return 'active'
  // uncertain means a recovery is resolving a submission whose result is unknown.
  if (status === 'uncertain') return 'waiting'
  if (status === 'disconnected') return 'neutral'
  if (status === 'succeeded') return 'complete'
  if (status === 'failed') return 'failed'
  // skipped means execution never ran (preparation failed); it is neutral, not a failure of
  // execution itself.
  if (status === 'skipped') return 'neutral'
  return 'waiting'
}

export function preparationTone(preparation: Run['preparation']): StatusTone {
  if (preparation.status === 'preparing') return 'active'
  // The outcome is not known yet, but automation is still working on it.
  if (preparation.status === 'uncertain') return 'waiting'
  // Nothing will happen until a person acts, so it must not look busy or finished.
  if (preparation.status === 'disconnected') return 'neutral'
  if (preparation.status === 'submitted') return 'complete'
  if (preparation.status === 'failed') return 'failed'
  return 'waiting'
}

export function publicationTone(
  status: Run['publication']['status']
): StatusTone {
  if (status === 'publishing') return 'active'
  if (status === 'uncertain') return 'waiting'
  if (status === 'disconnected') return 'neutral'
  if (status === 'published') return 'complete'
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'waiting'
  return 'neutral'
}

export function ExecutionStatus({
  status
}: {
  status: Run['execution']['status']
}): React.JSX.Element {
  const t = useMessages()
  return (
    <StatusText
      label={executionStatusLabel(status, t)}
      tone={executionTone(status)}
    />
  )
}

export function PreparationStatus({
  preparation
}: {
  preparation: Run['preparation']
}): React.JSX.Element {
  const t = useMessages()
  return (
    <StatusText
      label={preparationStatusLabel(preparation, t)}
      tone={preparationTone(preparation)}
    />
  )
}

export function PublicationStatus({
  status
}: {
  status: Run['publication']['status']
}): React.JSX.Element {
  const t = useMessages()
  return (
    <StatusText
      label={runPublicationStatusLabel(status, t)}
      tone={publicationTone(status)}
    />
  )
}

export function statusBullet(tone: StatusTone): React.ReactNode {
  if (tone === 'active') return <IconPlayerPlay size={ICON_SIZE.sm} />
  if (tone === 'complete') return <IconCheck size={ICON_SIZE.sm} />
  if (tone === 'failed') return <IconAlertTriangle size={ICON_SIZE.sm} />
  if (tone === 'neutral') return <IconMinus size={ICON_SIZE.sm} />
  return <IconClock size={ICON_SIZE.sm} />
}

export function publicationStatusLabel(
  status: PublicationStepStatus,
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'running') return t('statusInProgress')
  if (status === 'succeeded') return t('publicationStepSucceeded')
  if (status === 'uncertain') return t('statusUncertain')
  if (status === 'disconnected') return t('statusDisconnected')
  if (status === 'failed') return t('retryPending')
  if (status === 'terminal_failed') return t('statusFailed')
  return status
}

export function publicationStatusColor(status: PublicationStepStatus): string {
  if (status === 'terminal_failed') return 'red'
  if (status === 'failed') return 'yellow'
  if (status === 'uncertain') return 'yellow'
  if (status === 'disconnected') return 'gray'
  if (status === 'running') return 'blue'
  if (status === 'pending') return 'gray'
  if (status === 'succeeded') return 'green'
  return 'gray'
}

export function executionStatusLabel(
  status: Run['execution']['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'queued') return t('statusQueued')
  if (status === 'running') return t('statusRunning')
  if (status === 'succeeded') return t('statusSucceeded')
  if (status === 'skipped') return t('statusSkipped')
  if (status === 'uncertain') return t('statusUncertain')
  if (status === 'disconnected') return t('statusDisconnected')
  return t('statusFailed')
}

/** The preparation states a run can be in, in the order the contract declares them. The list
 * filter and its labels are generated from this one array, so a state cannot be addable to
 * the contract and then silently miss the filter. */
export const PREPARATION_STATUSES = [
  'pending',
  'preparing',
  'submitted',
  'failed'
] as const

/** Every execution state the contract declares, in lifecycle order. Like
 * PREPARATION_STATUSES, the list filter is generated from one array so a state added to the
 * contract cannot be silently missing from the filter. */
export const EXECUTION_STATUSES = [
  'pending',
  'queued',
  'running',
  'uncertain',
  'disconnected',
  'succeeded',
  'skipped',
  'failed'
] as const satisfies readonly Run['execution']['status'][]

export function preparationStateLabel(
  status: NonNullable<Run['preparation']>['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'preparing') return t('statusPreparing')
  if (status === 'uncertain') return t('statusUncertain')
  if (status === 'disconnected') return t('statusDisconnected')
  if (status === 'submitted') return t('statusSubmitted')
  return t('statusFailed')
}

/** Human label for a coordination axis.
 *
 * An unrecognised axis renders as its raw value rather than as some other axis' label, so a
 * mismatch is visible instead of being presented as a plausible-looking history.
 */
export type CoordinationAxis = 'execution' | 'preparation' | 'publication'

export function axisLabel(
  axis: CoordinationAxis,
  t: ReturnType<typeof useMessages>
): string {
  switch (axis) {
    case 'execution':
      return t('axisExecution')
    case 'preparation':
      return t('axisPreparation')
    case 'publication':
      return t('axisPublication')
    default:
      return String(axis)
  }
}

export function preparationStatusLabel(
  preparation: Run['preparation'],
  t: ReturnType<typeof useMessages>
): string {
  // `disconnected` is a state of its own now, so the stalled case needs no derived wording here.
  return preparationStateLabel(preparation.status, t)
}

export function runPublicationStatusLabel(
  status: Run['publication']['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'publishing') return t('statusPublishing')
  // Mid-phase states: the publication started and is waiting on a step's outcome. Falling
  // through to "Skipped" (as the catch-all below used to) said nothing was published, which is
  // the opposite of what these states mean and contradicted the succeeded steps on the page.
  if (status === 'uncertain') return t('statusUncertain')
  if (status === 'disconnected') return t('statusDisconnected')
  if (status === 'published') return t('statusPublished')
  if (status === 'failed') return t('statusFailed')
  return t('statusSkipped')
}

export function artifactStatusLabel(
  status: NonNullable<ArtifactStorage>['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'available') return t('artifactAvailable')
  if (status === 'unavailable') return t('artifactUnavailable')
  return t('statusFailed')
}

export function artifactStatusColor(
  status: NonNullable<ArtifactStorage>['status']
): string {
  if (status === 'available') return 'green'
  if (status === 'unavailable') return 'yellow'
  return 'red'
}
