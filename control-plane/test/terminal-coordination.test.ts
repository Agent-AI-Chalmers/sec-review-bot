import assert from 'node:assert/strict'
import test from 'node:test'

import {
  coordinateTerminalRun,
  type ReviewRunRecord,
  type TerminalCoordinationDependencies
} from '../src/index.js'

const run: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'issue-review',
  publish_context: {},
  status: 'queued',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  published_at: null,
  failure_code: null,
  failure_message: null,
  artifact_publication: null
}

function dependencies (
  overrides: Partial<TerminalCoordinationDependencies> = {}
): TerminalCoordinationDependencies {
  return {
    async getStatus () { return { status: 'running' } },
    describeError: error => ({
      code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null,
      message: error instanceof Error ? error.message : String(error)
    }),
    isTerminalPollingError: () => false,
    runnerFailureFromStatus: () => new Error('runner failed'),
    async publish () {},
    classifyPublicationFailure: error => ({
      retry: true,
      reason: 'transient',
      code: null,
      message: error instanceof Error ? error.message : String(error)
    }),
    ...overrides
  }
}

function store (overrides: Partial<Parameters<typeof coordinateTerminalRun>[0]> = {}): Parameters<typeof coordinateTerminalRun>[0] {
  return {
    async markRunning () {},
    async recordArtifactPublication () {},
    async failRunnerExecution () { return true },
    async claimPublication () { return null },
    async renewPublicationClaim () { return true },
    publicationHeartbeatIntervalMs () { return 60_000 },
    async completePublication () { return true },
    async failPublication () { return true },
    async getRun () { return run },
    ...overrides
  }
}

test('an active Runner execution advances to running without publication', async () => {
  const events: unknown[][] = []
  const result = await coordinateTerminalRun(store({
    async markRunning (runId) { events.push(['running', runId]) }
  }), run, dependencies())

  assert.deepEqual(result, { status: 'active' })
  assert.deepEqual(events, [['running', 'run-1']])
})

test('a failed Runner execution records its artifact and skips publication', async () => {
  const events: unknown[][] = []
  const runnerError = Object.assign(new Error('agent failed'), { code: 'AGENT_FAILED' })
  const result = await coordinateTerminalRun(store({
    async recordArtifactPublication (runId, artifact) { events.push(['artifact', runId, artifact]) },
    async failRunnerExecution (runId, failure) {
      events.push(['runner-failed', runId, failure])
      return true
    }
  }), run, dependencies({
    async getStatus () { return { status: 'failed', artifact_publication: { status: 'not_available' } } },
    runnerFailureFromStatus: () => runnerError,
    async publish () { assert.fail('failed Runner executions must not publish') }
  }))

  assert.equal(result.status, 'runner_failed')
  assert.deepEqual(events, [
    ['artifact', 'run-1', { status: 'not_available' }],
    ['runner-failed', 'run-1', { code: 'AGENT_FAILED', message: 'agent failed' }]
  ])
})

test('a transient publication failure returns the claim to pending', async () => {
  const remoteError = new Error('GitHub unavailable')
  const events: unknown[][] = []
  const result = await coordinateTerminalRun(store({
    async recordArtifactPublication () {},
    async claimPublication () { return 'claim-1' },
    async renewPublicationClaim () { return true },
    publicationHeartbeatIntervalMs () { return 60_000 },
    async failPublication (runId, token, failure, options) {
      events.push([runId, token, failure, options])
      return true
    },
    async getRun () { return run }
  }), run, dependencies({
    async getStatus () { return { status: 'succeeded' } },
    async publish () { throw remoteError }
  }))

  assert.deepEqual(result, {
    status: 'publication_failed',
    error: remoteError,
    failure: { retry: true, reason: 'transient', code: null, message: 'GitHub unavailable' },
    status_after: 'queued'
  })
  assert.deepEqual(events, [[
    'run-1',
    'claim-1',
    { code: null, message: 'GitHub unavailable' },
    { retry: true }
  ]])
})
