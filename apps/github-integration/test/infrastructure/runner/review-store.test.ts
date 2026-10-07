import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reviewRunStore,
  type ReviewRunRecord
} from '../../../src/infrastructure/runner/review-store.js'

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
  const admission = await reviewRunStore.admit_review_run({
    run_id: 'run-1',
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:dispatch-1'
  })
  assert.equal(admission.record.status, 'preparing')

  await reviewRunStore.submit_prepared_run(
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
