import test from 'node:test'
import assert from 'node:assert/strict'

import { observePublicationStep, observeRun } from '../src/observability.js'

test('observed run excludes internal inputs, publish context, and diagnostic messages', () => {
  const observed = observeRun({
    run_id: 'run-1',
    workflow: 'issue-review',
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:10.000Z',
      finished_at: '2026-01-01T00:00:30.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      failure_notice_status: null
    },
    execution: {
      status: 'succeeded',
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z'
    },
    publication: {
      status: 'pending',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-01-01T00:00:00.000Z',
    failure_code: null,
    failure_message: 'request failed for https://secret@example.test/private',
    artifact_storage: null,
    runner_input: { secret: 'must-not-leak' },
    publish_context: { repository: 'octo/example' }
  })
  assert.deepStrictEqual(observed, {
    run_id: 'run-1',
    workflow: 'issue-review',
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:10.000Z',
      finished_at: '2026-01-01T00:00:30.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      failure_notice_status: null
    },
    execution: {
      status: 'succeeded',
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z'
    },
    publication: {
      status: 'pending',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-01-01T00:00:00.000Z',
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
  assert.deepStrictEqual(observed, {
    step_key: 'issue:draft-pr',
    status: 'failed',
    failure_count: 2,
    remote_object_url: 'https://github.com/octo/example/pull/142',
    failure_code: 'GITHUB_SECONDARY_RATE_LIMIT',
    failure_message: 'GitHub temporarily limited publication.'
  })
  assert.strictEqual('remote_object_id' in observed, false)
})
