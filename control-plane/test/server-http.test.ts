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
const { CONTROL_PLANE_FASTIFY_OPTIONS, registerControlPlaneRoutes } =
  await import('../dist/server.js')

const SERVICE_TOKEN = 'service-token'
const READ_TOKEN = 'read-token'

async function buildApp(store: Record<string, unknown>) {
  // Same options as the real server, so validation behaviour (notably additionalProperties)
  // is exercised as deployed rather than with Fastify's defaults.
  const app = Fastify(CONTROL_PLANE_FASTIFY_OPTIONS)
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

    // The envelope is the surface's own, not glue's default: glue's message names the
    // security scheme ("None of the security schemes (readToken) ..."), which is not the
    // caller's business and is the only response body outside the `{ error, code? }` shape.
    assert.deepEqual(read.json(), { error: 'unauthorized' })
    assert.deepEqual(write.json(), { error: 'unauthorized' })
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
    assert.equal(
      (response.json() as { code?: string }).code,
      'INVALID_BODY',
      'a body that fails the contract is INVALID_BODY, not the query filter code'
    )
  } finally {
    await app.close()
  }
})

test('schema validation names which part of the request failed', async () => {
  // A caller classifying by `code` must be able to tell a bad filter from a bad body from a
  // bad path parameter; reusing one code for all three (as it did) made that impossible.
  let listCalls = 0
  const app = await buildApp({
    listRunsPage: async () => {
      listCalls += 1
      return { runs: [], next_cursor: null }
    }
  })
  try {
    const query = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=0',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.equal(query.statusCode, 400)
    assert.equal((query.json() as { code?: string }).code, 'INVALID_QUERY')

    // The query is one `additionalProperties: false` object, so a parameter the contract
    // does not declare is rejected before the handler runs — not silently ignored, which is
    // what a bare `parameters` list would do.
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/runs?bogus=1',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.equal(unknown.statusCode, 400)
    assert.equal((unknown.json() as { code?: string }).code, 'INVALID_QUERY')
    assert.equal(listCalls, 0, 'an undeclared query parameter must be rejected before the handler')

    const path = await app.inject({
      method: 'POST',
      url: '/v1/runs/not-a-uuid/submission',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: { preparation_token: 't', publish_context: {}, input: {} }
    })
    assert.equal(path.statusCode, 400)
    assert.equal((path.json() as { code?: string }).code, 'INVALID_PATH_PARAMETER')
  } finally {
    await app.close()
  }
})

test('an operation with no response body sends an empty 200, not a null body', async () => {
  // The contract declares no content for these; returning `null` produced a literal "null"
  // body that disagreed with the generated `void` type.
  const app = await buildApp({ failPreparation: async () => {} })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/preparation/failure',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: { token: 't', failure: { message: 'm' } }
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, '')
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
      url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/preparation/claim',
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

test('an undeclared body field is rejected, matching the contract', async () => {
  // The contract declares additionalProperties: false. Fastify's ajv would silently strip an
  // extra field by default, which would make the contract overstate the validation; the
  // server configures removeAdditional: false so the field is an error instead.
  let handlerCalls = 0
  const app = await buildApp({
    admitReviewRun: async () => {
      handlerCalls += 1
      return {
        record: {
          run_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          workflow: 'issue-review',
          runner_status: 'preparing'
        },
        created: true,
        preparation_token: 'token'
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        workflow: 'issue-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'k',
        run_id: 'attacker-supplied'
      }
    })
    assert.equal(response.statusCode, 400)
    assert.equal(handlerCalls, 0, 'an undeclared field must be rejected before the handler')
  } finally {
    await app.close()
  }
})
