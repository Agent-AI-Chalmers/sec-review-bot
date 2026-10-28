import type { Run, RunEvent } from './api.js'
import {
  STATE_MACHINES,
  type StateAxis,
  type StateMachine as StateMachineDefinition
} from './state-machines.generated.js'
import type { Message } from '../../shared/i18n.js'
import { DIAGRAMMED_AXES } from './state-machine-layout.js'

export const TRANSITIONS_PAGE_SIZE = 12

function stateKey(
  axis: StateAxis,
  state: string,
  field: 'label' | 'desc'
): Message | null {
  const key = `state_${axis}_${state}_${field}`
  return key as Message
}

export function stateLabel(
  machine: StateMachineDefinition,
  state: string,
  t: (key: Message) => string
): string {
  const key = stateKey(machine.axis, state, 'label')
  const translated = key === null ? undefined : t(key)
  return translated && translated !== key
    ? translated
    : (machine.details[state]?.label ?? state)
}

export function stateDescription(
  machine: StateMachineDefinition,
  state: string,
  t: (key: Message) => string
): string {
  const key = stateKey(machine.axis, state, 'desc')
  const translated = key === null ? undefined : t(key)
  return translated && translated !== key
    ? translated
    : (machine.details[state]?.description ?? '')
}

export function edgeLabel(
  machine: StateMachineDefinition,
  edge: StateMachineDefinition['transitions'][number],
  t: (key: Message) => string
): string {
  const key = `edge_${machine.axis}_${edge.from}_${edge.to}` as Message
  const translated = t(key)
  if (translated && translated !== key) return translated
  if (edge.label !== undefined) return edge.label
  return `${stateLabel(machine, edge.from, t)} → ${stateLabel(machine, edge.to, t)}`
}

export function machineTitle(
  machine: StateMachineDefinition,
  t: (key: Message) => string
): string {
  const key = `machine_${machine.axis}_title` as Message
  const translated = t(key)
  return translated && translated !== key ? translated : machine.title
}

export function actualTransitions(events: RunEvent[]): RunEvent[] {
  return events.filter((event) => event.from_status !== null)
}

export function latestTransitionAxis(events: RunEvent[]): StateAxis {
  let latest: RunEvent | undefined
  for (const event of events) {
    if (event.from_status === null) continue
    if (
      latest === undefined ||
      Date.parse(event.occurred_at) > Date.parse(latest.occurred_at)
    )
      latest = event
  }
  return latest?.axis ?? 'execution'
}

export function stateLabelForEvent(
  event: RunEvent,
  machines: readonly StateMachineDefinition[],
  state: string | null,
  t: (key: Message) => string
): string {
  if (state === null) return '—'
  const machine = machines.find((candidate) => candidate.axis === event.axis)
  return machine === undefined ? state : stateLabel(machine, state, t)
}

export function transitionExplanation(
  event: RunEvent,
  machines: readonly StateMachineDefinition[],
  t: (key: Message) => string
): string | null {
  const machine = machines.find((candidate) => candidate.axis === event.axis)
  if (machine === undefined) return null
  const edge =
    machine.transitions.find(
      (candidate) =>
        candidate.from === event.from_status &&
        candidate.to === event.to_status &&
        (event.reason_code === null || candidate.reason === event.reason_code)
    ) ??
    machine.transitions.find(
      (candidate) =>
        candidate.from === event.from_status && candidate.to === event.to_status
    )
  if (edge !== undefined) return edgeLabel(machine, edge, t)
  const description = stateDescription(machine, event.to_status, t)
  return description === '' ? null : description
}

export function transitionDuration(
  event: RunEvent,
  transitions: RunEvent[],
  run: Run,
  machines: readonly StateMachineDefinition[],
  now: number
): { kind: 'duration'; ms: number } | { kind: 'final' } {
  const axisEvents = transitions.filter(
    (candidate) => candidate.axis === event.axis
  )
  const index = axisEvents.findIndex(
    (candidate) => candidate.event_id === event.event_id
  )
  const next = index >= 0 ? axisEvents[index + 1] : undefined
  if (next !== undefined) {
    return {
      kind: 'duration',
      ms: Math.max(
        0,
        Date.parse(next.occurred_at) - Date.parse(event.occurred_at)
      )
    }
  }
  const machine = machines.find((candidate) => candidate.axis === event.axis)
  const summary =
    event.axis === 'preparation'
      ? run.preparation
      : event.axis === 'execution'
        ? run.execution
        : run.publication
  if (
    summary.finished_at !== null ||
    (machine !== undefined && machine.terminal.includes(event.to_status))
  )
    return { kind: 'final' }
  return {
    kind: 'duration',
    ms: Math.max(0, now - Date.parse(event.occurred_at))
  }
}

/** The machines the console draws, in presentation order. */
export function diagrammedMachines(): readonly StateMachineDefinition[] {
  return STATE_MACHINES.filter((machine) =>
    (DIAGRAMMED_AXES as readonly string[]).includes(machine.axis)
  )
}
