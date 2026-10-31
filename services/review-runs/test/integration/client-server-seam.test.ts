// The seam between the real GitHub-integration client and the real Review Runs server.
//
// Every other test of either side mocks the other: `apps/github-integration`'s
// `client.test.ts` fakes `fetch` with `Response.json(...)` (always a body), and this package's
// HTTP tests drive the routes with `app.inject`. Neither can see a *transport* mismatch
// between what the server sends and what the client expects — which is exactly how the
// empty-200 bug shipped: the client parsed every success as JSON, but three operations
// (`failPreparation`, `initializePublicationSteps`, `requirePublicationStepClaim`) answer with
// a zero-byte 200, so the client threw `SyntaxError: Unexpected end of JSON input`. That error
// carried no code and no HTTP status, so `classifyPublicationFailure` classified it as
// retryable and the publication looped forever.
//
// This test stands up the real server (`registerReviewRunsRoutes` from the compiled
// `dist/http/server-surface.js`, so it uses the contract exactly as deployed) on a real port against a stub
// store, points the real client at it, and asserts the seam for the void operations and for
// one that returns a JSON body. A mock cannot reproduce the failure, because it is in the
// response bytes crossing between the two packages.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import Fastify from 'fastify'

// Load the built server via a computed specifier: `tsc` typechecks this file without building,
// so a literal built-module import would be unresolvable there (`TS2307`). The URL form is
// the same file at runtime, but it is not a static module reference, so typechecking stays
// independent of the build.
const { REVIEW_RUNS_FASTIFY_OPTIONS, registerReviewRunsRoutes } = await import(
  new URL('../../dist/http/server-surface.js', import.meta.url).href
)

// Load the client through `createRequire`, not a static import: it lives in another package
// whose `rootDir` is the repository root, and importing its TypeScript directly would pull that
// whole package into this one's `tsc` program and break the typecheck. The real module is still
// what runs — tsx compiles the `.ts` on require — and the seam only needs the methods it
// exercises, so the small interface below is enough.
const require = createRequire(import.meta.url)
interface ReviewRunsClientUnderTest {
  initializePublicationSteps: (
    runId: string,
    token: string,
    stepKeys: string[]
  ) => Promise<void>
  requirePublicationStepClaim: (
    runId: string,
    token: string,
    stepKey: string
  ) => Promise<void>
  failPreparation: (
    runId: string,
    token: string,
    failure: { code?: string | null; message: string }
  ) => Promise<void>
  renewPreparationClaim: (runId: string, token: string) => Promise<boolean>
}
const { reviewRunsClient } =
  require('../../../../apps/github-integration/src/review-runs/client.ts') as {
    reviewRunsClient: ReviewRunsClientUnderTest
  }

const SERVICE_TOKEN = 'seam-service-token'
const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

/** A stub store exposing only what the exercised operations touch. The seam is the transport,
 * so the store's behaviour is irrelevant beyond not throwing. */
function stubStore() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    connectorId: 'seam:test',
    publications: {
      initializePublicationSteps: async (...args: unknown[]) => {
        calls.push({ method: 'initializePublicationSteps', args })
      },
      requirePublicationStepClaim: async (...args: unknown[]) => {
        calls.push({ method: 'requirePublicationStepClaim', args })
      }
    },
    preparations: {
      fail: async (...args: unknown[]) => {
        calls.push({ method: 'failPreparation', args })
      },
      renewClaim: async (...args: unknown[]) => {
        calls.push({ method: 'renewPreparationClaim', args })
        return true
      }
    }
  }
}

async function startSeam() {
  const store = stubStore()
  const app = Fastify(REVIEW_RUNS_FASTIFY_OPTIONS)
  await registerReviewRunsRoutes(app, {
    store: store as never,
    serviceToken: SERVICE_TOKEN,
    readToken: 'seam-read-token'
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  assert.ok(
    address !== null && typeof address === 'object',
    'server did not bind a TCP port'
  )

  const previousUrl = process.env.REVIEW_RUNS_SERVICE_URL
  const previousToken = process.env.REVIEW_RUNS_SERVICE_TOKEN
  process.env.REVIEW_RUNS_SERVICE_URL = `http://127.0.0.1:${address.port}`
  process.env.REVIEW_RUNS_SERVICE_TOKEN = SERVICE_TOKEN
  return {
    store,
    close: async () => {
      await app.close()
      if (previousUrl === undefined) delete process.env.REVIEW_RUNS_SERVICE_URL
      else process.env.REVIEW_RUNS_SERVICE_URL = previousUrl
      if (previousToken === undefined)
        delete process.env.REVIEW_RUNS_SERVICE_TOKEN
      else process.env.REVIEW_RUNS_SERVICE_TOKEN = previousToken
    }
  }
}

test('a void operation (empty 200) resolves for the real client against the real server', async () => {
  const seam = await startSeam()
  try {
    // None of these may throw. `initializePublicationSteps` was the first call every
    // publication made, so under the empty-200 bug it looped execution forever.
    assert.strictEqual(
      await reviewRunsClient.initializePublicationSteps(RUN_ID, 'claim-1', [
        'pull-request:review'
      ]),
      undefined
    )
    assert.strictEqual(
      await reviewRunsClient.requirePublicationStepClaim(
        RUN_ID,
        'claim-1',
        'pull-request:review'
      ),
      undefined
    )
    assert.strictEqual(
      await reviewRunsClient.failPreparation(RUN_ID, 'prep-1', {
        code: 'PREPARATION_FAILED',
        message: 'seam test'
      }),
      undefined
    )
    assert.deepStrictEqual(
      seam.store.calls.map((call) => call.method),
      [
        'initializePublicationSteps',
        'requirePublicationStepClaim',
        'failPreparation'
      ]
    )
  } finally {
    await seam.close()
  }
})

test('a JSON-returning operation still parses against the real server', async () => {
  const seam = await startSeam()
  try {
    // `renewPreparationClaim` answers a JSON boolean; tolerating an empty body must not have
    // broken the ordinary path.
    assert.strictEqual(
      await reviewRunsClient.renewPreparationClaim(RUN_ID, 'prep-1'),
      true
    )
  } finally {
    await seam.close()
  }
})
