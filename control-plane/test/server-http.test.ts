// Smoke-test the HTTP surface that the OpenAPI contract builds.
//
// Routes, validation, and security all come from the contract via fastify-openapi-glue, so
// this exercises the wiring rather than the store: it registers the compiled routes
// (dist/server.js, so it also proves the contract is locatable from any CWD) against a stub
// store and asserts the transport-level behaviour — health, auth, validation errors, and the
// deterministic 409 mapping. Without this, a regression that only appears when the server
// really starts (as with the contract's path resolution) would pass the rest of the suite.
import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

// Set before importing the server: its module body starts a real server unless NODE_ENV is
// 'test'. The import is dynamic so the assignment below runs first.
process.env.NODE_ENV = 'test'
const { registerControlPlaneRoutes } = await import('../dist/server.js')

const SERVICE_TOKEN = 'service-token'
const READ_TOKEN = 'read-token'

async function buildApp(store: Record<string, unknown>) {
  const app = Fastify()
  // registerControlPlaneRoutes installs the error/not-found handlers too, so this exercises
  // the same envelope the deployment returns.
  await registerControlPlaneRoutes(app, {
    store: store as never,
    serviceToken: SERVICE_TOKEN,
    readToken: READ_TOKEN
  })
  await app.ready()
  return app
}

test('the compiled server registers the contract from any working directory', async () => {
  // dist/server.js resolves the contract relative to itself, not the CWD; a bare
  // registration is the smoke test for that (it throws if the spec cannot be loaded).
  const app = await buildApp({})
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(health.statusCode, 200)
    assert.deepEqual(health.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('unknown routes return the not-found envelope', async () => {
  const app = await buildApp({})
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { error: 'not_found' })
  } finally {
    await app.close()
  }
})

test('operations reject missing or wrong credentials with 401', async () => {
  const app = await buildApp({})
  try {
    const read = await app.inject({ method: 'GET', url: '/v1/runs' })
    assert.equal(read.statusCode, 401)

    const write = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { 'content-type': 'application/json' },
      payload: {
        workflow: 'issue-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'k'
      }
    })
    assert.equal(write.statusCode, 401)
  } finally {
    await app.close()
  }
})

test('a request body missing a required contract field is rejected before the handler', async () => {
  let handlerCalls = 0
  const app = await buildApp({
    admitReviewRun: async () => {
      handlerCalls += 1
      return {}
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: { publish_context: {}, ingress_kind: 'github_webhook', ingress_key: 'k' }
    })
    assert.equal(response.statusCode, 400)
    assert.equal(handlerCalls, 0, 'validation must reject before the handler runs')
  } finally {
    await app.close()
  }
})

test('a deterministic publication failure maps to 409 with its code', async () => {
  const { DeterministicControlPlaneError, PUBLICATION_STEP_ERROR_CODES } =
    await import('../dist/errors.js')
  const app = await buildApp({
    renewPreparationClaim: async () => {
      throw new DeterministicControlPlaneError(
        'duplicate step set',
        PUBLICATION_STEP_ERROR_CODES.set_duplicate
      )
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/run-1/preparation/claim',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: { token: 'token-1' }
    })
    assert.equal(response.statusCode, 409)
    assert.deepEqual(response.json(), {
      error: 'duplicate step set',
      code: 'PUBLICATION_STEP_SET_DUPLICATE'
    })
  } finally {
    await app.close()
  }
})
