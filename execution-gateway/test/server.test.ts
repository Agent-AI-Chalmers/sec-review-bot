import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  ExecutionRunConflictError,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionStore,
} from '../src/execution-store.js'
import { createApp } from '../src/server.js'

class FakeStore implements ExecutionStore {
  readonly records = new Map<string, ExecutionRecord>()
  conflict = false
  startError: Error | undefined

  start(request: ExecutionRequest): Promise<ExecutionRecord> {
    if (this.startError) return Promise.reject(this.startError)
    if (this.conflict) {
      throw new ExecutionRunConflictError(
        request.run_id,
        request.workflow,
        'issue-review',
      )
    }
    const record = {
      run_id: request.run_id,
      workflow: request.workflow,
      status: 'running',
    }
    this.records.set(request.run_id, record)
    return Promise.resolve(record)
  }

  get(runId: string): Promise<ExecutionRecord | undefined> {
    return Promise.resolve(this.records.get(runId))
  }

  async close(): Promise<void> {}
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.resolve(
        '..',
        'contracts',
        'integration-contract',
        'v6',
        'fixtures',
        name,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>
}

await test('health endpoint follows the OpenAPI route', async () => {
  const app = await createApp({ store: new FakeStore() })
  const response = await app.inject({ method: 'GET', url: '/healthz' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
  await app.close()
})

await test('invalid workflow timeout fails while creating the app', async (t) => {
  process.env.TEMPORAL_WORKFLOW_TIMEOUT_SECONDS = '10800ms'
  t.after(() => delete process.env.TEMPORAL_WORKFLOW_TIMEOUT_SECONDS)

  await assert.rejects(
    createApp({ store: new FakeStore() }),
    /TEMPORAL_WORKFLOW_TIMEOUT_SECONDS must be a decimal integer/,
  )
})

await test('creates and reads an execution run', async () => {
  const store = new FakeStore()
  const app = await createApp({ store, token: 'secret' })
  const create = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    headers: { authorization: 'Bearer secret' },
    payload: {
      run_id: 'run-1',
      input: fixture('issue-review-input.json'),
    },
  })
  assert.equal(create.statusCode, 202)
  assert.match(create.body, /"status":"running"/)

  const read = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-1',
    headers: { authorization: 'Bearer secret' },
  })
  assert.equal(read.statusCode, 200)
  assert.match(read.body, /"run_id":"run-1"/)
  await app.close()
})

await test('rejects requests that violate the workflow input contract', async () => {
  const app = await createApp({ store: new FakeStore() })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    payload: { run_id: 'run-invalid', input: {} },
  })
  assert.equal(response.statusCode, 400)
  const body = response.json<{
    run_id: string
    workflow: string
    error: Record<string, unknown>
  }>()
  assert.deepEqual(
    { ...body, error: { ...body.error, message: undefined } },
    {
      run_id: 'run-invalid',
      workflow: 'issue-review',
      error: {
        category: 'input',
        code: 'EXECUTION_REQUEST_INVALID',
        message: undefined,
        retryable: false,
        details: {},
      },
    },
  )
  assert.equal(typeof body.error.message, 'string')
  await app.close()
})

await test('requires the configured bearer token', async () => {
  const app = await createApp({ store: new FakeStore(), token: 'secret' })
  const response = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-1',
  })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), {
    error: {
      category: 'runtime',
      code: 'UNAUTHORIZED',
      message:
        'None of the security schemes (HTTPBearer) successfully authenticated this request.',
      retryable: false,
      details: {},
    },
  })
  await app.close()
})

await test('returns missing runs in the public error envelope', async () => {
  const app = await createApp({ store: new FakeStore() })
  const response = await app.inject({
    method: 'GET',
    url: '/v1/runs/run-missing',
  })
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), {
    run_id: 'run-missing',
    error: {
      category: 'runtime',
      code: 'EXECUTION_RUN_NOT_FOUND',
      message: 'Execution run not found.',
      retryable: false,
      details: {},
    },
  })
  await app.close()
})

await test('reports Temporal submission failures as internal errors', async () => {
  const store = new FakeStore()
  store.startError = new Error('Temporal unavailable')
  const app = await createApp({ store })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/workflows/issue-review/runs',
    payload: {
      run_id: 'run-temporal-failure',
      input: fixture('issue-review-input.json'),
    },
  })
  assert.equal(response.statusCode, 500)
  assert.doesNotMatch(response.body, /Temporal unavailable/)
  await app.close()
})
