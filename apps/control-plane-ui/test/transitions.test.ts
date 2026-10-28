import assert from 'node:assert/strict'
import test from 'node:test'

import type { Run, RunEvent } from '../browser/features/runs/api.js'
import { STATE_MACHINES } from '../browser/features/runs/state-machines.generated.js'
import {
  TRANSITIONS_PAGE_SIZE,
  actualTransitions,
  latestTransitionAxis,
  transitionDuration,
  transitionExplanation
} from '../browser/features/runs/transitions.js'

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    event_id: 1,
    axis: 'execution',
    from_status: 'pending',
    to_status: 'queued',
    reason_code: null,
    occurred_at: '2026-10-28T10:00:00.000Z',
    ...overrides
  } as RunEvent
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
  assert.deepStrictEqual(
    actualTransitions([initial, actual]).map((candidate) => candidate.event_id),
    [3]
  )
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
  assert.strictEqual(latestTransitionAxis(events), 'execution')
  assert.strictEqual(latestTransitionAxis([]), 'execution')
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
  assert.deepStrictEqual(
    transitionDuration(
      first,
      [first, second],
      run(),
      STATE_MACHINES,
      Date.parse('2026-10-28T10:00:10.000Z')
    ),
    { kind: 'duration', ms: 5000 }
  )
  assert.deepStrictEqual(
    transitionDuration(
      second,
      [first, second],
      run(),
      STATE_MACHINES,
      Date.parse('2026-10-28T10:00:10.000Z')
    ),
    { kind: 'duration', ms: 5000 }
  )
})

test('a terminal transition has no growing duration', () => {
  const terminal = event({
    event_id: 9,
    from_status: 'running',
    to_status: 'succeeded',
    occurred_at: '2026-10-28T10:00:05.000Z'
  })
  assert.deepStrictEqual(
    transitionDuration(
      terminal,
      [terminal],
      run({
        execution: { finished_at: '2026-10-28T10:00:06.000Z' }
      } as Partial<Run>),
      STATE_MACHINES,
      Date.parse('2026-10-28T10:00:10.000Z')
    ),
    { kind: 'final' }
  )
})

test('transition explanations come from the state-machine edge', () => {
  assert.strictEqual(
    transitionExplanation(event({}), STATE_MACHINES, (key) => key),
    'input submitted'
  )
})

test('transitions use a twelve-row page', () => {
  assert.strictEqual(TRANSITIONS_PAGE_SIZE, 12)
})
