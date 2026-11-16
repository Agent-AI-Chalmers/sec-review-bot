import type { Run, RunEvent } from '../api.js'
import {
  machineForEvent,
  type CoordinationAxis,
  type MachineBody,
  type StateMachine as StateMachineDefinition
} from '../state-machines.generated.js'
import { isStateLabelKey } from '../state-labels.js'
import type { Message, Translator } from '../../../shared/i18n.js'

export const TRANSITIONS_PAGE_SIZE = 12

/** A machine the console labels: an axis, or an axis' step machine. Its translation keys are
 * the axis name, or `<axis>_step` for the steps (`state_publication_step_running_label`). */
export interface LabelledMachine {
  key: string
  body: MachineBody
}

export function axisMachine(machine: StateMachineDefinition): LabelledMachine {
  return { key: machine.axis, body: machine }
}

/** The machine an audit event's states belong to, or undefined for a step event on an axis the
 * contract declares no steps for. */
export function eventMachine(event: RunEvent): LabelledMachine | undefined {
  const body = machineForEvent(event)
  if (body === undefined) return undefined
  return {
    key: event.step_key === null ? event.axis : `${event.axis}_step`,
    body
  }
}

export function stateLabel(
  machine: LabelledMachine,
  state: string,
  t: Translator
): string {
  const key = `state_${machine.key}_${state}_label`
  if (isStateLabelKey(key)) return t(key)
  return machine.body.details[state]?.label ?? state
}

export function stateDescription(
  machine: LabelledMachine,
  state: string,
  t: Translator
): string {
  const key = `state_${machine.key}_${state}_desc` as Message
  const translated = t(key)
  return translated && translated !== key
    ? translated
    : (machine.body.details[state]?.description ?? '')
}

export function edgeLabel(
  machine: LabelledMachine,
  edge: MachineBody['transitions'][number],
  t: Translator
): string {
  const key = `edge_${machine.key}_${edge.from}_${edge.to}` as Message
  const translated = t(key)
  if (translated && translated !== key) return translated
  if (edge.label !== undefined) return edge.label
  return `${stateLabel(machine, edge.from, t)} → ${stateLabel(machine, edge.to, t)}`
}

export function machineTitle(
  machine: StateMachineDefinition,
  t: Translator
): string {
  const key = `machine_${machine.axis}_title` as Message
  const translated = t(key)
  return translated && translated !== key ? translated : machine.title
}

export function actualTransitions(events: RunEvent[]): RunEvent[] {
  return events.filter((event) => event.from_status !== null)
}

export function latestTransitionAxis(events: RunEvent[]): CoordinationAxis {
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
  state: string | null,
  t: Translator
): string {
  if (state === null) return '—'
  const machine = eventMachine(event)
  return machine === undefined ? state : stateLabel(machine, state, t)
}

export function transitionExplanation(
  event: RunEvent,
  t: Translator
): string | null {
  const machine = eventMachine(event)
  if (machine === undefined) return null
  const edge =
    machine.body.transitions.find(
      (candidate) =>
        candidate.from === event.from_status &&
        candidate.to === event.to_status &&
        (event.reason_code === null || candidate.reason === event.reason_code)
    ) ??
    machine.body.transitions.find(
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
  now: number
): { kind: 'duration'; ms: number } | { kind: 'final' } {
  // A step's timeline is its own: the next event of another step says nothing about how long
  // this one stayed put.
  const axisEvents = transitions.filter(
    (candidate) =>
      candidate.axis === event.axis && candidate.step_key === event.step_key
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
  // A step has no summary of its own on the run; it is final once its axis is.
  const machine = machineForEvent(event)
  if (
    run[event.axis].finished_at !== null ||
    (machine !== undefined && machine.terminal.includes(event.to_status))
  )
    return { kind: 'final' }
  return {
    kind: 'duration',
    ms: Math.max(0, now - Date.parse(event.occurred_at))
  }
}
