import assert from 'node:assert/strict'
import test from 'node:test'

import { completedRunnerRunResult } from '../../src/infrastructure/runner/client.js'

test('completedRunnerRunResult returns the persisted successful result', () => {
  assert.deepEqual(completedRunnerRunResult({ run_id: 'run-1', workflow: 'issue-review', status: 'succeeded', result: { answer: 42 } }), {
    run_id: 'run-1', workflow: 'issue-review', result: { answer: 42 }
  })
})

test('completedRunnerRunResult rejects persisted Runner errors', () => {
  assert.throws(() => completedRunnerRunResult({
    run_id: 'run-1', workflow: 'issue-review', status: 'failed',
    error: { code: 'AGENT_FAILED', message: 'analysis failed', retryable: false }
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'AGENT_FAILED')
})

test('completedRunnerRunResult ignores nonterminal states', () => {
  assert.equal(completedRunnerRunResult({ run_id: 'run-1', workflow: 'issue-review', status: 'running' }), null)
})
