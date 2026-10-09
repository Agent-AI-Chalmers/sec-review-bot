import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRunnerRunStatus,
  isTerminalRunnerPollingError,
  RunnerSubmissionUncertainError,
  submitRunnerRun
} from '../src/runner-client.js'

const originalFetch = globalThis.fetch

function configureRunner(): void {
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
    return new Response(
      JSON.stringify({ run_id: 'run-1', workflow: 'issue-review', status: 'queued' }),
      { status: 200 }
    )
  }

  await submitRunnerRun({
    workflow: 'issue-review',
    run_id: 'run-1',
    input: { contract_version: 'v5' }
  })
})

test('mismatched submission identity remains recoverable uncertainty', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'another-run',
        workflow: 'issue-review',
        status: 'queued'
      }),
      { status: 200 }
    )

  await assert.rejects(
    submitRunnerRun({ workflow: 'issue-review', run_id: 'run-1', input: {} }),
    RunnerSubmissionUncertainError
  )
})

test('status response cannot substitute another run or workflow', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-2',
        workflow: 'repository-review',
        status: 'succeeded',
        result: {}
      }),
      { status: 200 }
    )

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.match((error as Error).message, /unexpected run_id/)
    assert.equal(isTerminalRunnerPollingError(error), true)
    return true
  })
})

test('malformed successful status response is a terminal protocol failure', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response('{invalid', { status: 200 })

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNNER_INVALID_JSON')
    assert.equal(isTerminalRunnerPollingError(error), true)
    return true
  })
})

test('malformed transient error response remains retryable', async () => {
  configureRunner()
  globalThis.fetch = async () => new Response('{invalid', { status: 500 })

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.equal((error as { name?: string }).name, 'AgentRunnerServiceError')
    assert.equal(isTerminalRunnerPollingError(error), false)
    return true
  })
})

test('status response must match the persisted workflow', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'repository-review',
        status: 'running'
      }),
      { status: 200 }
    )

  await assert.rejects(getRunnerRunStatus('run-1', 'issue-review'), /unexpected workflow/)
})

test('status response preserves a valid terminal result', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'pull-request-review',
        status: 'succeeded',
        result: { answer: 42 }
      }),
      { status: 200 }
    )

  assert.deepEqual(await getRunnerRunStatus('run-1'), {
    run_id: 'run-1',
    workflow: 'pull-request-review',
    status: 'succeeded',
    result: { answer: 42 }
  })
})

test('status response validates a published artifact against the run identity', async () => {
  configureRunner()
  const artifactPublication = {
    status: 'published',
    artifact: {
      kind: 'diagnostic_bundle',
      uri: 's3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
      media_type: 'application/vnd.sec-review.diagnostic.v1+tar+zstd',
      digest: `sha256:${'a'.repeat(64)}`,
      size_bytes: 42
    }
  }
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'succeeded',
        artifact_publication: artifactPublication
      })
    )

  assert.deepEqual((await getRunnerRunStatus('run-1')).artifact_publication, artifactPublication)
})

test('status response rejects an artifact reference owned by another run', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'succeeded',
        artifact_publication: {
          status: 'published',
          artifact: {
            kind: 'diagnostic_bundle',
            uri: 's3://sec-review/runs/run-2/artifacts/diagnostic-tree.v1.tar.zst',
            media_type: 'application/vnd.sec-review.diagnostic.v1+tar+zstd',
            digest: `sha256:${'a'.repeat(64)}`,
            size_bytes: 42
          }
        }
      })
    )

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNNER_INVALID_ARTIFACT_PUBLICATION')
    return true
  })
})

test('status response rejects an unknown Runner state', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ run_id: 'run-1', workflow: 'issue-review', status: 'completed' }),
      { status: 200 }
    )

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNNER_INVALID_STATUS')
    assert.equal((error as { retryable?: boolean }).retryable, false)
    return true
  })
})
