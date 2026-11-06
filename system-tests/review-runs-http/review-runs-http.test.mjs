// Verify the real Integration client against Review Runs HTTP, including empty success bodies.
// Build both packages before running this repository-level test; no database is needed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { reviewRunsClient } from '../../apps/github-integration/dist/review-runs/client.js'
import {
  REVIEW_RUNS_FASTIFY_OPTIONS,
  registerReviewRunsRoutes
} from '../../services/review-runs/dist/http/server-surface.js'

const require = createRequire(
  new URL('../../services/review-runs/package.json', import.meta.url)
)
const Fastify = require('fastify')

const SERVICE_TOKEN = 'seam-service-token'
const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

/** A stub store exposing only what the exercised operations touch. The seam is the transport,
 * so the store's behaviour is irrelevant beyond not throwing. */
function stubStore() {
  const calls = []
  return {
    calls,
    connectorId: 'seam:test',
    publications: {
      initializePublicationSteps: async (...args) => {
        calls.push({ method: 'initializePublicationSteps', args })
      },
      requirePublicationStepClaim: async (...args) => {
        calls.push({ method: 'requirePublicationStepClaim', args })
      }
    },
    preparations: {
      fail: async (...args) => {
        calls.push({ method: 'failPreparation', args })
      },
      renewClaim: async (...args) => {
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
    store,
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
