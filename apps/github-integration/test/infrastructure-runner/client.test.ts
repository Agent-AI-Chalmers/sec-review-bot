import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completedRunnerRunResult,
  submitRunnerRun,
  type AgentRunnerServiceError,
  getRunnerRunStatus
} from '../../infrastructure/runner/client.js'

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = globalThis.fetch

function resetEnv (): void {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.AGENT_RUNNER_SERVICE_URL
  delete process.env.AGENT_RUNNER_SERVICE_TOKEN
}

function jsonResponse (body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

test.afterEach(() => {
  resetEnv()
  globalThis.fetch = ORIGINAL_FETCH
})

test('submitRunnerRun requires HTTP runner service URL', async () => {
  resetEnv()

  await assert.rejects(
    submitRunnerRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    }),
    (error: unknown) => {
      const configError = error as Error & { code?: string }
      assert.equal(configError.code, 'RUNNER_SERVICE_URL_MISSING')
      assert.match(configError.message, /AGENT_RUNNER_SERVICE_URL/)
      return true
    }
  )
})

test('submitRunnerRun posts an HTTP runner run', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test/'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString()
    calls.push({ url, init })
    assert.equal(url, 'http://runner.test/v1/workflows/issue-review/runs')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer dev-token')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.run_id, 'run-1')
    assert.deepEqual(body.input, {})
    return jsonResponse({
      run_id: body.run_id,
      workflow: 'issue-review',
      status: 'running'
    }, { status: 202 })
  }

  const submitted = await submitRunnerRun({
    workflow: 'issue-review',
    run_id: 'run-1',
    input: {}
  })

  assert.equal(submitted.run_id, 'run-1')
  assert.equal(submitted.workflow, 'issue-review')
  assert.equal(submitted.status, 'running')
  assert.equal(calls.length, 1)
})

test('submitRunnerRun rejects invalid run ids before dispatch', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test/'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'
  let called = false
  globalThis.fetch = async () => {
    called = true
    return jsonResponse({})
  }

  await assert.rejects(
    submitRunnerRun({
      workflow: 'issue-review',
      run_id: ' run-1 ',
      input: {}
    }),
    /Runner run_id must match/
  )
  assert.equal(called, false)
})

test('submitRunnerRun requires runner service token by default', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test/'

  await assert.rejects(
    submitRunnerRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    }),
    (error: unknown) => {
      const configError = error as Error & { code?: string }
      assert.equal(configError.code, 'RUNNER_SERVICE_TOKEN_MISSING')
      assert.match(configError.message, /AGENT_RUNNER_SERVICE_TOKEN/)
      return true
    }
  )
})

test('submitRunnerRun permits missing token for HTTP IPv4 loopback runner service URLs', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://127.0.0.2:8000/'

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), 'http://127.0.0.2:8000/v1/workflows/issue-review/runs')
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined)
    return jsonResponse({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'running'
    }, { status: 202 })
  }

  const submitted = await submitRunnerRun({
    workflow: 'issue-review',
    run_id: 'run-1',
    input: {}
  })

  assert.equal(submitted.status, 'running')
})

test('submitRunnerRun permits missing token for HTTP IPv6 loopback runner service URLs', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://[::1]:8000/'

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), 'http://[::1]:8000/v1/workflows/issue-review/runs')
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined)
    return jsonResponse({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'running'
    }, { status: 202 })
  }

  const submitted = await submitRunnerRun({
    workflow: 'issue-review',
    run_id: 'run-1',
    input: {}
  })

  assert.equal(submitted.status, 'running')
})

test('submitRunnerRun does not permit unauthenticated remote runner service URLs', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test/'

  await assert.rejects(
    submitRunnerRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    }),
    (error: unknown) => {
      const configError = error as Error & { code?: string }
      assert.equal(configError.code, 'RUNNER_SERVICE_TOKEN_MISSING')
      assert.match(configError.message, /loopback HTTP/)
      return true
    }
  )
})

test('submitRunnerRun does not permit unauthenticated HTTPS loopback URLs', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'https://127.0.0.1:8000/'

  await assert.rejects(
    submitRunnerRun({
      workflow: 'issue-review',
      run_id: 'run-1',
      input: {}
    }),
    (error: unknown) => {
      const configError = error as Error & { code?: string }
      assert.equal(configError.code, 'RUNNER_SERVICE_TOKEN_MISSING')
      assert.match(configError.message, /loopback HTTP/)
      return true
    }
  )
})

test('getRunnerRunStatus fetches HTTP runner run status', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input.toString(), 'http://runner.test/v1/runs/run-1')
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer dev-token')
    return jsonResponse({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'succeeded',
      result: { status: 'completed' }
    })
  }

  const status = await getRunnerRunStatus({ run_id: 'run-1' })

  assert.equal(status.run_id, 'run-1')
  assert.equal(status.status, 'succeeded')
  assert.deepEqual(completedRunnerRunResult(status)?.result, { status: 'completed' })
})

