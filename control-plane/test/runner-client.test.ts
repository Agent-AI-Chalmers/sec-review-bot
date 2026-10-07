import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRunnerRunStatus,
  RunnerSubmissionUncertainError,
  submitRunnerRun
} from '../src/runner-client.js'

const originalFetch = globalThis.fetch

function configureRunner (): void {
  process.env.AGENT_RUNNER_SERVICE_URL = 'https://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'test-token'
  process.env.AGENT_RUNNER_SERVICE_REQUEST_RETRIES = '0'
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.AGENT_RUNNER_SERVICE_URL
  delete process.env.AGENT_RUNNER_SERVICE_TOKEN
  delete process.env.AGENT_RUNNER_SERVICE_REQUEST_RETRIES
})

test('submission sends authentication and accepts only the expected identity', async () => {
  configureRunner()
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://runner.test/v1/workflows/issue-review/runs')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-token')
    return new Response(JSON.stringify({ run_id: 'run-1', workflow: 'issue-review', status: 'queued' }), { status: 200 })
  }

  await submitRunnerRun({ workflow: 'issue-review', run_id: 'run-1', input: { contract_version: 'v5' } })
})

test('mismatched submission identity remains recoverable uncertainty', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response(JSON.stringify({
    run_id: 'another-run', workflow: 'issue-review', status: 'queued'
  }), { status: 200 })

  await assert.rejects(
    submitRunnerRun({ workflow: 'issue-review', run_id: 'run-1', input: {} }),
    RunnerSubmissionUncertainError
  )
})

test('status response cannot substitute another run or workflow', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response(JSON.stringify({
    run_id: 'run-2', workflow: 'repository-review', status: 'succeeded', result: {}
  }), { status: 200 })

  await assert.rejects(getRunnerRunStatus('run-1'), /unexpected run_id/)
})

test('status response must match the persisted workflow', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response(JSON.stringify({
    run_id: 'run-1', workflow: 'repository-review', status: 'running'
  }), { status: 200 })

  await assert.rejects(getRunnerRunStatus('run-1', 'issue-review'), /unexpected workflow/)
})

test('status response preserves a valid terminal result', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response(JSON.stringify({
    run_id: 'run-1', workflow: 'pull-request-review', status: 'succeeded', result: { answer: 42 }
  }), { status: 200 })

  assert.deepEqual(await getRunnerRunStatus('run-1'), {
    run_id: 'run-1', workflow: 'pull-request-review', status: 'succeeded', result: { answer: 42 }
  })
})
