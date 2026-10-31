// Smoke-test the HTTP surface that the OpenAPI contract builds.
//
// Routes, validation, and security all come from the contract via fastify-openapi-glue, so
// this exercises the wiring rather than the store: it registers the compiled routes
// (dist/http/server-surface.js, so it also proves the contract is locatable from any CWD) against a stub
// store and asserts the transport-level behaviour — health, auth, validation errors, and the
// deterministic 409 mapping. Without this, a regression that only appears when the server
// really starts (as with the contract's path resolution) would pass the rest of the suite.
import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

// Each import of a built artifact uses a computed specifier so `tsc` typechecks this file
// without a prior build: a literal import is unresolvable when `dist/` is absent
// (`TS2307`), but the URL form loads the same file at runtime and is not a static reference.
const { REVIEW_RUNS_FASTIFY_OPTIONS, registerReviewRunsRoutes } = await import(
  new URL('../dist/http/server-surface.js', import.meta.url).href
)

const SERVICE_TOKEN = 'service-token'
const READ_TOKEN = 'read-token'

async function buildApp(store: Record<string, unknown>, adminToken?: string) {
  // Same options as the real server, so validation behaviour (notably additionalProperties)
  // is exercised as deployed rather than with Fastify's defaults.
  const app = Fastify(REVIEW_RUNS_FASTIFY_OPTIONS)
  // registerReviewRunsRoutes installs the error/not-found handlers too, so this exercises
  // the same envelope the deployment returns.
  const queries = store.queries as Record<string, unknown> | undefined
  await registerReviewRunsRoutes(app, {
    store: {
      ...store,
      queries: {
        getExecutionStatistics: async () => new Map(),
        ...queries
      }
    } as never,
    serviceToken: SERVICE_TOKEN,
    readToken: READ_TOKEN,
    ...(adminToken === undefined ? {} : { adminToken })
  })
  await app.ready()
  return app
}

