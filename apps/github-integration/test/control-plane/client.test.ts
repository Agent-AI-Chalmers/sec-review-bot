import assert from 'node:assert/strict'
import test from 'node:test'

import { controlPlaneClient, type ReviewRunRecord } from '../../src/control-plane/client.js'

const preparingRun: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'repository-review',
  publish_context: {},
  runner_status: 'preparing',
  publication_status: 'pending',
  created_at: '2026-10-07T00:00:00.000Z',
  execution_updated_at: '2026-10-07T00:00:00.000Z',
  publication_updated_at: '2026-10-07T00:00:00.000Z',
  published_at: null,
  failure_code: null,
  failure_message: null,
  artifact_storage: null,
  ingress_kind: 'github_actions_dispatch',
  ingress_key: 'octo/example:dispatch-1'
}

/** The request body a POST/DELETE sent, parsed from `init.body`. */
function sentBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
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

  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        return Response.json({
          record: preparingRun,
          created: true,
          preparation_token: 'preparation-token'
        })
      }
      if (url.endsWith('/v1/internal/runs/run-1') && init?.method === 'GET') {
        return Response.json(preparingRun)
      }
      if (url.endsWith('/v1/runs/run-1/submission') && init?.method === 'POST') {
        assert.deepEqual(sentBody(init).publish_context, {
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
        return Response.json({
          run_id: 'run-1',
          workflow: 'repository-review',
          status: 'queued'
        })
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
  )

  const admission = await controlPlaneClient.admitReviewRun({
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:dispatch-1'
  })
  assert.equal(admission.record.runner_status, 'preparing')

  await controlPlaneClient.submitPreparedRun(
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
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, method: init?.method ?? 'GET', body: sentBody(init) })
      if (url.endsWith('/v1/publication/claims/next') && init?.method === 'POST') {
        return Response.json({
          ...preparingRun,
          publication_status: 'publishing',
          workflow_result: {},
          claim_token: 'claim-1',
          publish_context: {}
        })
      }
      if (url.endsWith('/v1/runs/run-1/publication/fail') && init?.method === 'POST') {
        return Response.json(true)
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
  )

  await assert.rejects(
    controlPlaneClient.claimNextPublication(),
    /Persisted publish context is invalid/
  )
  assert.deepEqual(requests[0]?.body, { wait_ms: 0 })
  // `run_id` rides the URL path now, not the body: the fail call targets
  // /v1/runs/run-1/publication/fail with token + failure + retry in the body.
  assert.equal(requests[1]?.url.endsWith('/v1/runs/run-1/publication/fail'), true)
  assert.equal('run_id' in requests[1]!.body, false)
  assert.equal(requests[1]?.body.token, 'claim-1')
  assert.deepEqual(requests[1]?.body.retry, false)
})
