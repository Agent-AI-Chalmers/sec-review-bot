// Project the contract's `x-state-machines` block into modules the console and the Control
// Plane can render/assert against. The block is the single source of truth for the
// coordination lifecycles; these files are its TypeScript view, so the state-machine diagram,
// the history view, and the contract's status enums cannot drift. Regenerate with
// `pnpm --dir contracts/control-plane-api/tools run generate`.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import prettier from 'prettier'
import { parse as parseYaml } from 'yaml'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

const SPEC_PATH = path.resolve(
  REPO_ROOT,
  'contracts',
  'control-plane-api',
  'openapi.yaml'
)

export type StateAxis = 'preparation' | 'runner' | 'publication' | 'notice'

export interface StateTransition {
  from: string
  to: string
  /** Machine-readable cause a write path attaches, when the transition has one. */
  reason?: string
  /** Short English label shown as the edge tooltip; the console localizes it by key. */
  label?: string
}

/** One state on an axis: its display labels and the sentence shown when it is hovered. This
 * text lives in the contract so a tooltip can never describe a state differently from the
 * diagram or the schema. */
export interface StateDetail {
  /** English label; the console localizes it by state key. */
  label: string
  /** English sentence shown on hover; the console localizes it by state key. */
  description: string
}

export interface StateMachine {
  axis: StateAxis
  /** Display order across axes: earlier in the lifecycle sorts first (preparation before
   * execution before publication). */
  order: number
  title: string
  field: string
  initial: string
  terminal: string[]
  /** State keys in declaration order. */
  states: string[]
  /** Per-state label and hover description, keyed by the same values as `states`. */
  details: Record<string, StateDetail>
  transitions: StateTransition[]
}

const AXES: readonly StateAxis[] = [
  'preparation',
  'runner',
  'publication',
  'notice'
]

/** Read and validate the `x-state-machines` block. Validation here is deliberately strict:
 * a generator that silently accepts a malformed machine would produce a diagram that no
 * longer means what the contract says. */
export function readStateMachines(): StateMachine[] {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    'x-state-machines'?: Record<string, unknown>
  }
  const block = spec['x-state-machines']
  if (block === undefined)
    throw new Error('openapi.yaml has no x-state-machines block')
  const machines = AXES.map((axis) => {
    const raw = block[axis]
    if (typeof raw !== 'object' || raw === null)
      throw new Error(`x-state-machines.${axis} is missing`)
    const machine = raw as {
      order?: unknown
      title?: unknown
      field?: unknown
      initial?: unknown
      terminal?: unknown
      states?: unknown
      transitions?: unknown
    }
    const { states, details } = readStates(machine.states, `${axis}.states`)
    const terminal = asStringArray(machine.terminal, `${axis}.terminal`)
    const order = asNumber(machine.order, `${axis}.order`)
    const initial = asString(machine.initial, `${axis}.initial`)
    const field = asString(machine.field, `${axis}.field`)
    const title = asString(machine.title, `${axis}.title`)
    if (!states.includes(initial))
      throw new Error(
        `x-state-machines.${axis}.initial is not one of its states`
      )
    for (const state of terminal)
      if (!states.includes(state))
        throw new Error(
          `x-state-machines.${axis}.terminal ${state} is not a state`
        )
    const transitions = (
      Array.isArray(machine.transitions)
        ? machine.transitions
        : (() => {
            throw new Error(
              `x-state-machines.${axis}.transitions must be an array`
            )
          })()
    ).map((edge, index): StateTransition => {
      if (typeof edge !== 'object' || edge === null)
        throw new Error(
          `x-state-machines.${axis}.transitions[${index}] is invalid`
        )
      const record = edge as Record<string, unknown>
      const from = asString(record.from, `${axis}.transitions[${index}].from`)
      const to = asString(record.to, `${axis}.transitions[${index}].to`)
      if (!states.includes(from) || !states.includes(to))
        throw new Error(
          `x-state-machines.${axis}.transitions[${index}] names an unknown state`
        )
      return {
        from,
        to,
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
        ...(typeof record.label === 'string' ? { label: record.label } : {})
      }
    })
    return {
      axis,
      order,
      title,
      field,
      initial,
      terminal,
      states,
      details,
      transitions
    }
  })
  // The lifecycle order is declared in the contract (`order`), not implied by YAML key order,
  // so the diagram reads preparation -> execution -> publication. The `notice` axis is not a
  // run lifecycle axis and is deliberately absent from this diagram (the console shows the
  // failure-notice stage as a line on a failed preparation instead).
  return machines.sort((left, right) => left.order - right.order)
}

