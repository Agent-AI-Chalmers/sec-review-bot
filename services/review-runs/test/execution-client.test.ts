import { readFileSync } from 'node:fs'
import { ReadableStream } from 'node:stream/web'
import { expect, afterEach, test } from 'vitest'
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

afterEach(() => {
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

  await expect(getExecutionRunStatus('run-1')).rejects.toThrow(
    /EXECUTION_API_REQUEST_TIMEOUT_MS must be a decimal integer/
  )
  expect(fetched).toBe(false)
})

test('out-of-range request configuration fails instead of using a fallback', async () => {
  configureExecution()
  process.env.EXECUTION_API_RETRY_BASE_DELAY_MS = '0'

  await expect(getExecutionRunStatus('run-1')).rejects.toThrow(
    /EXECUTION_API_RETRY_BASE_DELAY_MS must be at least 1/
  )
})

test('submission sends authentication and accepts only the expected identity', async () => {
  configureExecution()
  globalThis.fetch = async (input, init) => {
    expect(input).toBe('https://execution.test/v1/workflows/issue-review/runs')
    expect(
      (init?.headers as Record<string, string> | undefined)?.authorization
    ).toBe('Bearer test-token')
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
    input: { api_version: 'v1' }
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

  await expect(
    submitExecutionRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    })
  ).rejects.toThrow(ExecutionSubmissionUncertainError)
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

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as Error).message).toMatch(/unexpected run_id/)
      expect(isTerminalExecutionPollingError(error)).toBe(true)
      return true
    }
  )
})

test('malformed successful status response is a terminal protocol failure', async () => {
  configureExecution()
  globalThis.fetch = async () => new Response('{invalid', { status: 200 })

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as { code?: string }).code).toBe('EXECUTION_INVALID_JSON')
      expect(isTerminalExecutionPollingError(error)).toBe(true)
      return true
    }
  )
})

test('oversized successful status response is a terminal protocol failure', async () => {
  configureExecution()
  let bodyCancelled = false
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel(): void {
          bodyCancelled = true
        }
      }),
      {
        status: 200,
        headers: { 'content-length': String(4 * 1024 * 1024 + 1) }
      }
    )

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as { code?: string }).code).toBe(
        'EXECUTION_RESPONSE_TOO_LARGE'
      )
      expect(isTerminalExecutionPollingError(error)).toBe(true)
      return true
    }
  )
  expect(bodyCancelled).toBe(true)
})

test('malformed transient error response remains retryable', async () => {
  configureExecution()
  globalThis.fetch = async () => new Response('{invalid', { status: 500 })

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as { name?: string }).name).toBe('ExecutionServiceError')
      expect(isTerminalExecutionPollingError(error)).toBe(false)
      return true
    }
  )
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

  await expect(getExecutionRunStatus('run-1', 'issue-review')).rejects.toThrow(
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

  expect(await getExecutionRunStatus('run-1')).toStrictEqual({
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
      kind: 'execution_archive',
      uri: 's3://deployment-bucket/runs/run-1/artifacts/execution-archive.v1.tar.zst',
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

  expect((await getExecutionRunStatus('run-1')).artifact_storage).toStrictEqual(
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
            kind: 'execution_archive',
            uri: 's3://sec-review/runs/run-2/artifacts/execution-archive.v1.tar.zst',
            media_type: 'application/tar+zstd',
            digest: `sha256:${'a'.repeat(64)}`,
            size_bytes: 42
          }
        }
      })
    )

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as { code?: string }).code).toBe(
        'EXECUTION_INVALID_ARTIFACT_STORAGE'
      )
      return true
    }
  )
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

  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (error: unknown) => {
      expect((error as { code?: string }).code).toBe('EXECUTION_INVALID_STATUS')
      expect((error as { retryable?: boolean }).retryable).toBe(false)
      return true
    }
  )
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

  expect(sent).toHaveLength(2)
  expect(sent[0]?.length).toBe(EXECUTION_STATUS_QUERY_LIMIT)
  expect(sent[1]?.length).toBe(1)
  // Split requests must still answer in the order the caller asked about runs.
  expect(batch.runs.map((entry) => entry.run_id)).toStrictEqual(runIds)
  expect(batch.byRunId.get('run-0')).toBe('running')
  expect(batch.missing).toStrictEqual([])
})

test('the status batch size is the limit the contract publishes', () => {
  const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
    components: {
      schemas: {
        RunStatusQuery: { properties: { run_ids: { maxItems: number } } }
      }
    }
  }

  expect(
    spec.components.schemas.RunStatusQuery.properties.run_ids.maxItems
  ).toBe(EXECUTION_STATUS_QUERY_LIMIT)
})

for (const error of [
  { category: ['runtime'], code: 'FAIL', message: 'failed', retryable: false },
  { category: 'runtime', code: 42, message: 'failed', retryable: false },
  { category: 'runtime', code: 'FAIL', message: {}, retryable: false },
  { category: 'runtime', code: 'FAIL', message: 'failed', retryable: 'false' },
  {
    category: 'runtime',
    code: 'FAIL',
    message: 'failed',
    retryable: false,
    details: []
  }
]) {
  test(`rejects malformed terminal error fields: ${JSON.stringify(error)}`, async () => {
    configureExecution()
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          run_id: 'run-1',
          workflow: 'issue-review',
          status: 'failed',
          error
        }),
        { status: 200 }
      )
    await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
      (failure: unknown) => {
        expect(isTerminalExecutionPollingError(failure)).toBe(true)
        expect((failure as { code?: string }).code).toBe(
          'EXECUTION_INVALID_RESPONSE'
        )
        return true
      }
    )
  })
}

test('malformed HTTP error fields cannot override retry behavior with coerced values', async () => {
  configureExecution()
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          category: 'runtime',
          code: 42,
          message: {},
          retryable: 'false'
        }
      }),
      { status: 503 }
    )
  await expect(getExecutionRunStatus('run-1')).rejects.toSatisfy(
    (failure: unknown) => {
      expect(isTerminalExecutionPollingError(failure)).toBe(false)
      expect((failure as { code?: string }).code).toBe('EXECUTION_API_ERROR')
      expect((failure as Error).message).toBe('Execution returned HTTP 503.')
      return true
    }
  )
})

test('preserves a fully validated terminal Execution error', async () => {
  configureExecution()
  const error = {
    category: 'runtime',
    code: 'FAIL',
    message: 'failed',
    retryable: false,
    details: { step: 'publish' }
  }
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        run_id: 'run-1',
        workflow: 'issue-review',
        status: 'failed',
        error
      }),
      { status: 200 }
    )
  expect((await getExecutionRunStatus('run-1')).error).toStrictEqual(error)
})