test('the compiled server registers the contract from any working directory', async () => {
  // The compiled HTTP surface resolves the contract relative to itself, not the CWD; a bare
  // registration is the smoke test for that (it throws if the spec cannot be loaded).
  const app = await buildApp({})
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    assert.strictEqual(health.statusCode, 200)
    assert.deepStrictEqual(health.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('readiness requires a usable PostgreSQL store without exposing its failure', async () => {
  const ready = await buildApp({
    connectorId: 'github-integration:test',
    checkReadiness: async () => {}
  })
  const unavailable = await buildApp({
    connectorId: 'github-integration:test',
    checkReadiness: async () => {
      throw new Error('database connection refused')
    }
  })
  try {
    const readyResponse = await ready.inject({ method: 'GET', url: '/readyz' })
    assert.strictEqual(readyResponse.statusCode, 200)
    assert.deepStrictEqual(readyResponse.json(), { status: 'ok' })

    const unavailableResponse = await unavailable.inject({
      method: 'GET',
      url: '/readyz'
    })
    assert.strictEqual(unavailableResponse.statusCode, 503)
    assert.deepStrictEqual(unavailableResponse.json(), {
      status: 'unavailable'
    })
  } finally {
    await ready.close()
    await unavailable.close()
  }
})

test('unknown routes return the not-found envelope', async () => {
  const app = await buildApp({})
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' })
    assert.strictEqual(response.statusCode, 404)
    assert.deepStrictEqual(response.json(), { error: 'not_found' })
  } finally {
    await app.close()
  }
})

test('operations reject missing or wrong credentials with 401', async () => {
  const app = await buildApp({})
  try {
    const read = await app.inject({ method: 'GET', url: '/v1/runs' })
    assert.strictEqual(read.statusCode, 401)

    const write = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { 'content-type': 'application/json' },
      payload: {
        workflow: 'issue-review',
        publish_context: {},
        preparation_input_version: 'v1',
        preparation_input: { kind: 'test' },
        ingress_kind: 'github_webhook',
        ingress_key: 'k'
      }
    })
    assert.strictEqual(write.statusCode, 401)

    // The envelope is the surface's own, not glue's default: glue's message names the
    // security scheme ("None of the security schemes (readToken) ..."), which is not the
    // caller's business and is the only response body outside the `{ error, code? }` shape.
    assert.deepStrictEqual(read.json(), { error: 'unauthorized' })
    assert.deepStrictEqual(write.json(), { error: 'unauthorized' })
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
    queries: {
      listRunsPage: async () => ({ runs: [], next_cursor: null, dropped: [] })
    }
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
        preparation_input_version: 'v1',
        preparation_input: { kind: 'test' },
        ingress_kind: 'github_webhook',
        ingress_key: 'k'
      }
    })
    assert.strictEqual(readOnWrite.statusCode, 401)
    assert.deepStrictEqual(readOnWrite.json(), { error: 'unauthorized' })

    const serviceOnRedactedRead = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
    })
    assert.strictEqual(serviceOnRedactedRead.statusCode, 401)
    assert.deepStrictEqual(serviceOnRedactedRead.json(), {
      error: 'unauthorized'
    })

    // Each token still authenticates its own surface, so the rejections above are the
    // separation rather than a blanket refusal.
    const read = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.strictEqual(read.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('an internal fault is logged with its identity but not returned to the caller', async () => {
  // A 5xx is a server defect, so the response is deliberately opaque. It still has to be
  // diagnosable operationally: without a log, a corrupt stored row (for example an
  // `available` artifact without its reference) surfaces only as a bare "Internal error".
  const app = await buildApp({
    queries: {
      getRun: async () => {
        throw new Error(
          'available artifact storage record is missing its artifact'
        )
      }
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
    assert.strictEqual(response.statusCode, 500)
    assert.deepStrictEqual(response.json(), { error: 'Internal error' })
    assert.strictEqual(
      logged.length,
      1,
      'the fault must be logged exactly once'
    )
    const record = JSON.parse(logged[0] ?? '') as Record<string, unknown>
    assert.strictEqual(record.event, 'review_runs_request_failed')
    assert.strictEqual(record.run_id, '3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    assert.match(String(record.message), /missing its artifact/)
  } finally {
    console.error = originalError
    await app.close()
  }
})

test('a request body missing a required contract field is rejected before the handler', async () => {
  let handlerCalls = 0
  const app = await buildApp({
    admissions: {
      admit: async () => {
        handlerCalls += 1
        return {}
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: {
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'k'
      }
    })
    assert.strictEqual(response.statusCode, 400)
    assert.strictEqual(
      handlerCalls,
      0,
      'validation must reject before the handler runs'
    )
    assert.strictEqual(
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
    queries: {
      listRunsPage: async () => {
        listCalls += 1
        return { runs: [], next_cursor: null, dropped: [] }
      }
    }
  })
  try {
    const query = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=0',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.strictEqual(query.statusCode, 400)
    assert.strictEqual(
      (query.json() as { code?: string }).code,
      'INVALID_QUERY'
    )

    // The query is one `additionalProperties: false` object, so a parameter the contract
    // does not declare is rejected before the handler runs — not silently ignored, which is
    // what a bare `parameters` list would do.
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/runs?bogus=1',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.strictEqual(unknown.statusCode, 400)
    assert.strictEqual(
      (unknown.json() as { code?: string }).code,
      'INVALID_QUERY'
    )
    assert.strictEqual(
      listCalls,
      0,
      'an undeclared query parameter must be rejected before the handler'
    )

    const path = await app.inject({
      method: 'POST',
      url: '/v1/runs/not-a-uuid/submission',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { preparation_token: 't', publish_context: {}, input: {} }
    })
    assert.strictEqual(path.statusCode, 400)
    assert.strictEqual(
      (path.json() as { code?: string }).code,
      'INVALID_PATH_PARAMETER'
    )
  } finally {
    await app.close()
  }
})

test('the completion route keeps the comment_url its branch requires', async () => {
  // `oneOf` plus Fastify's default `removeAdditional: true` is a trap: ajv strips the fields a
  // branch does not declare before deciding which branch matches, so `delivered:true` would lose
  // its `comment_url`, fall through to the other branch, and the handler would then reject the
  // call it just accepted. The server configures `removeAdditional: false` for exactly this
  // reason; this test pins the consequence on the wire, which the store-level tests cannot see
  // because they never go through schema validation.
  const completed: unknown[][] = []
  const app = await buildApp({
    notices: {
      complete: async (...args: unknown[]) => {
        completed.push(args)
        return true
      }
    }
  })
  try {
    const delivered = await app.inject({
      method: 'POST',
      url: `/v1/run-notices/notice-http-1/complete`,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: {
        token: 'notice-claim',
        delivered: true,
        comment_url: 'https://github.com/o/r/issues/1#issuecomment-9'
      }
    })
    assert.strictEqual(delivered.statusCode, 200)
    assert.deepStrictEqual(completed, [
      [
        'notice-http-1',
        'notice-claim',
        true,
        'https://github.com/o/r/issues/1#issuecomment-9'
      ]
    ])

    // The other branch must reject a URL rather than silently dropping it.
    const notDelivered = await app.inject({
      method: 'POST',
      url: `/v1/run-notices/notice-http-1/complete`,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: {
        token: 'notice-claim',
        delivered: false,
        comment_url: 'https://github.com/o/r/issues/1#issuecomment-9'
      }
    })
    assert.strictEqual(
      notDelivered.statusCode,
      400,
      'an undelivered notice must not carry a comment_url'
    )
  } finally {
    await app.close()
  }
})

test('an operation with no response body sends an empty 200, not a null body', async () => {
  // The contract declares no content for these; returning `null` produced a literal "null"
  // body that disagreed with the generated `void` type.
  const app = await buildApp({ preparations: { fail: async () => {} } })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/preparation/failure',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { token: 't', failure: { message: 'm' } }
    })
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.body, '')
  } finally {
    await app.close()
  }
})

test('a failure notice completion forwards an intentional skip through the HTTP route', async () => {
  const completions: unknown[][] = []
  const app = await buildApp({
    notices: {
      complete: async (...args: unknown[]) => {
        completions.push(args)
        return true
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/run-notices/notice-http-2/complete',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { token: 'notice-claim', delivered: false }
    })
    assert.strictEqual(response.statusCode, 200)
    assert.strictEqual(response.json(), true)
    assert.deepStrictEqual(completions, [
      // An undelivered notice carries no URL, so the store sees three arguments, not four.
      ['notice-http-2', 'notice-claim', false]
    ])
  } finally {
    await app.close()
  }
})

test('run notice claims use the notice store for every lifecycle axis', async () => {
  const pending = ['preparation', 'execution', 'publication'].map((axis) => ({
    notice_id: `notice-${axis}`,
    run_id: `run-${axis}`,
    input: { kind: 'github_issue_review' },
    kind: 'failure',
    axis,
    reason_code: 'REVIEW_FAILED',
    claim_token: `claim-${axis}`
  }))
  let next = 0
  // No preparation store is supplied: delivery is independent of the originating axis.
  const app = await buildApp({
    notices: { claimNext: async () => pending[next++] ?? null }
  })
  try {
    for (const expected of [...pending, null]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/run-notices/claims/next',
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
      })
      assert.strictEqual(response.statusCode, 200, response.body)
      assert.deepStrictEqual(response.json(), expected)
    }
  } finally {
    await app.close()
  }
})

