// Every contract-driven label the console renders must have a translation key.
//
// The console localizes the contract rather than shipping its own copy: state and edge labels
// come from `x-state-machines`, and the console looks each one up as `state_<axis>_<state>_*`,
// `edge_<axis>_<from>_<to>` or `machine_<axis>_title`. When an axis was renamed from `runner` to
// `execution`, those keys kept the old spelling, so the Execution diagram silently fell back to
// the contract's English text even in a Chinese console. Nothing failed: a missing key renders
// the fallback, which looks like a translation choice rather than a gap. This test makes the
// gap visible.
import assert from 'node:assert/strict'
import test from 'node:test'

import { STATE_MACHINES } from '../src/state-machines.generated.js'
import { messages } from '../src/i18n.js'

test('every state-machine label has a key in both languages', () => {
  for (const language of ['en', 'zh'] as const) {
    const table = messages[language] as Record<string, string>
    for (const machine of STATE_MACHINES) {
      const required = [
        `machine_${machine.axis}_title`,
        ...machine.states.flatMap((state) => [
          `state_${machine.axis}_${state}_label`,
          `state_${machine.axis}_${state}_desc`
        ]),
        ...machine.transitions.map(
          (edge) => `edge_${machine.axis}_${edge.from}_${edge.to}`
        )
      ]
      const missing = required.filter((key) => !(key in table))
      assert.deepStrictEqual(
        missing,
        [],
        `${language} is missing ${missing.length} key(s) for the ${machine.axis} machine`
      )
    }
  }
})
