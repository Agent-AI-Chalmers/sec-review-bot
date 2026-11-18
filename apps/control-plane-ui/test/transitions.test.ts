import { expect, test } from 'vitest'

import type { Run, RunEvent } from '../browser/features/runs/api.js'
import {
  TRANSITIONS_PAGE_SIZE,
  actualTransitions,
  latestTransitionAxis,
  transitionDuration,
  transitionExplanation,
  edgeLabel
} from '../browser/features/runs/detail/transitions.js'

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    event_id: 1,
    axis: 'execution',
    from_status: 'pending',
    to_status: 'queued',
    reason_code: null,
    step_key: null,
    occurred_at: '2026-10-28T10:00:00.000Z',
    ...overrides
  }
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    preparation: { finished_at: null },
    execution: { finished_at: null },
    publication: { finished_at: null },
    ...overrides
  } as Run
}

test('transitions exclude synthetic initialization events', () => {
  const initial = event({
    event_id: 2,
    axis: 'preparation',
    from_status: null,
    to_status: 'pending'
  })
  const actual = event({ event_id: 3 })
  expect(
    actualTransitions([initial, actual]).map((candidate) => candidate.event_id)
  ).toStrictEqual([3])
})

test('the default axis follows the latest actual transition', () => {
  const events = [
    event({
      event_id: 4,
      axis: 'publication',
      from_status: null,
      to_status: 'pending',
      occurred_at: '2026-10-28T10:00:00.000Z'
    }),
    event({
      event_id: 5,
      axis: 'preparation',
      from_status: 'preparing',
      to_status: 'submitted',
      occurred_at: '2026-10-28T10:00:01.000Z'
    }),
    event({
      event_id: 6,
      axis: 'execution',
      from_status: 'queued',
      to_status: 'running',
      occurred_at: '2026-10-28T10:00:02.000Z'
    })
  ]
  expect(latestTransitionAxis(events)).toBe('execution')
  expect(latestTransitionAxis([])).toBe('execution')
})

test('a transition lasts until the next event on the same axis', () => {
  const first = event({
    event_id: 7,
    from_status: 'pending',
    to_status: 'queued',
    occurred_at: '2026-10-28T10:00:00.000Z'
  })
  const second = event({
    event_id: 8,
    from_status: 'queued',
    to_status: 'running',
    occurred_at: '2026-10-28T10:00:05.000Z'
  })
  expect(
    transitionDuration(
      first,
      [first, second],
      run(),
      Date.parse('2026-10-28T10:00:10.000Z')
    )
  ).toStrictEqual({ kind: 'duration', ms: 5000 })
  expect(
    transitionDuration(
      second,
      [first, second],
      run(),
      Date.parse('2026-10-28T10:00:10.000Z')
    )
  ).toStrictEqual({ kind: 'duration', ms: 5000 })
})

test('a step transition lasts until the next event of the same step', () => {
  // Two steps of one publication move independently. Measuring a step against the next event
  // of a different step would report how long the other step waited, not this one.
  const step = (id: number, key: string, at: string): RunEvent =>
    event({
      event_id: id,
      axis: 'publication',
      step_key: key,
      from_status: 'pending',
      to_status: 'running',
      occurred_at: at
    })
  const comment = step(1, 'comment', '2026-10-28T10:00:00.000Z')
  const review = step(2, 'review', '2026-10-28T10:00:02.000Z')
  const commentDone = step(3, 'comment', '2026-10-28T10:00:07.000Z')
  expect(
    transitionDuration(
      comment,
      [comment, review, commentDone],
      run(),
      Date.parse('2026-10-28T10:01:00.000Z')
    )
  ).toStrictEqual({ kind: 'duration', ms: 7000 })
})

test('a step event opens its axis diagram', () => {
  expect(
    latestTransitionAxis([
      event({ event_id: 1, occurred_at: '2026-10-28T10:00:00.000Z' }),
      event({
        event_id: 2,
        axis: 'publication',
        step_key: 'comment',
        from_status: 'pending',
        to_status: 'running',
        occurred_at: '2026-10-28T10:00:05.000Z'
      })
    ])
  ).toBe('publication')
})

test('a terminal transition has no growing duration', () => {
  const terminal = event({
    event_id: 9,
    from_status: 'running',
    to_status: 'succeeded',
    occurred_at: '2026-10-28T10:00:05.000Z'
  })
  expect(
    transitionDuration(
      terminal,
      [terminal],
      run({
        execution: { finished_at: '2026-10-28T10:00:06.000Z' }
      } as Partial<Run>),
      Date.parse('2026-10-28T10:00:10.000Z')
    )
  ).toStrictEqual({ kind: 'final' })
})

test('transition explanations come from the state-machine edge', () => {
  expect(transitionExplanation(event({}), 'en')).toBe('input submitted')
})

test('transitions use a twelve-row page', () => {
  expect(TRANSITIONS_PAGE_SIZE).toBe(12)
})

test('operator conclusions retain their reason while absent and unknown reasons stay generic', async () => {
  const { stateMachine } =
    await import('../browser/features/runs/state-machines.generated.js')
  for (const language of ['en', 'zh'] as const) {
    const base = event({
      axis: 'preparation',
      from_status: 'disconnected',
      to_status: 'failed'
    })
    const explanations = new Set<string | null>()
    for (const reason of [
      'PREPARATION_GIVEN_UP_BY_OPERATOR',
      'PREPARATION_ABANDONED_BY_OPERATOR'
    ]) {
      const explanation = transitionExplanation(
        { ...base, reason_code: reason },
        language
      )
      expect.assert(explanation)
      explanations.add(explanation)
      const machine = stateMachine('preparation', language)
      const edge = machine.transitions.find(
        (item) =>
          item.from === 'disconnected' &&
          item.to === 'failed' &&
          item.reason === reason
      )
      expect.assert(edge)
      expect(edgeLabel(machine, edge)).toBe(explanation)
    }
    expect(explanations.size).toBe(2)
    // Every transition on this pair names a reason, so an absent or unknown reason identifies
    // none of the operator decisions: the explanation describes the reached state instead of
    // guessing a decision.
    const reached = stateMachine('preparation', language).details.failed
      ?.summary
    expect.assert(reached)
    expect.assert(!explanations.has(reached))
    expect(transitionExplanation(base, language)).toBe(reached)
    expect(
      transitionExplanation(
        { ...base, reason_code: 'UNKNOWN_REASON' },
        language
      )
    ).toBe(reached)
  }
})