test('run notice claim renewal and heartbeat configuration are exposed on the service surface', async () => {
  const renewals: unknown[][] = []
  const app = await buildApp({
    notices: {
      renewClaim: async (...args: unknown[]) => {
        renewals.push(args)
        return true
      },
      heartbeatIntervalMs: () => 12_345
    }
  })
  try {
    const renewed = await app.inject({
      method: 'POST',
      url: '/v1/run-notices/notice-http-3/claim',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { token: 'notice-claim' }
    })
    assert.strictEqual(renewed.statusCode, 200, renewed.body)
    assert.strictEqual(renewed.json(), true)
    assert.deepStrictEqual(renewals, [['notice-http-3', 'notice-claim']])

    const interval = await app.inject({
      method: 'GET',
      url: '/v1/config/run-notice-heartbeat-interval',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
    })
    assert.strictEqual(interval.statusCode, 200, interval.body)
    assert.strictEqual(interval.json(), 12_345)
  } finally {
    await app.close()
  }
})

test('a preparation input checkpoint is fenced by the HTTP route claim token', async () => {
  const checkpoints: unknown[][] = []
  const app = await buildApp({
    preparations: {
      checkpointInput: async (...args: unknown[]) => {
        checkpoints.push(args)
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/preparation/checkpoint',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { token: 'preparation-claim', input: { resolved: true } }
    })
    assert.strictEqual(response.statusCode, 200, response.body)
    assert.strictEqual(response.body, '')
    assert.deepStrictEqual(checkpoints, [
      [
        '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        'preparation-claim',
        { resolved: true }
      ]
    ])
  } finally {
    await app.close()
  }
})

test('a deterministic publication failure maps to 409 with its code', async () => {
  const { DeterministicReviewRunError, PUBLICATION_STEP_ERROR_CODES } =
    await import(new URL('../dist/errors.js', import.meta.url).href)
  const app = await buildApp({
    preparations: {
      renewClaim: async () => {
        throw new DeterministicReviewRunError(
          'duplicate step set',
          PUBLICATION_STEP_ERROR_CODES.set_duplicate
        )
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/preparation/claim',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: { token: 'token-1' }
    })
    assert.strictEqual(response.statusCode, 409)
    assert.deepStrictEqual(response.json(), {
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
    admissions: {
      admit: async () => {
        handlerCalls += 1
        return {
          // This test only needs body validation to reject the request before the handler's
          // result is read, so the record is the minimum the shape needs.
          record: {
            run_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            workflow: 'issue-review'
          },
          created: true,
          preparation_token: 'token'
        }
      }
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: {
        workflow: 'issue-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'k',
        run_id: 'attacker-supplied'
      }
    })
    assert.strictEqual(response.statusCode, 400)
    assert.strictEqual(
      handlerCalls,
      0,
      'an undeclared field must be rejected before the handler'
    )
  } finally {
    await app.close()
  }
})

test('remote_object.id is accepted only in its canonical string form', async () => {
  // The contract declares `remote_object.id` as `type: [string, "null"]`, and Review Runs
  // validates bodies with `coerceTypes: false`, so a value must be that type literally — a
  // JSON number (the pre-normalization GitHub shape) and a boolean are rejected, not coerced.
  // The client's `String(remote.id)` is what turns a GitHub number into the accepted form.
  let received: unknown
  const app = await buildApp({
    publications: {
      completePublicationStep: async (
        _runId: string,
        _token: string,
        _stepKey: string,
        remote: unknown
      ) => {
        received = remote
        return true
      }
    }
  })
  try {
    for (const id of ['1234', null]) {
      received = undefined
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/publication/steps/issue:draft-pr/complete',
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          'content-type': 'application/json'
        },
        payload: {
          token: 'token-1',
          remote_object: { id, url: 'https://example.test/1' }
        }
      })
      assert.strictEqual(
        response.statusCode,
        200,
        `id ${JSON.stringify(id)} must validate`
      )
      assert.deepStrictEqual(received, { id, url: 'https://example.test/1' })
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
    publications: {
      completePublicationStep: async () => {
        handlerCalls += 1
        return true
      }
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
      assert.strictEqual(
        response.statusCode,
        400,
        `id ${JSON.stringify(id)} must be rejected`
      )
      assert.strictEqual(
        (response.json() as { code?: string }).code,
        'INVALID_BODY',
        'a body that fails the contract is INVALID_BODY'
      )
    }
    assert.strictEqual(
      handlerCalls,
      0,
      'an invalid id must be rejected before the handler'
    )
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
    queries: {
      listRunsPage: async () => {
        calls += 1
        return { runs: [], next_cursor: null, dropped: [] }
      }
    }
  })
  try {
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/runs?limit=10',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.strictEqual(ok.statusCode, 200)
    assert.strictEqual(calls, 1, 'a coerced integer must reach the handler')

    // The contract also bounds the page: 0 and 101 are integers the schema refuses, so the
    // read model never has to clamp a value the caller was allowed to send.
    for (const bad of ['abc', '10.5', '', '0', '101']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs?limit=${bad}`,
        headers: { authorization: `Bearer ${READ_TOKEN}` }
      })
      assert.strictEqual(
        response.statusCode,
        400,
        `limit=${JSON.stringify(bad)} must be rejected`
      )
      assert.strictEqual(
        (response.json() as { code?: string }).code,
        'INVALID_QUERY'
      )
    }
    assert.strictEqual(calls, 1, 'a rejected query must not reach the handler')
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
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: '{not json'
    })
    assert.strictEqual(response.statusCode, 400)
    assert.deepStrictEqual(response.json(), {
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
    admissions: {
      admit: async () =>
        assert.fail('the handler must not run for an oversized body')
    }
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: JSON.stringify({ padding: 'a'.repeat(1024 * 1024 + 1) })
    })
    assert.strictEqual(response.statusCode, 413)
    assert.deepStrictEqual(response.json(), {
      error: 'Request body is too large.'
    })
  } finally {
    await app.close()
  }
})

test('the admin surface is absent unless an admin token is configured', async () => {
  // An unconfigured deployment must not advertise an operator surface. Answering 401 would say
  // "this route exists, you just lack the credential", which is exactly the information a
  // deployment that deliberately has no admin route should not leak. The check runs before
  // routing, because fastify-openapi-glue rewrites any security-handler failure into its own
  // 401 regardless of the status the handler chose.
  const runId = '0123abcd-4567-89ef-0123-456789abcdef'
  const path = `/v1/admin/runs/${runId}/abandon`
  const body = { reason: 'operator says stop' }

  const unconfigured = await buildApp({
    connectorId: 'github-integration:test'
  })
  try {
    for (const headers of [
      {},
      { authorization: `Bearer ${SERVICE_TOKEN}` },
      { authorization: 'Bearer any-other-value' }
    ]) {
      const response = await unconfigured.inject({
        method: 'POST',
        url: path,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: body
      })
      assert.strictEqual(
        response.statusCode,
        404,
        `an unconfigured admin surface must not exist (tried ${JSON.stringify(headers)})`
      )
      assert.deepStrictEqual(response.json(), { error: 'not_found' })
    }
  } finally {
    await unconfigured.close()
  }

  // Configured: the credential must be the admin token. In particular the service token, which
  // a component holds, must not reach an operator decision.
  const adminToken = 'admin-token'
  // One record shaped as each decision returns it: abandoning concludes preparation as
  // `failed`, resuming hands it back as `uncertain`.
  const adminRecord = (preparationStatus: 'failed' | 'uncertain') => ({
    run_id: runId,
    workflow: 'issue-review',
    source_platform: 'github',
    connector_id: 'github-integration:test',
    preparation: {
      status: preparationStatus,
      attempt_count: 1,
      disconnect_reason: null,
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
      failure_code:
        preparationStatus === 'failed' ? 'EXECUTION_ALREADY_ADVANCED' : null
    },
    execution: {
      status: 'succeeded',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    publication: {
      status: 'skipped',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    publish_context: {},
    created_at: '2026-01-01T00:00:00.000Z',
    failure_code: null,
    failure_message: null,
    artifact_storage: null,
    notices: []
  })
  const store = {
    connectorId: 'github-integration:test',
    operatorDecisions: {
      abandonBlockedPreparation: async () => adminRecord('failed'),
      resumeDisconnectedRun: async () => adminRecord('uncertain')
    }
  }
  const configured = await buildApp(store, adminToken)
  try {
    const anonymous = await configured.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      payload: body
    })
    assert.strictEqual(anonymous.statusCode, 401)
    const viaService = await configured.inject({
      method: 'POST',
      url: path,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json'
      },
      payload: body
    })
    assert.strictEqual(
      viaService.statusCode,
      401,
      'the service token must not reach an operator decision'
    )
    const accepted = await configured.inject({
      method: 'POST',
      url: path,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json'
      },
      payload: body
    })
    assert.strictEqual(accepted.statusCode, 200)
    assert.strictEqual(
      (accepted.json() as { preparation: { status: string } }).preparation
        .status,
      'failed'
    )

    // Resuming is an operator decision too, and it goes through the same credential gate. It
    // posts no body, so the route must not require one.
    const resumePath = `/v1/admin/runs/${runId}/resume`
    const anonymousResume = await configured.inject({
      method: 'POST',
      url: resumePath
    })
    assert.strictEqual(anonymousResume.statusCode, 401)
    const viaServiceResume = await configured.inject({
      method: 'POST',
      url: resumePath,
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` }
    })
    assert.strictEqual(viaServiceResume.statusCode, 401)
    const resumed = await configured.inject({
      method: 'POST',
      url: resumePath,
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.strictEqual(resumed.statusCode, 200)
  } finally {
    await configured.close()
  }
})

