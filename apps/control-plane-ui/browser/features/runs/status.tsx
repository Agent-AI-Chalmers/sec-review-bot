import React from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconMinus,
  IconPlayerPlay
} from '@tabler/icons-react'
import { type ArtifactStorage, type PublicationStep, type Run, type RunEvent } from './api.js'
import {
  STATE_MACHINES,
  stateMachine,
  type CoordinationAxis,
  type Language as StateMachineLanguage
} from './state-machines.generated.js'
import { useLanguage, useMessages, type Language } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'

export type PublicationStepStatus = PublicationStep['status']

type StatusTone = 'waiting' | 'active' | 'complete' | 'failed' | 'neutral' | 'retry'

export function statusToneColor(tone: StatusTone): string {
  if (tone === 'active') return 'blue'
  if (tone === 'complete') return 'green'
  if (tone === 'failed') return 'red'
  if (tone === 'retry') return 'yellow'
  return 'gray'
}

function StatusText({ label, tone }: { label: string; tone: StatusTone }) {
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

export function publicationTone(status: Run['publication']['status']): StatusTone {
  return STATE_TONES.publication[status]
}

export function ExecutionStatus({
  status
}: {
  status: Run['execution']['status']
}): React.JSX.Element {
  const { language } = useLanguage()
  return <StatusText label={executionStatusLabel(status, language)} tone={executionTone(status)} />
}

export function PreparationStatus({
  preparation
}: {
  preparation: Run['preparation']
}): React.JSX.Element {
  const { language } = useLanguage()
  return (
    <StatusText
      label={preparationStateLabel(preparation.status, language)}
      tone={preparationTone(preparation)}
    />
  )
}

export function PublicationStatus({
  status
}: {
  status: Run['publication']['status']
}): React.JSX.Element {
  const { language } = useLanguage()
  return (
    <StatusText
      label={runPublicationStatusLabel(status, language)}
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

/** The console's languages and the generated state-machine text must name the same languages:
 * a UI language with no overlay would index missing machines at run time. This fails to compile
 * when either side gains a language the other lacks. */
export type StateMachineLanguagesMatchConsole = [Language] extends [StateMachineLanguage]
  ? [StateMachineLanguage] extends [Language]
    ? true
    : never
  : never

true satisfies StateMachineLanguagesMatchConsole

/** A status label from the contract's state machine, in the console's language. */
function axisStateLabel(axis: CoordinationAxis, status: string, language: Language) {
  return stateMachine(axis, language).details[status]?.label ?? status
}

export function publicationStatusLabel(status: PublicationStepStatus, language: Language): string {
  return stateMachine('publication', language).step?.details[status]?.label ?? status
}

export function publicationStatusColor(status: PublicationStepStatus): string {
  return statusToneColor(STATE_TONES.publication_step[status])
}

export function executionStatusLabel(
  status: Run['execution']['status'],
  language: Language
): string {
  return axisStateLabel('execution', status, language)
}

function axisStatuses<A extends CoordinationAxis>(axis: A): Run[A]['status'][] {
  const machine = STATE_MACHINES.find((candidate) => candidate.axis === axis)
  if (machine === undefined) throw new Error(`Missing state machine: ${axis}`)
  return machine.states.map((state) => state as Run[A]['status'])
}

export const PREPARATION_STATUSES = axisStatuses('preparation')
export const EXECUTION_STATUSES = axisStatuses('execution')
export const PUBLICATION_STATUSES = axisStatuses('publication')

export function preparationStateLabel(
  status: Run['preparation']['status'],
  language: Language
): string {
  return axisStateLabel('preparation', status, language)
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
  if (event.step_key !== null) return t('axisPublicationStep', { step: event.step_key })
  return axisLabel(event.axis, t)
}

export function axisLabel(axis: CoordinationAxis, t: ReturnType<typeof useMessages>): string {
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

export function runPublicationStatusLabel(
  status: Run['publication']['status'],
  language: Language
): string {
  return axisStateLabel('publication', status, language)
}

export function artifactStatusLabel(
  status: NonNullable<ArtifactStorage>['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'available') return t('artifactAvailable')
  if (status === 'unavailable') return t('artifactUnavailable')
  return t('statusFailed')
}

export function artifactStatusColor(status: NonNullable<ArtifactStorage>['status']): string {
  if (status === 'available') return 'green'
  if (status === 'unavailable') return 'yellow'
  return 'red'
}
