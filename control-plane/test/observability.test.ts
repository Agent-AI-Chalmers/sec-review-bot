import test from 'node:test'
import assert from 'node:assert/strict'

import { observeRun } from '../src/observability.js'

test('observed run excludes internal inputs, publish context, and diagnostic messages', () => {
  const observed = observeRun({
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: 'request failed for https://secret@example.test/private',
    artifact_publication: null,
    runner_input: { secret: 'must-not-leak' },
    publish_context: { repository: 'octo/example' }
  })
  assert.deepEqual(observed, {
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    published_at: null,
    failure_code: null,
    artifact_publication: null
  })
})
