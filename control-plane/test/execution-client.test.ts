import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

import {
  getExecutionRunStatus,
  getExecutionRunStatuses,
  isTerminalExecutionPollingError,
  EXECUTION_STATUS_QUERY_LIMIT,
  ExecutionSubmissionUncertainError,
  submitExecutionRun
} from '../src/execution-client.js'
import { EXECUTION_API_SPEC_PATH as SPEC_PATH } from './generated-paths.js'

const originalFetch = globalThis.fetch

function configureExecution(): void {
  process.env.EXECUTION_API_URL = 'https://execution.test'
  process.env.EXECUTION_API_TOKEN = 'test-token'
  process.env.EXECUTION_API_REQUEST_RETRIES = '0'
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.EXECUTION_API_URL
  delete process.env.EXECUTION_API_TOKEN
  delete process.env.EXECUTION_API_REQUEST_RETRIES
  delete process.env.EXECUTION_API_REQUEST_TIMEOUT_MS
  delete process.env.EXECUTION_API_RETRY_BASE_DELAY_MS
})

test('invalid request configuration fails instead of using a fallback', async () => {
  configureExecution()
  process.env.EXECUTION_API_REQUEST_TIMEOUT_MS = '1000ms'
  let fetched = false
  globalThis.fetch = async () => {
    fetched = true
    return new Response('{}', { status: 200 })
  }

  await assert.rejects(
    getExecutionRunStatus('run-1'),
    /EXECUTION_API_REQUEST_TIMEOUT_MS must be a decimal integer/
  )
  assert.strictEqual(fetched, false)
})

test('out-of-range request configuration fails instead of using a fallback', async () => {
  configureExecution()
  process.env.EXECUTION_API_RETRY_BASE_DELAY_MS = '0'

  await assert.rejects(
    getExecutionRunStatus('run-1'),
    /EXECUTION_API_RETRY_BASE_DELAY_MS must be at least 1/
  )
})

test('submission sends authentication and accepts only the expected identity', async () => {
  configureExecution()
  globalThis.fetch = async (input, init) => {
    assert.strictEqual(
      input,
      'https://execution.test/v1/workflows/issue-review/runs'
    )
    assert.strictEqual(
      (init?.headers as Record<string, string>).authorization,
      'Bearer test-token'
    )
    return new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'queued'
      }),
      { status: 200 }
    )
  }

  await submitExecutionRun({
    workflow: 'issue-review',
    run_id: 'run-1',
    input: { contract_version: 'v6' }
  })
})

test('mismatched submission identity remains recoverable uncertainty', async () => {
  configureExecution()
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
    submitExecutionRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    }),
    ExecutionSubmissionUncertainError
  )
})

test('status response cannot substitute another run or workflow', async () => {
  configureExecution()
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

  await assert.rejects(getExecutionRunStatus('run-1'), (error: unknown) => {
    assert.match((error as Error).message, /unexpected run_id/)
    assert.strictEqual(isTerminalExecutionPollingError(error), true)
    return true
  })
})

test('malformed successful status response is a terminal protocol failure', async () => {
  configureExecution()
  globalThis.fetch = async () => new Response('{invalid', { status: 200 })

  await assert.rejects(getExecutionRunStatus('run-1'), (error: unknown) => {
    assert.strictEqual(
      (error as { code?: string }).code,
      'EXECUTION_INVALID_JSON'
    )
    assert.strictEqual(isTerminalExecutionPollingError(error), true)
    return true
  })
})

test('malformed transient error response remains retryable', async () => {
  configureExecution()
  globalThis.fetch = async () => new Response('{invalid', { status: 500 })

  await assert.rejects(getExecutionRunStatus('run-1'), (error: unknown) => {
    assert.strictEqual(
      (error as { name?: string }).name,
      'ExecutionServiceError'
    )
    assert.strictEqual(isTerminalExecutionPollingError(error), false)
    return true
  })
})

test('status response must match the persisted workflow', async () => {
  configureExecution()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'repository-review',
        status: 'running'
      }),
      { status: 200 }
    )

  await assert.rejects(
    getExecutionRunStatus('run-1', 'issue-review'),
    /unexpected workflow/
  )
})

test('status response preserves a valid terminal result', async () => {
  configureExecution()
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

  assert.deepStrictEqual(await getExecutionRunStatus('run-1'), {
    run_id: 'run-1',
    workflow: 'pull-request-review',
    status: 'succeeded',
    result: { answer: 42 }
  })
})

test('status response validates an available artifact against the run identity', async () => {
  configureExecution()
  const artifactStorage = {
    status: 'available',
    artifact: {
      kind: 'diagnostic_bundle',
      uri: 's3://deployment-bucket/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
      media_type: 'application/tar+zstd',
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

  assert.deepStrictEqual(
    (await getExecutionRunStatus('run-1')).artifact_storage,
    artifactStorage
  )
})

test('status response rejects an artifact reference owned by another run', async () => {
  configureExecution()
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
            media_type: 'application/tar+zstd',
            digest: `sha256:${'a'.repeat(64)}`,
            size_bytes: 42
          }
        }
      })
    )

  await assert.rejects(getExecutionRunStatus('run-1'), (error: unknown) => {
    assert.strictEqual(
      (error as { code?: string }).code,
      'EXECUTION_INVALID_ARTIFACT_STORAGE'
    )
    return true
  })
})

test('status response rejects an unknown Execution state', async () => {
  configureExecution()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'completed'
      }),
      { status: 200 }
    )

  await assert.rejects(getExecutionRunStatus('run-1'), (error: unknown) => {
    assert.strictEqual(
      (error as { code?: string }).code,
      'EXECUTION_INVALID_STATUS'
    )
    assert.strictEqual((error as { retryable?: boolean }).retryable, false)
    return true
  })
})

test('a status query is split into batches the Execution API accepts', async () => {
  // The Execution API rejects a longer batch, so a caller tracking more runs than the limit would
  // otherwise fail every pass and stop observing runs altogether.
  configureExecution()
  const sent: string[][] = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { run_ids: string[] }
    sent.push(body.run_ids)
    return new Response(
      JSON.stringify({
        runs: body.run_ids.map((runId) => ({
          run_id: runId,
          status: 'running'
        })),
        missing: []
      }),
      { status: 200 }
    )
  }

  const runIds = Array.from(
    { length: EXECUTION_STATUS_QUERY_LIMIT + 1 },
    (_, index) => `run-${index}`
  )
  const batch = await getExecutionRunStatuses(runIds)

  assert.strictEqual(sent.length, 2)
  assert.strictEqual(sent[0]?.length, EXECUTION_STATUS_QUERY_LIMIT)
  assert.strictEqual(sent[1]?.length, 1)
  // Split requests must still answer in the order the caller asked about runs.
  assert.deepStrictEqual(
    batch.runs.map((entry) => entry.run_id),
    runIds
  )
  assert.strictEqual(batch.byRunId.get('run-0'), 'running')
  assert.deepStrictEqual(batch.missing, [])
})

test('the status batch size is the limit the contract publishes', () => {
  const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
    components: {
      schemas: {
        RunStatusQuery: { properties: { run_ids: { maxItems: number } } }
      }
    }
  }

  assert.strictEqual(
    spec.components.schemas.RunStatusQuery.properties.run_ids.maxItems,
    EXECUTION_STATUS_QUERY_LIMIT
  )
})
