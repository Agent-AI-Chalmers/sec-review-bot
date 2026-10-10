import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  getRunnerRunStatus,
  getRunnerRunStatuses,
  isTerminalRunnerPollingError,
  RUNNER_STATUS_QUERY_LIMIT,
  RunnerSubmissionUncertainError,
  submitRunnerRun
} from '../src/runner-client.js'
import { SPEC_PATH } from '../scripts/generate-runner-api-types.js'

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

test('status response validates an available artifact against the run identity', async () => {
  configureRunner()
  const artifactStorage = {
    status: 'available',
    artifact: {
      kind: 'diagnostic_bundle',
      uri: 's3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
      media_type: 'application/zstd',
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
        artifact_storage: artifactStorage
      })
    )

  assert.deepEqual((await getRunnerRunStatus('run-1')).artifact_storage, artifactStorage)
})

test('status response rejects an artifact reference owned by another run', async () => {
  configureRunner()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'succeeded',
        artifact_storage: {
          status: 'available',
          artifact: {
            kind: 'diagnostic_bundle',
            uri: 's3://sec-review/runs/run-2/artifacts/diagnostic-tree.v1.tar.zst',
            media_type: 'application/zstd',
            digest: `sha256:${'a'.repeat(64)}`,
            size_bytes: 42
          }
        }
      })
    )

  await assert.rejects(getRunnerRunStatus('run-1'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNNER_INVALID_ARTIFACT_STORAGE')
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

test('a status query is split into batches the runner accepts', async () => {
  // The runner rejects a longer batch, so a caller tracking more runs than the limit would
  // otherwise fail every pass and stop observing runs altogether.
  configureRunner()
  const sent: string[][] = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { run_ids: string[] }
    sent.push(body.run_ids)
    return new Response(
      JSON.stringify({
        runs: body.run_ids.map((runId) => ({ run_id: runId, status: 'running' })),
        missing: []
      }),
      { status: 200 }
    )
  }

  const runIds = Array.from({ length: RUNNER_STATUS_QUERY_LIMIT + 1 }, (_, index) => `run-${index}`)
  const batch = await getRunnerRunStatuses(runIds)

  assert.equal(sent.length, 2)
  assert.equal(sent[0]?.length, RUNNER_STATUS_QUERY_LIMIT)
  assert.equal(sent[1]?.length, 1)
  // Split requests must still answer in the order the caller asked about runs.
  assert.deepEqual(
    batch.runs.map((entry) => entry.run_id),
    runIds
  )
  assert.equal(batch.byRunId.get('run-0'), 'running')
  assert.deepEqual(batch.missing, [])
})

test('the status batch size is the limit the contract publishes', () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as {
    components: {
      schemas: { RunStatusQuery: { properties: { run_ids: { maxItems: number } } } }
    }
  }

  assert.equal(
    spec.components.schemas.RunStatusQuery.properties.run_ids.maxItems,
    RUNNER_STATUS_QUERY_LIMIT
  )
})
