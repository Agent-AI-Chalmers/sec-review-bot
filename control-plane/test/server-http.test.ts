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
// Each import of a built artifact uses a computed specifier so `tsc` typechecks this file
// without a prior build: a literal `'../dist/server.js'` is unresolvable when `dist/` is absent
// (`TS2307`), but the URL form loads the same file at runtime and is not a static reference.
const { CONTROL_PLANE_FASTIFY_OPTIONS, registerControlPlaneRoutes } = await import(
  new URL('../dist/server.js', import.meta.url).href
)

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

test('the two bearer tokens are not interchangeable', async () => {
  // Every operation declares exactly one security scheme, so each handler must compare the
  // credential against its own token. If the read token were accepted on a write (or the
  // service token on a redacted read), possession of the weaker credential would silently
  // grant the other surface — so pin the separation, not just the "missing" case above.
  const app = await buildApp({
    listRunsPage: async () => ({ runs: [], next_cursor: null, dropped: [] })
  })
  try {
    const readOnWrite = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: {
        workflow: 'issue-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'k'
      }
    })
    assert.equal(readOnWrite.statusCode, 401)
    assert.deepEqual(readOnWrite.json(), { error: 'unauthorized' })

    const serviceOnRedactedRead = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
    })
    assert.equal(serviceOnRedactedRead.statusCode, 401)
    assert.deepEqual(serviceOnRedactedRead.json(), { error: 'unauthorized' })

    // Each token still authenticates its own surface, so the rejections above are the
    // separation rather than a blanket refusal.
    const read = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.equal(read.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('an internal fault is logged with its identity but not returned to the caller', async () => {
  // A 5xx is a server defect, so the response is deliberately opaque. It still has to be
  // diagnosable operationally: without a log, a corrupt stored row (for example an
  // `available` artifact without its reference) surfaces only as a bare "Internal error".
  const app = await buildApp({
    getRun: async () => {
      throw new Error('available artifact storage record is missing its artifact')
    }
  })
  const logged: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/internal/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
    })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { error: 'Internal error' })
    assert.equal(logged.length, 1, 'the fault must be logged exactly once')
    const record = JSON.parse(logged[0] ?? '') as Record<string, unknown>
    assert.equal(record.event, 'control_plane_request_failed')
    assert.equal(record.run_id, '3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    assert.match(String(record.message), /missing its artifact/)
  } finally {
    console.error = originalError
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
      return { runs: [], next_cursor: null, dropped: [] }
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
  const { DeterministicControlPlaneError, PUBLICATION_STEP_ERROR_CODES } = await import(
    new URL('../dist/errors.js', import.meta.url).href
  )
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

test('remote_object.id is accepted only in its canonical string form', async () => {
  // The contract declares `remote_object.id` as `type: [string, "null"]`, and Control Plane
  // validates bodies with `coerceTypes: false`, so a value must be that type literally — a
  // JSON number (the pre-normalization GitHub shape) and a boolean are rejected, not coerced.
  // The client's `String(remote.id)` is what turns a GitHub number into the accepted form.
  let received: unknown
  const app = await buildApp({
    completePublicationStep: async (
      _runId: string,
      _token: string,
      _stepKey: string,
      remote: unknown
    ) => {
      received = remote
      return true
    }
  })
  try {
    for (const id of ['1234', null]) {
      received = undefined
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/publication/steps/issue:draft-pr/complete',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
        payload: { token: 'token-1', remote_object: { id, url: 'https://example.test/1' } }
      })
      assert.equal(response.statusCode, 200, `id ${JSON.stringify(id)} must validate`)
      assert.deepEqual(received, { id, url: 'https://example.test/1' })
    }
  } finally {
    await app.close()
  }
})

test('a remote_object.id the contract does not declare is rejected', async () => {
  // A JSON number, a boolean, and an array are all outside `[string, "null"]`. With coercion
  // off there is no silent conversion, so each is a 400 before the handler runs — the behavior
  // the default `coerceTypes: true` would have hidden (it turned `true` into `"true"`).
  let handlerCalls = 0
  const app = await buildApp({
    completePublicationStep: async () => {
      handlerCalls += 1
      return true
    }
  })
  try {
    for (const id of [1234, true, [1, 2]]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/publication/steps/issue:draft-pr/complete',
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          'content-type': 'application/json'
        },
        payload: { token: 'token-1', remote_object: { id } }
      })
      assert.equal(response.statusCode, 400, `id ${JSON.stringify(id)} must be rejected`)
      assert.equal(
        (response.json() as { code?: string }).code,
        'INVALID_BODY',
        'a body that fails the contract is INVALID_BODY'
      )
    }
    assert.equal(handlerCalls, 0, 'an invalid id must be rejected before the handler')
  } finally {
    await app.close()
  }
})

test('the query string is coerced to the declared types, and only there', async () => {
  // `coerceTypes` is off so bodies mean exactly what they say, but the query string can only
  // carry strings and the contract declares `limit` an integer. The preValidation hook coerces
  // the query from the route's own contract-derived schema, so the integer is accepted and a
  // non-integer is still rejected — coercion never becomes a way to bypass the schema.
  let calls = 0
  const app = await buildApp({
    listRunsPage: async () => {
      calls += 1
      return { runs: [], next_cursor: null, dropped: [] }
    }
  })
  try {
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=10',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(calls, 1, 'a coerced integer must reach the handler')

    for (const bad of ['abc', '10.5', '']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs?limit=${bad}`,
        headers: { authorization: `Bearer ${READ_TOKEN}` }
      })
      assert.equal(response.statusCode, 400, `limit=${JSON.stringify(bad)} must be rejected`)
      assert.equal((response.json() as { code?: string }).code, 'INVALID_QUERY')
    }
    assert.equal(calls, 1, 'a rejected query must not reach the handler')
  } finally {
    await app.close()
  }
})

test('a malformed JSON body is a 400 that names the body, like any other bad body', async () => {
  // The contract's `InvalidRequest` response says every 400 carries a `code` naming which part
  // failed. A body that is not JSON at all reached the server with no code, which overstated the
  // contract; it is a bad body, so it now carries `INVALID_BODY`.
  const app = await buildApp({})
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: '{not json'
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), {
      error: 'Request body must be valid JSON.',
      code: 'INVALID_BODY'
    })
  } finally {
    await app.close()
  }
})

test('a request body over the size limit is a 413 with the declared envelope', async () => {
  // The server bounds every body at 1 MiB. The contract declares a shared `PayloadTooLarge`
  // (413) response for exactly the operations that read a body, so the wire shape is asserted
  // here rather than left to a Fastify default.
  const app = await buildApp({
    admitReviewRun: async () => assert.fail('the handler must not run for an oversized body')
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'a'.repeat(1024 * 1024 + 1) })
    })
    assert.equal(response.statusCode, 413)
    assert.deepEqual(response.json(), { error: 'Request body is too large.' })
  } finally {
    await app.close()
  }
})
