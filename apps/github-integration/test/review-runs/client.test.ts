// Verifies the integration's typed Review Runs client at its HTTP and
// contract boundary, without involving connector workflow behavior.
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import test from 'node:test'

import {
  reviewRunsClient,
  type ReviewRunRecord
} from '../../src/review-runs/client.js'
import { EXECUTION_API_VERSION } from '../../src/execution/execution-api-version.js'
import { asErrorWithResponse, errorCode } from '../../src/utils/error-utils.js'

const preparingRun: ReviewRunRecord = {
  run_id: 'run-1',
  workflow: 'repository-review',
  source_platform: 'github',
  connector_id: 'github-integration:test',
  publish_context: {},
  preparation: {
    status: 'submitted',
    attempt_count: 1,
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    updated_at: '2026-01-01T00:00:03.000Z',
    failure_code: null,
    disconnect_reason: null
  },
  execution: {
    status: 'pending',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  publication: {
    status: 'pending',
    started_at: null,
    finished_at: null,
    updated_at: '2026-01-01T00:00:00.000Z'
  },
  created_at: '2026-10-07T00:00:00.000Z',
  failure_code: null,
  failure_message: null,
  artifact_storage: null,
  notices: [],
  ingress_kind: 'github_actions_dispatch',
  ingress_key: 'octo/example:dispatch-1'
}

/** The request body a request sent, parsed from `init.body`. */
function sentBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

test('repository preparation can replace the admitted empty publish context', async (t) => {
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
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
      if (
        url.endsWith('/v1/runs/run-1/submission') &&
        init?.method === 'POST'
      ) {
        assert.deepStrictEqual(sentBody(init).publish_context, {
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

  const admission = await reviewRunsClient.admitReviewRun({
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:dispatch-1',
    preparation_input_version: 'v1',
    preparation_input: { kind: 'test' }
  })
  assert.strictEqual(admission.record.execution.status, 'pending')

  await reviewRunsClient.submitPreparedRun(
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
    { api_version: EXECUTION_API_VERSION }
  )
})

test('Review Runs calls have a bounded request timeout', async (t) => {
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  const previousTimeout = process.env.REVIEW_RUNS_REQUEST_TIMEOUT_MS
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  process.env.REVIEW_RUNS_REQUEST_TIMEOUT_MS = '10'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
    if (previousTimeout === undefined)
      delete process.env.REVIEW_RUNS_REQUEST_TIMEOUT_MS
    else process.env.REVIEW_RUNS_REQUEST_TIMEOUT_MS = previousTimeout
  })
  t.mock.method(
    globalThis,
    'fetch',
    async (
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(
            Object.assign(new Error('The operation was aborted.'), {
              name: 'AbortError'
            })
          )
        )
      })
  )

  await assert.rejects(
    reviewRunsClient.renewPublicationClaim('run-1', 'claim-1'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'REVIEW_RUNS_REQUEST_TIMEOUT'
  )
})

test('Review Runs success responses have a bounded body', async (t) => {
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
  })
  let bodyCancelled = false
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
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
  )

  await assert.rejects(
    reviewRunsClient.renewPublicationClaim('run-1', 'claim-1'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'REVIEW_RUNS_RESPONSE_TOO_LARGE'
  )
  assert.strictEqual(bodyCancelled, true)
})

test('an invalid claimed publish context is persisted as terminal failure', async (t) => {
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
  })
  const requests: Array<{
    url: string
    method: string
    body: Record<string, unknown>
  }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: sentBody(init)
      })
      if (
        url.endsWith('/v1/publication/claims/next') &&
        init?.method === 'POST'
      ) {
        return Response.json({
          ...preparingRun,
          workflow_result: {},
          claim_token: 'claim-1',
          publish_context: {}
        })
      }
      if (
        url.endsWith('/v1/runs/run-1/publication/fail') &&
        init?.method === 'POST'
      ) {
        return Response.json(true)
      }
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
  )

  await assert.rejects(
    reviewRunsClient.claimNextPublication(),
    /Persisted publish context is invalid/
  )
  assert.deepStrictEqual(requests[0]?.body, { wait_ms: 0 })
  // `run_id` rides the URL path now, not the body: the fail call targets
  // /v1/runs/run-1/publication/fail with token + failure + retry in the body.
  assert.strictEqual(
    requests[1]?.url.endsWith('/v1/runs/run-1/publication/fail'),
    true
  )
  assert.strictEqual('run_id' in requests[1]!.body, false)
  assert.strictEqual(requests[1]?.body.token, 'claim-1')
  assert.deepStrictEqual(requests[1]?.body.retry, false)
})

test('void operations accept the empty 200 body the real server sends', async (t) => {
  // Four operations (`checkpointPreparationInput`, `failPreparation`, `initializePublicationSteps`,
  // `requirePublicationStepClaim`) declare a 200 with no content, and the server answers
  // `reply.code(200).send()` — a zero-byte body. Every other mock in this file uses
  // `Response.json(...)`, which always has a body, so `request()` parsing the success
  // unconditionally looked fine here while throwing `SyntaxError: Unexpected end of JSON
  // input` against the real server. Use a real empty-bodied `Response` so this suite can see
  // the difference between a body and none.
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
  })

  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 200 })
  )

  assert.strictEqual(
    await reviewRunsClient.initializePublicationSteps('run-1', 'claim-1', [
      'a'
    ]),
    undefined
  )
  assert.strictEqual(
    await reviewRunsClient.requirePublicationStepClaim('run-1', 'claim-1', 'a'),
    undefined
  )
  assert.strictEqual(
    await reviewRunsClient.checkpointPreparationInput('run-1', 'prep-1', {
      resolved: true
    }),
    undefined
  )
  assert.strictEqual(
    await reviewRunsClient.failPreparation('run-1', 'prep-1', {
      message: 'x'
    }),
    undefined
  )
})

test('a Review Runs refusal carries the HTTP status that tells it apart from a fault', async (t) => {
  // Classification downstream separates two errors carrying the same `code`: Review Runs
  // refusing the claim (409 — a verdict, terminal) from the same code on a request that never got
  // an answer (no status — retryable). Only the status tells them apart, so the client must report
  // the status it received. Without it every refusal looks like a transport fault and the
  // publication re-claims the same spent step on every poll, forever.
  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = 'http://review-runs.test'
  process.env.REVIEW_RUNS_SERVICE_TOKEN = 'test-token'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
    else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
    if (previousToken === undefined)
      delete process.env.REVIEW_RUNS_SERVICE_TOKEN
    else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
  })

  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: 'Publication step has no attempts left; reconcile first.',
        code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
      },
      { status: 409 }
    )
  )

  const error = await reviewRunsClient
    .requirePublicationStepClaim('run-1', 'claim-1', 'issue:draft-pr')
    .then(
      () => assert.fail('the refusal must be raised'),
      (raised: unknown) => raised
    )
  assert.strictEqual(errorCode(error), 'PUBLICATION_STEP_RETRY_EXHAUSTED')
  assert.strictEqual(
    asErrorWithResponse(error).status,
    409,
    'the client reports the status Review Runs answered with'
  )
})
