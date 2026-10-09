import test from 'node:test'
import assert from 'node:assert/strict'

import { observePublicationStep, observeRun } from '../src/observability.js'

test('observed run excludes internal inputs, publish context, and diagnostic messages', () => {
  const observed = observeRun({
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    runner_status: 'succeeded',
    publication_status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    published_at: null,
    failure_code: null,
    failure_message: 'request failed for https://secret@example.test/private',
    artifact_storage: null,
    runner_input: { secret: 'must-not-leak' },
    publish_context: { repository: 'octo/example' }
  })
  assert.deepEqual(observed, {
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    execution_status: 'succeeded',
    publication_status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    published_at: null,
    failure_code: null,
    artifact_storage: null
  })
})

test('publication step observation exposes operator outcomes without reconciliation ids', () => {
  const observed = observePublicationStep({
    step_key: 'issue:draft-pr',
    status: 'failed',
    failure_count: 2,
    remote_object_id: '142',
    remote_object_url: 'https://github.com/octo/example/pull/142',
    failure_code: 'GITHUB_SECONDARY_RATE_LIMIT',
    failure_message: 'GitHub temporarily limited publication.'
  })
  assert.deepEqual(observed, {
    step_key: 'issue:draft-pr',
    status: 'failed',
    failure_count: 2,
    remote_object_url: 'https://github.com/octo/example/pull/142',
    failure_code: 'GITHUB_SECONDARY_RATE_LIMIT',
    failure_message: 'GitHub temporarily limited publication.'
  })
  assert.equal('remote_object_id' in observed, false)
})
