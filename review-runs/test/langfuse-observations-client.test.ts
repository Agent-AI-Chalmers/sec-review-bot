import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LangfuseObservationsClient,
  LangfuseRateLimitError
} from '../src/langfuse-observations-client.js'

test('Langfuse observations are read by session without one request per root', async (t) => {
  const originalFetch = globalThis.fetch
  const requested: URL[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requested.push(url)
    const generations = url.searchParams.get('type') === 'GENERATION'
    return new Response(
      JSON.stringify({
        data: generations
          ? [
              {
                id: 'generation-1',
                traceId: 'trace-review',
                model: 'deepseek-v4-pro',
                metadata: {
                  sec_review_agent: 'issue-analyzer',
                  ls_provider: 'anthropic',
                  'scope.name': 'langfuse-sdk'
                },
                usageDetails: { total: 12 }
              },
              {
                id: 'generation-memory',
                traceId: 'trace-memory',
                metadata: {
                  sec_review_agent: 'memory-extractor',
                  ls_provider: 'anthropic'
                }
              }
            ]
          : [
              {
                id: 'root-review',
                traceId: 'trace-review',
                metadata: { sec_review_agent: 'issue-analyzer' }
              },
              {
                id: 'root-memory',
                traceId: 'trace-memory',
                metadata: { sec_review_agent: 'memory-extractor' }
              }
            ],
        meta: { cursor: null }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const client = new LangfuseObservationsClient(
    'https://langfuse.example',
    'public',
    'secret',
    1_000
  )
  const result = await client.readRun({
    runId: 'run-1',
    fromStartTime: '2026-01-01T00:00:00.000Z',
    toStartTime: '2026-01-01T00:10:00.000Z'
  })

  assert.strictEqual(requested.length, 2)
  assert.deepStrictEqual(
    requested.map((url) => [
      url.searchParams.get('sessionId'),
      url.searchParams.get('type')
    ]),
    [
      ['run-1', null],
      ['run-1', 'GENERATION']
    ]
  )
  assert.deepStrictEqual(
    result.roots.map(({ id }) => id),
    ['root-review']
  )
  assert.deepStrictEqual(
    result.generations.map(({ id }) => id),
    ['generation-1']
  )
  assert.strictEqual(result.excludedNonReviewRootCount, 1)
})

test('invalid observations fail the whole read instead of silently undercounting', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [{ id: 'root-without-trace', metadata: {} }],
        meta: { cursor: null }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const client = new LangfuseObservationsClient(
    'https://langfuse.example',
    'public',
    'secret',
    1_000
  )
  await assert.rejects(
    client.readRun({
      runId: 'run-1',
      fromStartTime: '2026-01-01T00:00:00.000Z',
      toStartTime: '2026-01-01T00:10:00.000Z'
    }),
    /root-without-trace has no traceId/
  )
})

test('provider SDK generations fail reconciliation instead of being silently excluded', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const generations = url.searchParams.get('type') === 'GENERATION'
    return new Response(
      JSON.stringify({
        data: generations
          ? [
              {
                id: 'generation-provider-sdk',
                traceId: 'trace-review',
                metadata: {
                  sec_review_agent: 'issue-analyzer',
                  'scope.name': 'com.anthropic.sdk.python'
                }
              }
            ]
          : [
              {
                id: 'root-review',
                traceId: 'trace-review',
                metadata: { sec_review_agent: 'issue-analyzer' }
              }
            ],
        meta: { cursor: null }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const client = new LangfuseObservationsClient(
    'https://langfuse.example',
    'public',
    'secret',
    1_000
  )
  await assert.rejects(
    client.readRun({
      runId: 'run-1',
      fromStartTime: '2026-01-01T00:00:00.000Z',
      toStartTime: '2026-01-01T00:10:00.000Z'
    }),
    /generation-provider-sdk has unexpected instrumentation scope/
  )
})

test('rate limits preserve Retry-After for the coordinator', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(null, { status: 429, headers: { 'retry-after': '7' } })
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const client = new LangfuseObservationsClient(
    'https://langfuse.example',
    'public',
    'secret',
    1_000
  )
  await assert.rejects(
    client.readRun({
      runId: 'run-1',
      fromStartTime: '2026-01-01T00:00:00.000Z',
      toStartTime: '2026-01-01T00:10:00.000Z'
    }),
    (error: unknown) =>
      error instanceof LangfuseRateLimitError && error.retryAfterMs === 7_000
  )
})
