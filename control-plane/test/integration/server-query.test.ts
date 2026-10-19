import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required.')
  return value
}

test('authenticated run queries are redacted, paginated, and survive a server restart', async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const token = `query-token-${randomUUID()}`
  const connectorId = `server-query:${randomUUID()}`
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    CONTROL_PLANE_PORT: String(port),
    CONTROL_PLANE_SERVICE_TOKEN: `mutation-${token}`,
    CONTROL_PLANE_READ_TOKEN: token,
    CONNECTOR_ID: connectorId,
    AGENT_RUNNER_SERVICE_URL: 'http://127.0.0.1:1',
    AGENT_RUNNER_SERVICE_TOKEN: 'unused'
  })
  const { startControlPlaneServer } = await import('../../src/server.js')
  const base = `http://127.0.0.1:${port}`
  const readAuth = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
  const mutationAuth = {
    authorization: `Bearer mutation-${token}`,
    'content-type': 'application/json'
  }
  let server = await startControlPlaneServer()
  try {
    const unauthorized = await fetch(`${base}/v1/runs?limit=1`)
    assert.strictEqual(unauthorized.status, 401)
    const unfiltered = await fetch(`${base}/v1/runs`, { headers: readAuth })
    assert.strictEqual(unfiltered.status, 200)
    assert.deepStrictEqual(await unfiltered.json(), {
      runs: [],
      next_cursor: null
    })
    // The query filters are validated by the contract (glue mounts it as the route schema),
    // so the envelope's stable part is the status and code; the message comes from the schema
    // validator and is deliberately not pinned here.
    const invalidExecutionStatus = await fetch(
      `${base}/v1/runs?execution_status=typo`,
      {
        headers: readAuth
      }
    )
    assert.strictEqual(invalidExecutionStatus.status, 400)
    assert.strictEqual(
      ((await invalidExecutionStatus.json()) as { code?: string }).code,
      'INVALID_QUERY'
    )
    const invalidPublicationStatus = await fetch(
      `${base}/v1/runs?publication_status=typo`,
      {
        headers: readAuth
      }
    )
    assert.strictEqual(invalidPublicationStatus.status, 400)
    assert.strictEqual(
      ((await invalidPublicationStatus.json()) as { code?: string }).code,
      'INVALID_QUERY'
    )
    const invalidWorkflow = await fetch(`${base}/v1/runs?workflow=typo`, {
      headers: readAuth
    })
    assert.strictEqual(invalidWorkflow.status, 400)
    assert.strictEqual(
      ((await invalidWorkflow.json()) as { code?: string }).code,
      'INVALID_QUERY'
    )
    const invalidLimit = await fetch(`${base}/v1/runs?limit=10junk`, {
      headers: readAuth
    })
    assert.strictEqual(invalidLimit.status, 400)
    // An undeclared query parameter is rejected, matching the request bodies' refusal of
    // undeclared fields: the query is one `additionalProperties: false` object.
    const unknownParameter = await fetch(`${base}/v1/runs?bogus=1`, {
      headers: readAuth
    })
    assert.strictEqual(unknownParameter.status, 400)
    assert.strictEqual(
      ((await unknownParameter.json()) as { code?: string }).code,
      'INVALID_QUERY'
    )

    // A write request whose body the contract rejects — here an admission missing its required
    // `workflow` — is a 400 from the route's own schema, the same `InvalidRequest` envelope the
    // query filters above produce.
    const missingWorkflow = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: mutationAuth,
      body: JSON.stringify({
        publish_context: { secret: 'must-not-leak' },
        ingress_kind: 'github_webhook',
        ingress_key: 'delivery:missing-workflow'
      })
    })
    assert.strictEqual(missingWorkflow.status, 400)

    const runIds: string[] = []
    for (const ingressKey of [
      `delivery:${randomUUID()}`,
      `delivery:${randomUUID()}`
    ]) {
      const admitted = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: mutationAuth,
        body: JSON.stringify({
          workflow: 'issue-review',
          ingress_kind: 'github_webhook',
          ingress_key: ingressKey,
          publish_context: { secret: 'must-not-leak' },
          preparation_input_version: 'v1',
          preparation_input: { kind: 'test' }
        })
      })
      assert.strictEqual(admitted.status, 200)
      const body = (await admitted.json()) as { record: { run_id: string } }
      runIds.push(body.record.run_id)
    }

    const detail = await fetch(`${base}/v1/runs/${runIds[0]}`, {
      headers: readAuth
    })
    const detailText = await detail.text()
    assert.strictEqual(detail.status, 200)
    assert.strictEqual(detailText.includes('must-not-leak'), false)
    assert.strictEqual(detailText.includes('publish_context'), false)

    const firstPage = await fetch(`${base}/v1/runs?limit=1`, {
      headers: readAuth
    })
    const firstBody = (await firstPage.json()) as {
      runs: Array<{ run_id: string }>
      next_cursor: string | null
    }
    assert.strictEqual(firstBody.runs.length, 1)
    assert.notStrictEqual(firstBody.next_cursor, null)
    const secondPage = await fetch(
      `${base}/v1/runs?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
      { headers: readAuth }
    )
    const secondBody = (await secondPage.json()) as {
      runs: Array<{ run_id: string }>
    }
    assert.strictEqual(secondBody.runs.length, 1)
    assert.notStrictEqual(secondBody.runs[0]?.run_id, firstBody.runs[0]?.run_id)

    // The created-at range was accepted by the API but never covered, so a broken
    // bound would have filtered silently.
    const past = encodeURIComponent('2000-01-01T00:00:00.000Z')
    const future = encodeURIComponent('2100-01-01T00:00:00.000Z')
    const boundedAbove = await fetch(`${base}/v1/runs?from=${past}`, {
      headers: readAuth
    })
    assert.strictEqual(
      ((await boundedAbove.json()) as { runs: unknown[] }).runs.length,
      2
    )
    const notYet = await fetch(`${base}/v1/runs?from=${future}`, {
      headers: readAuth
    })
    assert.deepStrictEqual(await notYet.json(), { runs: [], next_cursor: null })
    const beforeEverything = await fetch(`${base}/v1/runs?to=${past}`, {
      headers: readAuth
    })
    assert.deepStrictEqual(await beforeEverything.json(), {
      runs: [],
      next_cursor: null
    })
    const invalidFrom = await fetch(`${base}/v1/runs?from=not-a-date`, {
      headers: readAuth
    })
    assert.strictEqual(invalidFrom.status, 400)
    assert.strictEqual(
      ((await invalidFrom.json()) as { code?: string }).code,
      'INVALID_QUERY'
    )

    await server.close()
    server = await startControlPlaneServer()
    const afterRestart = await fetch(`${base}/v1/runs/${runIds[0]}`, {
      headers: readAuth
    })
    assert.strictEqual(afterRestart.status, 200)
  } finally {
    await server.close()
  }
})
