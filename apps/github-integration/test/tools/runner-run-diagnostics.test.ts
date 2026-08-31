import assert from 'node:assert/strict'
import test from 'node:test'

import {
  diagnosticsHelp,
  formatRunnerRunDiagnostics,
  parseDiagnosticsArgs
} from '../../tools/runner-run-diagnostics.js'
import type { RunnerRunDiagnosticRecord } from '../../infrastructure/runner/run-store.js'

function diagnosticRun (overrides: Partial<RunnerRunDiagnosticRecord> = {}): RunnerRunDiagnosticRecord {
  return {
    run_id: 'run-1',
    workflow: 'issue-review',
    publish_context: {},
    status: 'publish_failed',
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:01:00.000Z',
    published_at: null,
    publish_attempts: 2,
    failure_code: 'GITHUB_API_UNAVAILABLE',
    failure_message: 'GitHub API unavailable.',
    is_active: true,
    is_terminal: false,
    retry_exhausted: false,
    publish_attempts_remaining: 1,
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
  assert.deepEqual(parseDiagnosticsArgs(['--json', '--limit', '5', '--status', 'publish_failed']), {
    active_only: false,
    failed_only: false,
    help: false,
    json: true,
    limit: 5,
    status: 'publish_failed'
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

  assert.match(help, /Usage: sec-review-runner-runs/)
  assert.match(help, /--status <status>/)
  assert.match(help, /--active-only/)
  assert.match(help, /--failed-only/)
})

test('runner run diagnostics formats run state table', () => {
  const table = formatRunnerRunDiagnostics([
    diagnosticRun(),
    diagnosticRun({
      run_id: 'run-2',
      status: 'failed',
      is_active: false,
      is_terminal: true,
      retry_exhausted: false,
      publish_attempts_remaining: 0,
      failure_code: 'ISSUE_RESULT_INVALID'
    })
  ])

  assert.match(table, /^run_id\s+workflow\s+status\s+active\s+terminal\s+retry_exhausted/m)
  assert.match(table, /run-1\s+issue-review\s+publish_failed\s+yes\s+no\s+no\s+2\s+1\s+GITHUB_API_UNAVAILABLE/)
  assert.match(table, /run-2\s+issue-review\s+failed\s+no\s+yes\s+no\s+2\s+0\s+ISSUE_RESULT_INVALID/)
})
