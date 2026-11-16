import assert from 'node:assert/strict'
import test from 'node:test'

import { STATE_MACHINES } from '../browser/features/runs/state-machines.generated.js'
import { isStateLabelKey } from '../browser/features/runs/state-labels.js'
import {
  EXECUTION_STATUSES,
  PREPARATION_STATUSES,
  PUBLICATION_STATUSES,
  STATE_TONES,
  executionStatusLabel,
  preparationStateLabel,
  runPublicationStatusLabel,
  publicationStatusLabel,
  publicationStatusColor
} from '../browser/features/runs/status.js'
import {
  axisMachine,
  eventMachine,
  stateLabel
} from '../browser/features/runs/detail/transitions.js'
import { messages, translate, type Translator } from '../browser/shared/i18n.js'
import type { RunEvent } from '../browser/features/runs/api.js'

test('filters, visual tones, and translations cover exactly the contract state machines', () => {
  const filters = {
    preparation: PREPARATION_STATUSES,
    execution: EXECUTION_STATUSES,
    publication: PUBLICATION_STATUSES
  }
  const keys: string[] = []
  for (const machine of STATE_MACHINES) {
    assert.deepEqual(filters[machine.axis], machine.states)
    for (const [key, body, tones] of [
      [machine.axis, machine, STATE_TONES[machine.axis]],
      ['publication_step', machine.step, STATE_TONES.publication_step]
    ] as const) {
      if (body === undefined) continue
      assert.deepEqual(Object.keys(tones).sort(), [...body.states].sort())
      for (const state of body.states) {
        const labelKey = `state_${key}_${state}_label`
        assert.ok(isStateLabelKey(labelKey))
        assert.equal(messages.en[labelKey], body.details[state]?.label)
        assert.ok(messages.zh[labelKey].trim())
        keys.push(labelKey)
      }
    }
  }
  for (const language of ['en', 'zh'] as const)
    assert.deepEqual(
      keys.sort(),
      Object.keys(messages[language])
        .filter((key) => key.startsWith('state_') && key.endsWith('_label'))
        .sort()
    )
})

test('summaries, filters, diagrams, and event history use the same localized state labels', () => {
  const summary = {
    preparation: preparationStateLabel,
    execution: executionStatusLabel,
    publication: runPublicationStatusLabel
  }
  for (const language of ['en', 'zh'] as const) {
    const t: Translator = (key, ...args) => translate(language, key, ...args)
    for (const machine of STATE_MACHINES) {
      for (const state of machine.states) {
        const key = `state_${machine.axis}_${state}_label`
        assert.ok(isStateLabelKey(key))
        const expected = t(key)
        assert.equal(stateLabel(axisMachine(machine), state, t), expected)
        // Each axis-specific function accepts only that axis's status union.
        const label = summary[machine.axis] as (
          status: string,
          t: Translator
        ) => string
        assert.equal(label(state, t), expected)
      }
      if (machine.step === undefined) continue
      for (const state of machine.step.states) {
        const event = { axis: machine.axis, step_key: 'delivery' } as RunEvent
        const labelled = eventMachine(event)
        assert.ok(labelled)
        assert.equal(
          publicationStatusLabel(
            state as Parameters<typeof publicationStatusLabel>[0],
            t
          ),
          stateLabel(labelled, state, t)
        )
      }
    }
  }
})

test('retryable publication step failures remain visually distinct from terminal failure', () => {
  assert.equal(publicationStatusColor('failed'), 'yellow')
  assert.equal(publicationStatusColor('terminal_failed'), 'red')
  assert.equal(publicationStatusColor('succeeded'), 'green')
})

test('publication attempt failure and terminal failure have distinct labels in both languages', () => {
  for (const [language, attempt, terminal] of [
    ['en', 'Attempt failed', 'Terminal failure'],
    ['zh', '尝试失败', '最终失败']
  ] as const) {
    const t: Translator = (key, ...args) => translate(language, key, ...args)
    assert.equal(publicationStatusLabel('failed', t), attempt)
    assert.equal(publicationStatusLabel('terminal_failed', t), terminal)
  }
})
