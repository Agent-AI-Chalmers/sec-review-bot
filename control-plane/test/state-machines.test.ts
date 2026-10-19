// Keep the contract's x-state-machines block and the status enums it describes in step.
//
// The generated module is the console's and this test's view of the lifecycles, but the enums
// themselves live on the request/response schemas. If a state were added to one and not the
// other, the diagram would tell an operator that a state exists (or does not) contrary to the
// contract. This asserts the two agree in both directions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { STATE_MACHINES } from '../src/state-machines.generated.js'
import { CONTROL_PLANE_API_SPEC_PATH as SPEC_PATH } from './generated-paths.js'

type Spec = {
  components?: { schemas?: Record<string, unknown> }
}

/** Pull the enum off the schema a machine's `field` points into. ObservedRun is the read
 * surface the console renders, so its enums are the ones the diagram must match. */
function enumFor(spec: Spec, field: string): string[] {
  const observed = spec.components?.schemas?.ObservedRun as
    { properties?: Record<string, unknown> } | undefined
  const props = observed?.properties
  if (props === undefined) throw new Error('ObservedRun has no properties')
  // An axis field is `<axis>.<member>` (preparation.status, execution.status,
  // publication.status, ...). Each axis is a `$ref` to its summary schema, so its properties
  // are not inlined here; resolve the ref to the component it names.
  if (field.includes('.')) {
    const [axis, key = ''] = field.split('.')
    const ref = props[axis as string] as { $ref?: string } | undefined
    const target = ref?.$ref?.replace('#/components/schemas/', '')
    const summary = spec.components?.schemas?.[target ?? ''] as
      { properties?: Record<string, { enum?: unknown }> } | undefined
    return asEnum(summary?.properties?.[key]?.enum, field)
  }
  const node = props[field] as { enum?: unknown } | undefined
  return asEnum(node?.enum, field)
}

function asEnum(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} has no enum`)
  // `preparation.status`/notice enums are plain arrays; the nullable ones include a null.
  return value.filter((item): item is string => typeof item === 'string')
}

test('each state-machine axis matches the enum of the field it describes', () => {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as Spec
  for (const machine of STATE_MACHINES) {
    const enumValues = enumFor(spec, machine.field)
    const states = [...machine.states].sort()
    assert.deepStrictEqual(
      [...enumValues].sort(),
      states,
      `${machine.axis} states must equal the enum of ${machine.field}`
    )
  }
})

test('every state declares a label and hover description in both languages', () => {
  for (const machine of STATE_MACHINES) {
    for (const state of machine.states) {
      const detail = machine.details[state]
      assert.ok(detail, `${machine.axis}.${state} has no details`)
      for (const key of ['label', 'description'] as const)
        assert.ok(
          detail[key] && detail[key].trim().length > 0,
          `${machine.axis}.${state}.${key} must be non-empty`
        )
    }
    // The details map must not describe states the machine does not declare.
    assert.deepStrictEqual(
      Object.keys(machine.details).sort(),
      [...machine.states].sort(),
      `${machine.axis} details must cover exactly its states`
    )
  }
})

test('every transition names states the machine declares, and every state is reachable', () => {
  for (const machine of STATE_MACHINES) {
    const states = new Set(machine.states)
    assert.ok(states.has(machine.initial), `${machine.axis} initial is a state`)
    for (const terminal of machine.terminal)
      assert.ok(
        states.has(terminal),
        `${machine.axis} terminal ${terminal} is a state`
      )
    const reached = new Set<string>([machine.initial])
    // Breadth-first over the declared edges: a state with no path from the initial one is a
    // diagram lie (it would be drawn but never entered).
    let changed = true
    while (changed) {
      changed = false
      for (const edge of machine.transitions) {
        assert.ok(
          states.has(edge.from) && states.has(edge.to),
          `${machine.axis} edge ${edge.from}->${edge.to}`
        )
        if (reached.has(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to)
          changed = true
        }
      }
    }
    for (const state of machine.states)
      assert.ok(
        reached.has(state),
        `${machine.axis} state ${state} is unreachable`
      )
  }
})