test('the resume route answers 409 for a run that is not disconnected', async () => {
  // The store decides eligibility; this pins that a refusal surfaces as the contract's 409
  // rather than an opaque fault, so the console can explain what happened.
  const app = await buildApp(
    {
      connectorId: 'github-integration:test',
      operatorDecisions: {
        resumeDisconnectedRun: async () => {
          throw Object.assign(
            new Error('Review run x has no disconnected axis to resume.'),
            { statusCode: 409 }
          )
        }
      }
    },
    'admin-token'
  )
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/runs/0123abcd-4567-89ef-0123-456789abcdef/resume',
      headers: { authorization: 'Bearer admin-token' }
    })
    assert.strictEqual(response.statusCode, 409)
  } finally {
    await app.close()
  }
})

test('the blocked preparation queue is readable with the read token', async () => {
  // Knowing a run is stuck is not privileged: the console must be able to surface the queue
  // without holding an operator credential. Only acting on it is admin-gated.
  const app = await buildApp({
    connectorId: 'github-integration:test',
    queries: {
      listParkedRuns: async () => [
        {
          run_id: 'run-1',
          axis: 'preparation',
          reason: 'EXECUTION_ALREADY_ADVANCED',
          parked_at: '2026-10-28T10:00:00.000Z'
        }
      ]
    }
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runs/parked',
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    })
    assert.strictEqual(response.statusCode, 200)
    assert.deepStrictEqual(response.json(), {
      blocks: [
        {
          run_id: 'run-1',
          axis: 'preparation',
          reason: 'EXECUTION_ALREADY_ADVANCED',
          parked_at: '2026-10-28T10:00:00.000Z'
        }
      ]
    })
    const anonymous = await app.inject({
      method: 'GET',
      url: '/v1/runs/parked'
    })
    assert.strictEqual(anonymous.statusCode, 401)
  } finally {
    await app.close()
  }
})
