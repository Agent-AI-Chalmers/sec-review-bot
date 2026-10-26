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

test('an edge pair the contract has not split is worded for all of its decisions', () => {
  // The console looks an edge label up by its state pair, so two declared transitions that share
  // a pair (the contract separates them by `reason`) collapse onto one tooltip. One axis really
  // does need that: a disconnected preparation has three operator decisions on the same pair. A
  // pair is therefore acceptable either once, or many times only where the contract says why -
  // and the wording has to hold for every decision, which is a judgement the key cannot make for
  // itself. This pins the set of pairs known to be collapsed, so a future decision added to an
  // existing pair shows up here instead of silently losing its label.
  const collapsed: string[] = []
  for (const machine of STATE_MACHINES) {
    const decisions = new Map<string, number>()
    for (const edge of machine.transitions) {
      const pair = `${machine.axis} ${edge.from}->${edge.to}`
      decisions.set(pair, (decisions.get(pair) ?? 0) + 1)
    }
    for (const [pair, count] of decisions)
      if (count > 1) collapsed.push(`${pair} (${count})`)
  }
  assert.deepStrictEqual(collapsed.sort(), [
    'preparation disconnected->failed (3)'
  ])
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
