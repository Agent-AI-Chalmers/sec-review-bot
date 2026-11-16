import React from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconMinus,
  IconPlayerPlay
} from '@tabler/icons-react'
import {
  type ArtifactStorage,
  type PublicationStep,
  type Run,
  type RunEvent
} from './api.js'
import {
  STATE_MACHINES,
  type CoordinationAxis
} from './state-machines.generated.js'
import { isStateLabelKey } from './state-labels.js'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'

export type PublicationStepStatus = PublicationStep['status']

type StatusTone =
  'waiting' | 'active' | 'complete' | 'failed' | 'neutral' | 'retry'

export function statusToneColor(tone: StatusTone): string {
  if (tone === 'active') return 'blue'
  if (tone === 'complete') return 'green'
  if (tone === 'failed') return 'red'
  if (tone === 'retry') return 'yellow'
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

/** Presentation belongs to the console; each axis must cover every API status. */
export const STATE_TONES = {
  preparation: {
    pending: 'waiting',
    preparing: 'active',
    uncertain: 'waiting',
    disconnected: 'neutral',
    submitted: 'complete',
    failed: 'failed'
  },
  execution: {
    pending: 'waiting',
    queued: 'waiting',
    running: 'active',
    uncertain: 'waiting',
    disconnected: 'neutral',
    succeeded: 'complete',
    skipped: 'neutral',
    failed: 'failed'
  },
  publication: {
    pending: 'waiting',
    publishing: 'active',
    uncertain: 'waiting',
    disconnected: 'neutral',
    published: 'complete',
    failed: 'failed',
    skipped: 'neutral'
  },
  publication_step: {
    pending: 'waiting',
    running: 'active',
    failed: 'retry',
    uncertain: 'retry',
    disconnected: 'neutral',
    succeeded: 'complete',
    terminal_failed: 'failed'
  }
} as const satisfies {
  [A in CoordinationAxis]: Record<Run[A]['status'], StatusTone>
} & { publication_step: Record<PublicationStepStatus, StatusTone> }

export function executionTone(status: Run['execution']['status']): StatusTone {
  return STATE_TONES.execution[status]
}

export function preparationTone(preparation: Run['preparation']): StatusTone {
  return STATE_TONES.preparation[preparation.status]
}

export function publicationTone(
  status: Run['publication']['status']
): StatusTone {
  return STATE_TONES.publication[status]
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
  if (tone === 'retry') return <IconAlertTriangle size={ICON_SIZE.sm} />
  if (tone === 'neutral') return <IconMinus size={ICON_SIZE.sm} />
  return <IconClock size={ICON_SIZE.sm} />
}

export function publicationStatusLabel(
  status: PublicationStepStatus,
  t: ReturnType<typeof useMessages>
): string {
  return t(`state_publication_step_${status}_label`)
}

export function publicationStatusColor(status: PublicationStepStatus): string {
  return statusToneColor(STATE_TONES.publication_step[status])
}

export function executionStatusLabel(
  status: Run['execution']['status'],
  t: ReturnType<typeof useMessages>
): string {
  return t(`state_execution_${status}_label`)
}

function axisStatuses<A extends CoordinationAxis>(axis: A): Run[A]['status'][] {
  const machine = STATE_MACHINES.find((candidate) => candidate.axis === axis)
  if (machine === undefined) throw new Error(`Missing state machine: ${axis}`)
  return machine.states.map((state) => {
    if (!isStateLabelKey(`state_${axis}_${state}_label`))
      throw new Error(`Missing state label: ${axis}.${state}`)
    return state as Run[A]['status']
  })
}

export const PREPARATION_STATUSES = axisStatuses('preparation')
export const EXECUTION_STATUSES = axisStatuses('execution')
export const PUBLICATION_STATUSES = axisStatuses('publication')

export function preparationStateLabel(
  status: Run['preparation']['status'],
  t: ReturnType<typeof useMessages>
): string {
  return t(`state_preparation_${status}_label`)
}

/** Human label for a coordination axis.
 *
 * An unrecognised axis renders as its raw value rather than as some other axis' label, so a
 * mismatch is visible instead of being presented as a plausible-looking history.
 */
/** Label for what an audit event moved: its axis, or the named step of that axis. One run can
 * have several publication steps, so the timeline must say which one moved. */
export function eventAxisLabel(
  event: Pick<RunEvent, 'axis' | 'step_key'>,
  t: ReturnType<typeof useMessages>
): string {
  if (event.step_key !== null)
    return t('axisPublicationStep', { step: event.step_key })
  return axisLabel(event.axis, t)
}

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
  return t(`state_publication_${status}_label`)
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