/** Read the `states` map: each key is a state value, each value its labels and hover
 * description. Every field is required, so a state cannot be added without saying what it
 * means. */
function readStates(
  value: unknown,
  where: string
): { states: string[]; details: Record<string, StateDetail> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`x-state-machines.${where} must be a state map`)
  const details: Record<string, StateDetail> = {}
  const states: string[] = []
  for (const [state, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null)
      throw new Error(`x-state-machines.${where}.${state} must be an object`)
    const record = raw as Record<string, unknown>
    details[state] = {
      label: asString(record.label, `${where}.${state}.label`),
      description: asString(record.description, `${where}.${state}.description`)
    }
    states.push(state)
  }
  if (states.length === 0)
    throw new Error(`x-state-machines.${where} must declare at least one state`)
  return { states, details }
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`x-state-machines.${where} must be a string array`)
  return value as string[]
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`x-state-machines.${where} must be a number`)
  return value
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string')
    throw new Error(`x-state-machines.${where} must be a string`)
  return value
}

const HEADER = `// Generated from contracts/control-plane-api/openapi.yaml (path relative to the repository
// root). Do not edit. The contract's \`x-state-machines\` block is the single source of truth;
// this file is its TypeScript view. Regenerate it with
// \`pnpm --dir contracts/control-plane-api/tools run generate\`.
`

/** The rendered module body. Identical for both consumers so the console and the
 * Control-Plane-side consistency test read exactly the same machines. */
async function renderStateMachinesModule(): Promise<string> {
  const machines = readStateMachines()
  const axes = machines.map((machine) => machine.axis)
  const rendered = `${HEADER}
export type StateAxis = ${axes.map((axis) => `'${axis}'`).join(' | ')}

export interface StateTransition {
  from: string
  to: string
  reason?: string
  label?: string
}

export interface StateDetail {
  label: string
  description: string
}

export interface StateMachine {
  axis: StateAxis
  order: number
  title: string
  field: string
  initial: string
  terminal: string[]
  states: string[]
  details: Record<string, StateDetail>
  transitions: StateTransition[]
}

/** Every declared state machine. Which of them the console draws is a presentation decision
 * that lives in the console, not here. */
export const STATE_MACHINES: readonly StateMachine[] = ${JSON.stringify(
    machines,
    null,
    2
  )} as const

/** The machine for one axis, or undefined if the axis is unknown. */
export function stateMachine(axis: StateAxis): StateMachine | undefined {
  return STATE_MACHINES.find((machine) => machine.axis === axis)
}
`
  const options = await prettier.resolveConfig(
    path.resolve(REPO_ROOT, 'apps', 'control-plane-ui', 'src')
  )
  return await prettier.format(rendered, {
    ...options,
    filepath: path.resolve(
      REPO_ROOT,
      'apps',
      'control-plane-ui',
      'src',
      'state-machines.generated.ts'
    )
  })
}

export function generatedArtifacts(): GeneratedArtifact[] {
  return [
    {
      output: path.resolve(
        REPO_ROOT,
        'apps',
        'control-plane-ui',
        'src',
        'state-machines.generated.ts'
      ),
      render: renderStateMachinesModule
    },
    {
      output: path.resolve(
        REPO_ROOT,
        'control-plane',
        'src',
        'state-machines.generated.ts'
      ),
      render: renderStateMachinesModule
    }
  ]
}
