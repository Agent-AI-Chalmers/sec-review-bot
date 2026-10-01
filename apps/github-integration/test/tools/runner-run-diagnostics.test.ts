import assert from 'node:assert/strict'
import test from 'node:test'

import {
  diagnosticsHelp,
  formatReviewRunDiagnostics,
  parseDiagnosticsArgs
} from '../../tools/runner-run-diagnostics.js'
import type { ReviewRunDiagnosticRecord } from '../../infrastructure/runner/review-store.js'

function diagnosticRun (overrides: Partial<ReviewRunDiagnosticRecord> = {}): ReviewRunDiagnosticRecord {
  return {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    status: 'queued',
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:01:00.000Z',
    published_at: null,
    failure_code: 'GITHUB_API_UNAVAILABLE',
    failure_message: 'GitHub API unavailable.',
    runner_status: 'queued',
    runner_failure_code: null,
    runner_failure_message: null,
    publication_status: 'pending',
    publication_failure_code: null,
    publication_failure_message: null,
    failed_steps: [],
    is_active: true,
    is_terminal: false,
    ...overrides
  }
}

test('runner run diagnostics parses table and json options', () => {
  assert.deepEqual(parseDiagnosticsArgs([]), {
    active_only: false,
    failed_only: false,
    help: false,
    json: false,
    limit: 25,
    status: null
  })
  assert.deepEqual(parseDiagnosticsArgs(['--json', '--limit', '5', '--status', 'queued']), {
    active_only: false,
    failed_only: false,
    help: false,
    json: true,
    limit: 5,
    status: 'queued'
  })
  assert.deepEqual(parseDiagnosticsArgs(['--limit=7', '--status=failed', '--active-only']), {
    active_only: true,
    failed_only: false,
    help: false,
    json: false,
    limit: 7,
    status: 'failed'
  })
  assert.deepEqual(parseDiagnosticsArgs(['--help']), {
    active_only: false,
    failed_only: false,
    help: true,
    json: false,
    limit: 25,
    status: null
  })
})

test('runner run diagnostics rejects invalid limit options', () => {
  assert.throws(
    () => parseDiagnosticsArgs(['--limit']),
    /--limit requires a positive integer value/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--limit', '--json']),
    /--limit requires a positive integer value/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--limit=0']),
    /--limit requires a positive integer value/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--limit=5x']),
    /--limit requires a positive integer value/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--unknown']),
    /Unknown argument: --unknown/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--status']),
    /--status requires a runner run status value/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--status=done']),
    /--status must be one of/
  )
  assert.throws(
    () => parseDiagnosticsArgs(['--active-only', '--failed-only']),
    /--active-only and --failed-only cannot be used together/
  )
})

test('runner run diagnostics help documents filters', () => {
  const help = diagnosticsHelp()

  assert.match(help, /Usage: sec-review-review-runs/)
  assert.match(help, /--status <status>/)
  assert.match(help, /--active-only/)
  assert.match(help, /--failed-only/)
})

test('runner run diagnostics formats run state table', () => {
  const table = formatReviewRunDiagnostics([
    diagnosticRun(),
    diagnosticRun({
      run_id: 'run-2',
      status: 'failed',
      is_active: false,
      is_terminal: true,
      runner_status: 'failed',
      runner_failure_code: 'RUNNER_EXECUTION_FAILED',
      publication_status: 'not_required',
      failure_code: 'RUNNER_EXECUTION_FAILED'
    })
  ])

  assert.match(table, /^run_id\s+workflow\s+runner_status\s+publication_status/m)
  assert.match(table, /run-1\s+issue-review\s+queued\s+pending\s+yes\s+no/)
  assert.match(table, /run-2\s+issue-review\s+failed\s+not_required\s+no\s+yes\s+RUNNER_EXECUTION_FAILED/)
})

test('runner run diagnostics displays publication and step failures separately', () => {
  const table = formatReviewRunDiagnostics([diagnosticRun({
    publication_status: 'failed',
    publication_failure_code: 'GITHUB_VALIDATION_REJECTED',
    failed_steps: [{
      step_key: 'repository:delivery:delivery-1',
      status: 'terminal_failed',
      attempts: 1,
      remote_object_id: null,
      remote_object_url: null,
      failure_code: 'GITHUB_VALIDATION_REJECTED',
      failure_message: 'Validation failed.'
    }]
  })])

  assert.match(table, /GITHUB_VALIDATION_REJECTED/)
  assert.match(table, /repository:delivery:delivery-1:GITHUB_VALIDAT\.\.\./)
})