test('getRunnerRunStatus retries transient runner service failures', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'
  process.env.AGENT_RUNNER_SERVICE_REQUEST_RETRIES = '1'
  process.env.AGENT_RUNNER_SERVICE_RETRY_BASE_DELAY_MS = '1'
  let calls = 0

  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return jsonResponse({ error: 'temporary' }, { status: 503 })
    }
    return jsonResponse({
      run_id: 'run-1',
      workflow: 'issue-review',
      status: 'succeeded',
      result: { status: 'completed' }
    })
  }

  const status = await getRunnerRunStatus({ run_id: 'run-1' })

  assert.equal(calls, 2)
  assert.equal(status.status, 'succeeded')
})

test('getRunnerRunStatus aborts runner service requests after configured timeout', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'
  process.env.AGENT_RUNNER_SERVICE_REQUEST_TIMEOUT_MS = '1'
  process.env.AGENT_RUNNER_SERVICE_REQUEST_RETRIES = '0'

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('Aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
    throw new Error('unreachable')
  }

  await assert.rejects(
    getRunnerRunStatus({ run_id: 'run-timeout' }),
    /timed out/
  )
})

test('getRunnerRunStatus maps structured HTTP errors to AgentRunnerServiceError', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'

  globalThis.fetch = async (input: string | URL | Request) => {
    assert.equal(input.toString(), 'http://runner.test/v1/runs/bad%20run')
    return jsonResponse({
      run_id: 'bad run',
      error: {
        category: 'input',
        code: 'RUNNER_REQUEST_INVALID',
        message: 'Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.',
        retryable: false,
        details: { field: 'run_id' }
      }
    }, { status: 400 })
  }

  await assert.rejects(
    getRunnerRunStatus({ run_id: 'bad run' }),
    (error: unknown) => {
      const serviceError = error as AgentRunnerServiceError
      assert.equal(serviceError.name, 'AgentRunnerServiceError')
      assert.equal(serviceError.code, 'RUNNER_REQUEST_INVALID')
      assert.equal(serviceError.category, 'input')
      assert.equal(serviceError.run_id, 'bad run')
      assert.equal(serviceError.workflow, null)
      assert.deepEqual(serviceError.details, { field: 'run_id' })
      assert.match(serviceError.message, /run_id must match/)
      return true
    }
  )
})

test('getRunnerRunStatus preserves runner failure details', async () => {
  resetEnv()
  process.env.AGENT_RUNNER_SERVICE_URL = 'http://runner.test'
  process.env.AGENT_RUNNER_SERVICE_TOKEN = 'dev-token'

  globalThis.fetch = async (input: string | URL | Request) => {
    assert.equal(input.toString(), 'http://runner.test/v1/runs/run-boom')
    return jsonResponse({
      run_id: 'run-boom',
      workflow: 'issue-review',
      status: 'failed',
      error: {
        category: 'runtime',
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'RuntimeError: boom from issue analyzer',
        retryable: false,
        details: {
          temporal_status: 'FAILED',
          name: 'RuntimeError',
          failure_chain: [
            { name: 'WorkflowFailureError', message: 'Workflow execution failed' },
            { name: 'RuntimeError', message: 'RuntimeError: boom from issue analyzer' }
          ]
        }
      }
    })
  }

  const status = await getRunnerRunStatus({ run_id: 'run-boom' })

  assert.equal(status.status, 'failed')
  assert.equal(status.error?.message, 'RuntimeError: boom from issue analyzer')
  assert.deepEqual(status.error?.details, {
    temporal_status: 'FAILED',
    name: 'RuntimeError',
    failure_chain: [
      { name: 'WorkflowFailureError', message: 'Workflow execution failed' },
      { name: 'RuntimeError', message: 'RuntimeError: boom from issue analyzer' }
    ]
  })
})

test('completedRunnerRunResult maps runner service errors to AgentRunnerServiceError', () => {
  assert.throws(
    () => completedRunnerRunResult({
      run_id: 'run-2',
      workflow: 'issue-review',
      status: 'failed',
      error: {
        category: 'input',
        code: 'RUNNER_REQUEST_INVALID',
        message: 'bad input',
        retryable: false,
        details: { field: 'input' }
      }
    }),
    (error: unknown) => {
      const serviceError = error as AgentRunnerServiceError
      assert.equal(serviceError.name, 'AgentRunnerServiceError')
      assert.equal(serviceError.code, 'RUNNER_REQUEST_INVALID')
      assert.equal(serviceError.category, 'input')
      assert.equal(serviceError.run_id, 'run-2')
      assert.equal(serviceError.workflow, 'issue-review')
      assert.equal(serviceError.message, 'bad input')
      assert.deepEqual(serviceError.details, { field: 'input' })
      return true
    }
  )
})
