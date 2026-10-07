import assert from 'node:assert/strict'
import test from 'node:test'

import { controlPlaneClient, type ReviewRunRecord } from '../../src/control-plane/client.js'

const preparingRun: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'repository-review',
  publish_context: {},
  status: 'preparing',
  created_at: '2026-10-07T00:00:00.000Z',
  updated_at: '2026-10-07T00:00:00.000Z',
  published_at: null,
  failure_code: null,
  failure_message: null,
  artifact_publication: null,
  ingress_kind: 'github_actions_dispatch',
  ingress_key: 'octo/example:dispatch-1'
}

test('repository preparation can replace the admitted empty publish context', async (t) => {
  const previousUrl = process.env.CONTROL_PLANE_SERVICE_URL
  const previousToken = process.env.CONTROL_PLANE_SERVICE_TOKEN
  process.env.CONTROL_PLANE_SERVICE_URL = 'http://control-plane.test'
  process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.CONTROL_PLANE_SERVICE_URL
    else process.env.CONTROL_PLANE_SERVICE_URL = previousUrl
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_SERVICE_TOKEN
    else process.env.CONTROL_PLANE_SERVICE_TOKEN = previousToken
  })

  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { operation: string; args: unknown[] }
    if (request.operation === 'admit_review_run') {
      return Response.json({
        result: {
          record: preparingRun,
          created: true,
          preparation_token: 'preparation-token'
        }
      })
    }
    if (request.operation === 'getRun') {
      return Response.json({ result: preparingRun })
    }
    if (request.operation === 'submit_prepared_run') {
      assert.deepEqual(request.args[2], {
        repo: {
          owner_login: 'octo',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          default_branch: 'main'
        },
        workspace_ref: '0123456789abcdef',
        scan_target: {
          target_branch: 'main',
          scan_mode: 'full',
          base_sha: null,
          head_sha: '0123456789abcdef'
        },
        event_type: 'manual'
      })
      return Response.json({ result: undefined })
    }
    return Response.json({ error: 'unexpected operation' }, { status: 500 })
  })
  const admission = await controlPlaneClient.admit_review_run({
    run_id: 'run-1',
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:dispatch-1'
  })
  assert.equal(admission.record.status, 'preparing')

  await controlPlaneClient.submit_prepared_run(
    'run-1',
    'preparation-token',
    {
      repo: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main'
      },
      workspace_ref: '0123456789abcdef',
      scan_target: {
        target_branch: 'main',
        scan_mode: 'full',
        base_sha: null,
        head_sha: '0123456789abcdef'
      },
      event_type: 'manual'
    },
    { contract_version: 'v5' }
  )
})

test('Control Plane calls have a bounded request timeout', async (t) => {
  const previousUrl = process.env.CONTROL_PLANE_SERVICE_URL
  const previousToken = process.env.CONTROL_PLANE_SERVICE_TOKEN
  const previousTimeout = process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS
  process.env.CONTROL_PLANE_SERVICE_URL = 'http://control-plane.test'
  process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
  process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS = '10'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.CONTROL_PLANE_SERVICE_URL
    else process.env.CONTROL_PLANE_SERVICE_URL = previousUrl
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_SERVICE_TOKEN
    else process.env.CONTROL_PLANE_SERVICE_TOKEN = previousToken
    if (previousTimeout === undefined) delete process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS
    else process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS = previousTimeout
  })
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        )
      })
  )

  await assert.rejects(
    controlPlaneClient.renewPublicationClaim('run-1', 'claim-1'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CONTROL_PLANE_REQUEST_TIMEOUT'
  )
})

test('an invalid claimed publish context is persisted as terminal failure', async (t) => {
  const previousUrl = process.env.CONTROL_PLANE_SERVICE_URL
  const previousToken = process.env.CONTROL_PLANE_SERVICE_TOKEN
  process.env.CONTROL_PLANE_SERVICE_URL = 'http://control-plane.test'
  process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.CONTROL_PLANE_SERVICE_URL
    else process.env.CONTROL_PLANE_SERVICE_URL = previousUrl
    if (previousToken === undefined) delete process.env.CONTROL_PLANE_SERVICE_TOKEN
    else process.env.CONTROL_PLANE_SERVICE_TOKEN = previousToken
  })
  const requests: Array<{ operation: string; args: unknown[] }> = []
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { operation: string; args: unknown[] }
    requests.push(request)
    if (request.operation === 'claimNextPublication') {
      return Response.json({
        result: {
          ...preparingRun,
          status: 'publishing',
          workflow_result: {},
          claim_token: 'claim-1',
          publish_context: {}
        }
      })
    }
    if (request.operation === 'failPublication') return Response.json({ result: true })
    return Response.json({ error: 'unexpected operation' }, { status: 500 })
  })

  await assert.rejects(
    controlPlaneClient.claimNextPublication(),
    /Persisted publish context is invalid/
  )
  assert.equal(requests[1]?.operation, 'failPublication')
  assert.deepEqual(requests[1]?.args.slice(0, 2), ['run-1', 'claim-1'])
  assert.deepEqual(requests[1]?.args.at(-1), { retry: false })
})
