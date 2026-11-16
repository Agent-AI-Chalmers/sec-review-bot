// Every contract-driven label the console renders must have a translation key.
//
// The console localizes the contract rather than shipping its own copy: state and edge labels
// come from `x-state-machines`, and the console looks each one up as `state_<axis>_<state>_*`,
// `edge_<axis>_<from>_<to>` or `machine_<axis>_title`. When an axis is renamed, stale keys can make
// the Execution diagram silently fall back to
// the contract's English text even in a Chinese console. Nothing failed: a missing key renders
// the fallback, which looks like a translation choice rather than a gap. This test makes the
// gap visible.
import assert from 'node:assert/strict'
import test from 'node:test'

import { STATE_MACHINES } from '../browser/features/runs/state-machines.generated.js'
import { messages } from '../browser/shared/i18n.js'

test('transitions sharing a state pair retain distinct reason-specific explanations', async () => {
  const { axisMachine, edgeLabel } =
    await import('../browser/features/runs/detail/transitions.js')
  const { translate } = await import('../browser/shared/i18n.js')
  for (const language of ['en', 'zh'] as const) {
    const t: import('../browser/shared/i18n.js').Translator = (key, ...args) =>
      translate(language, key, ...args)
    for (const machine of STATE_MACHINES) {
      const groups = Map.groupBy(
        machine.transitions,
        (edge) => `${edge.from}->${edge.to}`
      )
      for (const edges of groups.values()) {
        if (edges.length < 2) continue
        const labels = edges.map((edge) =>
          edgeLabel(axisMachine(machine), edge, t)
        )
        assert.equal(new Set(labels).size, edges.length)
      }
    }
  }
})

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

test('every step-machine label the timeline shows has a key in both languages', () => {
  // Step machines are not drawn, but the timeline labels each step event's states and edge, so
  // a missing key would fall back to English in a Chinese console without any visible failure.
  for (const language of ['en', 'zh'] as const) {
    const table = messages[language] as Record<string, string>
    for (const machine of STATE_MACHINES) {
      if (machine.step === undefined) continue
      const prefix = `${machine.axis}_step`
      const required = [
        ...machine.step.states.flatMap((state) => [
          `state_${prefix}_${state}_label`,
          `state_${prefix}_${state}_desc`
        ]),
        ...machine.step.transitions.map(
          (edge) => `edge_${prefix}_${edge.from}_${edge.to}`
        )
      ]
      const missing = required.filter((key) => !(key in table))
      assert.deepStrictEqual(
        missing,
        [],
        `${language} is missing ${missing.length} key(s) for the ${prefix} machine`
      )
    }
  }
})
