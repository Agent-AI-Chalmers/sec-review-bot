// Keep the contract's x-state-machines block and the status enums it describes in step.
//
// The generated module is the console's and this test's view of the lifecycles, but the enums
// themselves live on the request/response schemas. If a state were added to one and not the
// other, the diagram would tell an operator that a state exists (or does not) contrary to the
// contract. This asserts the two agree in both directions.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import { parse as parseYaml } from 'yaml'

import {
  STATE_MACHINES,
  type MachineBody
} from '../src/state-machines.generated.js'
import { REVIEW_RUNS_API_SPEC_PATH as SPEC_PATH } from './generated-paths.js'

type Spec = {
  components?: { schemas?: Record<string, unknown> }
}

/** Pull the enum off the schema a machine's `field` points into. ObservedRun is the read
 * surface the console renders, so its enums are the ones the diagram must match. */
function enumFor(spec: Spec, field: string): string[] {
  // A machine that is not a run axis names its schema directly (`ObservedPublicationStep.status`).
  const [schemaName = '', member = ''] = field.split('.')
  const direct = spec.components?.schemas?.[schemaName] as
    { properties?: Record<string, { enum?: unknown }> } | undefined
  if (direct !== undefined)
    return asEnum(direct.properties?.[member]?.enum, field)
  const observed = spec.components?.schemas?.ObservedRun as
    { properties?: Record<string, unknown> } | undefined
  const props = observed?.properties
  if (props === undefined) throw new Error('ObservedRun has no properties')
  // An axis field is `<axis>.<member>` (preparation.status, execution.status,
  // publication.status, ...). Each axis is a `$ref` to its summary schema, so its properties
  // are not inlined here; resolve the ref to the component it names.
  if (field.includes('.')) {
    const [axis, key = ''] = field.split('.')
    // The member is a `$ref` to its summary schema; resolve it before reading the enum.
    const node = props[axis as string] as
      { $ref?: string; oneOf?: Array<{ $ref?: string }> } | undefined
    const target = (
      node?.$ref ?? node?.oneOf?.find((entry) => entry.$ref !== undefined)?.$ref
    )?.replace('#/components/schemas/', '')
    const summary = spec.components?.schemas?.[target ?? ''] as
      { properties?: Record<string, { enum?: unknown }> } | undefined
    return asEnum(summary?.properties?.[key]?.enum, field)
  }
  const node = props[field] as { enum?: unknown } | undefined
  return asEnum(node?.enum, field)
}

/** Every machine with a name for messages: each axis, and each axis' step machine. */
const ALL_MACHINES: ReadonlyArray<[string, MachineBody]> =
  STATE_MACHINES.flatMap((machine): Array<[string, MachineBody]> => [
    [machine.axis, machine],
    ...(machine.step === undefined
      ? []
      : [[`${machine.axis}.step`, machine.step] as [string, MachineBody]])
  ])

function asEnum(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} has no enum`)
  // Nullable enums include null; state machines only describe named string states.
  return value.filter((item): item is string => typeof item === 'string')
}

test('each state-machine axis matches the enum of the field it describes', () => {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as Spec
  for (const [name, machine] of ALL_MACHINES) {
    const enumValues = enumFor(spec, machine.field)
    const states = [...machine.states].sort()
    expect(
      [...enumValues].sort(),
      `${name} states must equal the enum of ${machine.field}`
    ).toStrictEqual(states)
  }
})

test('every state declares a label and hover description in both languages', () => {
  for (const [name, machine] of ALL_MACHINES) {
    for (const state of machine.states) {
      const detail = machine.details[state]
      expect.assert(detail, `${name}.${state} has no details`)
      for (const key of ['label', 'description'] as const)
        expect.assert(
          detail[key] && detail[key].trim().length > 0,
          `${name}.${state}.${key} must be non-empty`
        )
    }
    // The details map must not describe states the machine does not declare.
    expect(
      Object.keys(machine.details).sort(),
      `${name} details must cover exactly its states`
    ).toStrictEqual([...machine.states].sort())
  }
})

test('every transition names states the machine declares, and every state is reachable', () => {
  for (const [name, machine] of ALL_MACHINES) {
    const states = new Set(machine.states)
    expect.assert(states.has(machine.initial), `${name} initial is a state`)
    for (const terminal of machine.terminal)
      expect.assert(
        states.has(terminal),
        `${name} terminal ${terminal} is a state`
      )
    const reached = new Set<string>([machine.initial])
    // Breadth-first over the declared edges: a state with no path from the initial one is a
    // diagram lie (it would be drawn but never entered).
    let changed = true
    while (changed) {
      changed = false
      for (const edge of machine.transitions) {
        expect.assert(
          states.has(edge.from) && states.has(edge.to),
          `${name} edge ${edge.from}->${edge.to}`
        )
        if (reached.has(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to)
          changed = true
        }
      }
    }
    for (const state of machine.states)
      expect.assert(reached.has(state), `${name} state ${state} is unreachable`)
  }
})
