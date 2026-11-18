import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import {
  ExecutionRunConflictError,
  type ExecutionRecord,
  type ExecutionWorkflowInput
} from '../src/execution.js'
import { createApp } from '../src/server.js'

class FakeExecutionRunClient {
  readonly records = new Map<string, ExecutionRecord>()
  conflict = false
  startError: Error | undefined

  start(request: ExecutionWorkflowInput): Promise<ExecutionRecord> {
    if (this.startError) return Promise.reject(this.startError)
    if (this.conflict) {
      throw new ExecutionRunConflictError(request.run_id, request.workflow, 'issue-review')
    }
    const record: ExecutionRecord = {
      run_id: request.run_id,
      workflow: request.workflow,
      status: 'running'
    }
    this.records.set(request.run_id, record)
    return Promise.resolve(record)
  }

  get(runId: string): Promise<ExecutionRecord | undefined> {
    return Promise.resolve(this.records.get(runId))
  }
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.resolve('../..', 'contracts', 'execution-api', 'v1', 'fixtures', name),
      'utf8'
    )
  ) as Record<string, unknown>
}

test('health endpoint remains public when API authentication is configured', async () => {
  const app = await createApp({
    client: new FakeExecutionRunClient(),
    token: 'secret'
  })
  const response = await app.inject({ method: 'GET', url: '/healthz' })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toStrictEqual({ status: 'ok' })
  await app.close()
})

test('invalid workflow timeout fails while creating the app', async (t) => {
  process.env.TEMPORAL_WORKFLOW_TIMEOUT_SECONDS = '10800ms'
  t.onTestFinished(() => {
    delete process.env.TEMPORAL_WORKFLOW_TIMEOUT_SECONDS
  })

  await expect(createApp({ client: new FakeExecutionRunClient() })).rejects.toThrow(
    /TEMPORAL_WORKFLOW_TIMEOUT_SECONDS must be a decimal integer/
  )
})

test('creates and reads an execution run', async () => {
  const client = new FakeExecutionRunClient()
  const app = await createApp({ client, token: 'secret' })
  const create = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    headers: { authorization: 'Bearer secret' },
    payload: {
      run_id: 'run-1',
      input: fixture('issue-review-input.json')
    }
  })
  expect(create.statusCode).toBe(202)
  expect(create.body).toMatch(/"status":"running"/)

  const read = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-1',
    headers: { authorization: 'Bearer secret' }
  })
  expect(read.statusCode).toBe(200)
  expect(read.body).toMatch(/"run_id":"run-1"/)
  await app.close()
})

test('rejects requests that violate the workflow input contract', async () => {
  const app = await createApp({ client: new FakeExecutionRunClient() })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    payload: { run_id: 'run-invalid', input: {} }
  })
  expect(response.statusCode).toBe(400)
  const body = response.json<{
    run_id: string
    workflow: string
    error: Record<string, unknown>
  }>()
  expect({
    ...body,
    error: { ...body.error, message: undefined }
  }).toStrictEqual({
    run_id: 'run-invalid',
    workflow: 'issue-review',
    error: {
      category: 'input',
      code: 'EXECUTION_REQUEST_INVALID',
      message: undefined,
      retryable: false,
      details: {}
    }
  })
  expect(typeof body.error.message).toBe('string')
  await app.close()
})

test('requires the configured bearer token', async () => {
  const app = await createApp({
    client: new FakeExecutionRunClient(),
    token: 'secret'
  })
  const response = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-1'
  })
  expect(response.statusCode).toBe(401)
  expect(response.json()).toStrictEqual({
    error: {
      category: 'runtime',
      code: 'UNAUTHORIZED',
      message: 'None of the security schemes (HTTPBearer) successfully authenticated this request.',
      retryable: false,
      details: {}
    }
  })
  await app.close()
})

test('returns missing runs in the public error envelope', async () => {
  const app = await createApp({ client: new FakeExecutionRunClient() })
  const response = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-missing'
  })
  expect(response.statusCode).toBe(404)
  expect(response.json()).toStrictEqual({
    run_id: 'run-missing',
    error: {
      category: 'runtime',
      code: 'EXECUTION_RUN_NOT_FOUND',
      message: 'Execution run not found.',
      retryable: false,
      details: {}
    }
  })
  await app.close()
})

test('reports Temporal submission failures as internal errors', async () => {
  const client = new FakeExecutionRunClient()
  client.startError = new Error('Temporal unavailable')
  const app = await createApp({ client })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    payload: {
      run_id: 'run-temporal-failure',
      input: fixture('issue-review-input.json')
    }
  })
  expect(response.statusCode).toBe(500)
  expect(response.body).not.toMatch(/Temporal unavailable/)
  await app.close()
})

for (const runtime of [null, {}, { workspace_image: 'benchmark:latest' }]) {
  test(`HTTP submission rejects runtime ${JSON.stringify(runtime)}`, async () => {
    const client = new FakeExecutionRunClient()
    const app = await createApp({ client })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/workflows/issue-review/runs',
        payload: {
          run_id: 'run-invalid-runtime',
          input: fixture('issue-review-input.json'),
          runtime
        }
      })
      expect(response.statusCode).toBe(400)
      expect(client.records.size).toBe(0)
    } finally {
      await app.close()
    }
  })
}
