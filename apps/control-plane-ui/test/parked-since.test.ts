import { expect, test } from 'vitest'

import type { Run, RunEvent } from '../browser/features/runs/api.js'
import { parkedSince } from '../browser/features/runs/format.js'

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    event_id: 1,
    axis: 'publication',
    step_key: null,
    from_status: 'uncertain',
    to_status: 'disconnected',
    reason_code: null,
    occurred_at: '2026-10-28T10:00:00.000Z',
    ...overrides
  } as RunEvent
}

const run = {
  publication: { updated_at: '2026-10-28T11:00:00.000Z' }
} as Run

test('a step parking after its axis does not move the axis park time', () => {
  // Step events share the publication axis. Taking a later step's park as the axis' would make
  // the run look as if it had waited for an operator for less time than it has.
  expect(
    parkedSince(run, 'publication', [
      event({ event_id: 1, occurred_at: '2026-10-28T10:00:00.000Z' }),
      event({
        event_id: 2,
        step_key: 'issue:first',
        from_status: 'uncertain',
        occurred_at: '2026-10-28T10:00:00.000Z'
      }),
      event({
        event_id: 3,
        step_key: 'issue:second',
        from_status: 'uncertain',
        occurred_at: '2026-10-28T10:30:00.000Z'
      })
    ])
  ).toBe('2026-10-28T10:00:00.000Z')
})

test('without an axis park event, the park time is the axis last write', () => {
  expect(
    parkedSince(run, 'publication', [
      event({
        step_key: 'issue:first',
        occurred_at: '2026-10-28T10:30:00.000Z'
      })
    ])
  ).toBe('2026-10-28T11:00:00.000Z')
})
