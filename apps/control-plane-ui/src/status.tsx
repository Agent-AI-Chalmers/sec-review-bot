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
  | 'pending'
  | 'running'
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

function StatusText({ label, tone }: { label: string; tone: StatusTone }): React.JSX.Element {
  return (
    <span className="status-text">
      <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function executionTone(status: Run['execution_status']): StatusTone {
  if (status === 'running') return 'active'
  if (status === 'succeeded') return 'complete'
  if (status === 'failed') return 'failed'
  return 'waiting'
}

export function publicationTone(status: Run['publication_status']): StatusTone {
  if (status === 'publishing') return 'active'
  if (status === 'published') return 'complete'
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'waiting'
  return 'neutral'
}

export function ExecutionStatus({ status }: { status: Run['execution_status'] }): React.JSX.Element {
  const t = useMessages()
  return <StatusText label={executionStatusLabel(status, t)} tone={executionTone(status)} />
}

export function PublicationStatus({ status }: { status: Run['publication_status'] }): React.JSX.Element {
  const t = useMessages()
  return <StatusText label={runPublicationStatusLabel(status, t)} tone={publicationTone(status)} />
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
  if (status === 'pending') return t('publicationPending')
  if (status === 'running') return t('publishingStatus')
  if (status === 'succeeded') return t('publicationStepSucceeded')
  if (status === 'failed') return t('retryPending')
  if (status === 'terminal_failed') return t('failedStatus')
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
  status: Run['execution_status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'preparing') return t('statusPreparing')
  if (status === 'recovering') return t('statusRecovering')
  if (status === 'queued') return t('statusQueued')
  if (status === 'running') return t('statusRunning')
  if (status === 'succeeded') return t('statusSucceeded')
  return t('statusFailed')
}

export function runPublicationStatusLabel(
  status: Run['publication_status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('publicationPending')
  if (status === 'publishing') return t('publishingStatus')
  if (status === 'published') return t('statusPublished')
  if (status === 'failed') return t('failedStatus')
  return t('publicationSkipped')
}

export function artifactStatusLabel(
  status: ArtifactStorage['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'available') return t('artifactAvailable')
  if (status === 'unavailable') return t('artifactUnavailable')
  return t('statusFailed')
}

export function artifactStatusColor(status: ArtifactStorage['status']): string {
  if (status === 'available') return 'green'
  if (status === 'unavailable') return 'yellow'
  return 'red'
}
