import type { Run, RunEvent } from '../api.js'
import {
  machineForEvent,
  type CoordinationAxis,
  type MachineBody
} from '../state-machines.generated.js'
import type { Language } from '../../../shared/i18n.js'

export const TRANSITIONS_PAGE_SIZE = 12

export function stateLabel(machine: MachineBody, state: string): string {
  return machine.details[state]?.label ?? state
}

export function stateDescription(machine: MachineBody, state: string): string {
  return machine.details[state]?.description ?? ''
}

export function edgeLabel(
  machine: MachineBody,
  edge: MachineBody['transitions'][number]
): string {
  return (
    edge.label ??
    `${stateLabel(machine, edge.from)} → ${stateLabel(machine, edge.to)}`
  )
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
  language: Language
): string {
  if (state === null) return '—'
  const machine = machineForEvent(event, language)
  return machine === undefined ? state : stateLabel(machine, state)
}

/** What an audit event did, from the contract's transition: the one whose reason matches the
 * event, else the one without a reason, else the description of the state it reached. */
export function transitionExplanation(
  event: RunEvent,
  language: Language
): string | null {
  const machine = machineForEvent(event, language)
  if (machine === undefined) return null
  const candidates = machine.transitions.filter(
    (candidate) =>
      candidate.from === event.from_status && candidate.to === event.to_status
  )
  const chosen =
    (event.reason_code === null
      ? undefined
      : candidates.find(
          (candidate) => candidate.reason === event.reason_code
        )) ?? candidates.find((candidate) => candidate.reason === undefined)
  if (chosen !== undefined) return edgeLabel(machine, chosen)
  // No transition is identified (an unknown reason on a pair with only reason-specific
  // transitions, or a pair the contract does not declare): describe where the event landed
  // rather than guessing which decision it was.
  const description = stateDescription(machine, event.to_status)
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
