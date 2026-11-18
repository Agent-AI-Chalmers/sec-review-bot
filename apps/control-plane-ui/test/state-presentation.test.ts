import { expect, test } from 'vitest'

import {
  STATE_MACHINES,
  STATE_MACHINES_BY_LANGUAGE,
  machineForEvent,
  stateMachine
} from '../browser/features/runs/state-machines.generated.js'
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
import { stateLabel } from '../browser/features/runs/detail/transitions.js'
import type { Language } from '../browser/shared/i18n.js'
import type { RunEvent } from '../browser/features/runs/api.js'

test('filters and visual tones cover exactly the contract state machines', () => {
  const filters = {
    preparation: PREPARATION_STATUSES,
    execution: EXECUTION_STATUSES,
    publication: PUBLICATION_STATUSES
  }
  for (const machine of STATE_MACHINES) {
    expect(filters[machine.axis]).toStrictEqual(machine.states)
    for (const [body, tones] of [
      [machine, STATE_TONES[machine.axis]],
      [machine.step, STATE_TONES.publication_step]
    ] as const) {
      if (body === undefined) {
        continue
      }
      expect(Object.keys(tones).sort()).toStrictEqual([...body.states].sort())
    }
  }
})

test('summaries, filters, diagrams, and event history use the same localized state labels', () => {
  const summary = {
    preparation: preparationStateLabel,
    execution: executionStatusLabel,
    publication: runPublicationStatusLabel
  }
  for (const language of ['en', 'zh'] as const satisfies Language[]) {
    for (const machine of STATE_MACHINES_BY_LANGUAGE[language]) {
      for (const state of machine.states) {
        const expected = machine.details[state]?.label
        expect.assert(expected)
        expect(stateLabel(stateMachine(machine.axis, language), state)).toBe(expected)
        // Each axis-specific function accepts only that axis's status union.
        const label = summary[machine.axis] as (status: string, language: Language) => string
        expect(label(state, language)).toBe(expected)
      }
      if (machine.step === undefined) {
        continue
      }
      for (const state of machine.step.states) {
        const event = { axis: machine.axis, step_key: 'delivery' } as RunEvent
        const labelled = machineForEvent(event, language)
        expect.assert(labelled)
        expect(
          publicationStatusLabel(state as Parameters<typeof publicationStatusLabel>[0], language)
        ).toBe(stateLabel(labelled, state))
      }
    }
  }
})

test('the Chinese console shows the overlay text, not the contract English', () => {
  // The overlay must actually reach the console: a state labelled identically in both languages
  // would mean the Chinese text was dropped somewhere between the overlay and the screen.
  expect(executionStatusLabel('uncertain', 'en')).toBe('Uncertain')
  expect(executionStatusLabel('uncertain', 'zh')).toBe('待确认')
})

test('retryable publication step failures remain visually distinct from terminal failure', () => {
  expect(publicationStatusColor('failed')).toBe('yellow')
  expect(publicationStatusColor('terminal_failed')).toBe('red')
  expect(publicationStatusColor('succeeded')).toBe('green')
})

test('publication attempt failure and terminal failure have distinct labels in both languages', () => {
  for (const [language, attempt, terminal] of [
    ['en', 'Attempt failed', 'Terminal failure'],
    ['zh', '尝试失败', '最终失败']
  ] as const) {
    expect(publicationStatusLabel('failed', language)).toBe(attempt)
    expect(publicationStatusLabel('terminal_failed', language)).toBe(terminal)
  }
})
