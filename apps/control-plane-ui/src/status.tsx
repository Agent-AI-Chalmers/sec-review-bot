import React from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconMinus,
  IconPlayerPlay
} from '@tabler/icons-react'
import { type ArtifactStorage, type Run } from './api.js'
import { useMessages } from './i18n.js'

export type PublicationStepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'

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
  if (status === 'succeeded') return 'complete'
  if (status === 'failed') return 'failed'
  // skipped means execution never ran (preparation failed); it is neutral, not a failure of
  // execution itself.
  if (status === 'skipped') return 'neutral'
  return 'waiting'
}

export function preparationTone(preparation: Run['preparation']): StatusTone {
  if (preparation.status === 'preparing') return 'active'
  if (preparation.status === 'submitted') return 'complete'
  if (preparation.status === 'failed') return 'failed'
  return 'waiting'
}

export function publicationTone(
  status: Run['publication']['status']
): StatusTone {
  if (status === 'publishing') return 'active'
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
  if (tone === 'active') return <IconPlayerPlay size={14} />
  if (tone === 'complete') return <IconCheck size={14} />
  if (tone === 'failed') return <IconAlertTriangle size={14} />
  if (tone === 'neutral') return <IconMinus size={14} />
  return <IconClock size={14} />
}

export function publicationStatusLabel(
  status: PublicationStepStatus,
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'running') return t('statusInProgress')
  if (status === 'succeeded') return t('publicationStepSucceeded')
  if (status === 'failed') return t('retryPending')
  if (status === 'terminal_failed') return t('statusFailed')
  return status
}

export function publicationStatusColor(status: PublicationStepStatus): string {
  if (status === 'terminal_failed') return 'red'
  if (status === 'failed') return 'yellow'
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
  if (status === 'submitted') return t('statusSubmitted')
  return t('statusFailed')
}

export function axisLabel(
  axis: 'execution' | 'preparation' | 'publication' | 'notice',
  t: ReturnType<typeof useMessages>
): string {
  if (axis === 'execution') return t('axisExecution')
  if (axis === 'preparation') return t('axisPreparation')
  if (axis === 'publication') return t('axisPublication')
  return t('axisNotice')
}

export function failureNoticeStatusLabel(
  status: NonNullable<Run['preparation']>['failure_notice_status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'delivering') return t('statusDelivering')
  if (status === 'delivered') return t('statusDelivered')
  if (status === 'skipped') return t('statusSkipped')
  return ''
}

export function preparationStatusLabel(
  preparation: Run['preparation'],
  t: ReturnType<typeof useMessages>
): string {
  return preparationStateLabel(preparation.status, t)
}

export function runPublicationStatusLabel(
  status: Run['publication']['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('statusPending')
  if (status === 'publishing') return t('statusPublishing')
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
