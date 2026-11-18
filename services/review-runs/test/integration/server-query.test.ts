import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { Pool } from 'pg'

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
    REVIEW_RUNS_PORT: String(port),
    REVIEW_RUNS_SERVICE_TOKEN: `mutation-${token}`,
    REVIEW_RUNS_READ_TOKEN: token,
    CONNECTOR_ID: connectorId,
    EXECUTION_API_URL: 'http://127.0.0.1:1',
    EXECUTION_API_TOKEN: 'unused'
  })
  const { startReviewRunsServer } = await import('../../src/runtime/server-runtime.js')
  const base = `http://127.0.0.1:${port}`
  const readAuth = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  }
  const mutationAuth = {
    authorization: `Bearer mutation-${token}`,
    'content-type': 'application/json'
  }
  let server = await startReviewRunsServer()
  try {
    const unauthorized = await fetch(`${base}/v1/runs?limit=1`)
    expect(unauthorized.status).toBe(401)
    const unfiltered = await fetch(`${base}/v1/runs`, { headers: readAuth })
    expect(unfiltered.status).toBe(200)
    expect(await unfiltered.json()).toStrictEqual({
      runs: [],
      next_cursor: null
    })
    // The query filters are validated by the contract (glue mounts it as the route schema),
    // so the envelope's stable part is the status and code; the message comes from the schema
    // validator and is deliberately not pinned here.
    const invalidExecutionStatus = await fetch(`${base}/v1/runs?execution_status=typo`, {
      headers: readAuth
    })
    expect(invalidExecutionStatus.status).toBe(400)
    expect(((await invalidExecutionStatus.json()) as { code?: string }).code).toBe('INVALID_QUERY')
    const invalidPublicationStatus = await fetch(`${base}/v1/runs?publication_status=typo`, {
      headers: readAuth
    })
    expect(invalidPublicationStatus.status).toBe(400)
    expect(((await invalidPublicationStatus.json()) as { code?: string }).code).toBe(
      'INVALID_QUERY'
    )
    const invalidPreparationStatus = await fetch(`${base}/v1/runs?preparation_status=typo`, {
      headers: readAuth
    })
    expect(invalidPreparationStatus.status).toBe(400)
    expect(((await invalidPreparationStatus.json()) as { code?: string }).code).toBe(
      'INVALID_QUERY'
    )
    const invalidSourcePlatform = await fetch(`${base}/v1/runs?source_platform=gitlab`, {
      headers: readAuth
    })
    expect(invalidSourcePlatform.status).toBe(400)
    expect(((await invalidSourcePlatform.json()) as { code?: string }).code).toBe('INVALID_QUERY')
    const invalidWorkflow = await fetch(`${base}/v1/runs?workflow=typo`, {
      headers: readAuth
    })
    expect(invalidWorkflow.status).toBe(400)
    expect(((await invalidWorkflow.json()) as { code?: string }).code).toBe('INVALID_QUERY')
    const invalidLimit = await fetch(`${base}/v1/runs?limit=10junk`, {
      headers: readAuth
    })
    expect(invalidLimit.status).toBe(400)
    // An undeclared query parameter is rejected, matching the request bodies' refusal of
    // undeclared fields: the query is one `additionalProperties: false` object.
    const unknownParameter = await fetch(`${base}/v1/runs?bogus=1`, {
      headers: readAuth
    })
    expect(unknownParameter.status).toBe(400)
    expect(((await unknownParameter.json()) as { code?: string }).code).toBe('INVALID_QUERY')

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
    expect(missingWorkflow.status).toBe(400)

    const runIds: string[] = []
    for (const ingressKey of [`delivery:${randomUUID()}`, `delivery:${randomUUID()}`]) {
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
      expect(admitted.status).toBe(200)
      const body = (await admitted.json()) as { record: { run_id: string } }
      runIds.push(body.record.run_id)
    }

    const detail = await fetch(`${base}/v1/runs/${runIds[0]}`, {
      headers: readAuth
    })
    const detailText = await detail.text()
    expect(detail.status).toBe(200)
    expect(detailText.includes('must-not-leak')).toBe(false)
    expect(detailText.includes('publish_context')).toBe(false)

    const firstPage = await fetch(`${base}/v1/runs?limit=1`, {
      headers: readAuth
    })
    const firstBody = (await firstPage.json()) as {
      runs: Array<{ run_id: string }>
      next_cursor: string | null
    }
    expect(firstBody.runs).toHaveLength(1)
    expect(firstBody.next_cursor).not.toBe(null)
    const secondPage = await fetch(
      `${base}/v1/runs?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
      { headers: readAuth }
    )
    const secondBody = (await secondPage.json()) as {
      runs: Array<{ run_id: string }>
    }
    expect(secondBody.runs).toHaveLength(1)
    expect(secondBody.runs[0]?.run_id).not.toBe(firstBody.runs[0]?.run_id)

    // The coordination event log is the operator timeline the console renders. Its read path
    // is new, so pin the whole HTTP surface: authentication, the admission events, oldest-first
    // ordering, and a run id this connector cannot see reading as 404 rather than empty.
    const unauthorizedEvents = await fetch(`${base}/v1/runs/${runIds[0]}/events`)
    expect(unauthorizedEvents.status).toBe(401)
    const events = await fetch(`${base}/v1/runs/${runIds[0]}/events`, {
      headers: readAuth
    })
    expect(events.status).toBe(200)
    const eventsBody = (await events.json()) as {
      run_id: string
      events: Array<{
        event_id: number
        axis: string
        from_status: string | null
        to_status: string
        occurred_at: string
      }>
    }
    expect(eventsBody.run_id).toBe(runIds[0])
    // Admission writes one event per axis inside the admitting transaction.
    expect(eventsBody.events.map((event) => `${event.axis}:${event.to_status}`)).toStrictEqual([
      'execution:pending',
      'preparation:preparing',
      'publication:pending'
    ])
    const occurredAt = eventsBody.events.map((event) => Date.parse(event.occurred_at))
    expect(occurredAt, 'events are returned oldest first').toStrictEqual(
      [...occurredAt].sort((left, right) => left - right)
    )
    const unknownRunEvents = await fetch(`${base}/v1/runs/${randomUUID()}/events`, {
      headers: readAuth
    })
    expect(unknownRunEvents.status).toBe(404)
    expect(await unknownRunEvents.json()).toStrictEqual({
      error: 'run_not_found'
    })
    // The path parameter is contract-validated like every other run id.
    const malformedRunEvents = await fetch(`${base}/v1/runs/not-a-uuid/events`, {
      headers: readAuth
    })
    expect(malformedRunEvents.status).toBe(400)

    // The created-at range was accepted by the API but never covered, so a broken
    // bound would have filtered silently.
    const past = encodeURIComponent('2000-01-01T00:00:00.000Z')
    const future = encodeURIComponent('2100-01-01T00:00:00.000Z')
    const boundedAbove = await fetch(`${base}/v1/runs?from=${past}`, {
      headers: readAuth
    })
    expect(((await boundedAbove.json()) as { runs: unknown[] }).runs).toHaveLength(2)
    const notYet = await fetch(`${base}/v1/runs?from=${future}`, {
      headers: readAuth
    })
    expect(await notYet.json()).toStrictEqual({ runs: [], next_cursor: null })
    const beforeEverything = await fetch(`${base}/v1/runs?to=${past}`, {
      headers: readAuth
    })
    expect(await beforeEverything.json()).toStrictEqual({
      runs: [],
      next_cursor: null
    })
    const invalidFrom = await fetch(`${base}/v1/runs?from=not-a-date`, {
      headers: readAuth
    })
    expect(invalidFrom.status).toBe(400)
    expect(((await invalidFrom.json()) as { code?: string }).code).toBe('INVALID_QUERY')

    // The event log belongs to the run trunk, so a run whose axis row is unrepresentable still
    // has a readable history. Before this used the full record projection, which reports that
    // corruption as "not found", hiding the very timeline an operator needs to diagnose it.
    const corruptRunId = runIds[1]
    const writePool = new Pool({ connectionString: databaseUrl() })
    try {
      await writePool.query('DELETE FROM executions WHERE run_id=$1', [corruptRunId])
      const corruptDetail = await fetch(`${base}/v1/runs/${corruptRunId}`, {
        headers: readAuth
      })
      expect(
        corruptDetail.status,
        'the record read still treats the corrupt run as unrepresentable'
      ).toBe(404)
      const corruptEvents = await fetch(`${base}/v1/runs/${corruptRunId}/events`, {
        headers: readAuth
      })
      expect(corruptEvents.status, 'the event log stays readable for a corrupt run').toBe(200)
      const corruptBody = (await corruptEvents.json()) as {
        run_id: string
        events: unknown[]
      }
      expect(corruptBody.run_id).toBe(corruptRunId)
      expect.assert(corruptBody.events.length > 0)
    } finally {
      await writePool.end()
    }

    await server.close()
    server = await startReviewRunsServer()
    const afterRestart = await fetch(`${base}/v1/runs/${runIds[0]}`, {
      headers: readAuth
    })
    expect(afterRestart.status).toBe(200)
  } finally {
    await server.close()
  }
})
