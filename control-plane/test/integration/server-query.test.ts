import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

function databaseUrl (): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required.')
  return value
}

test('authenticated run queries are redacted, paginated, and survive a server restart', async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000)
  const token = `query-token-${randomUUID()}`
  const connectorId = `server-query:${randomUUID()}`
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: databaseUrl(), CONTROL_PLANE_PORT: String(port),
    CONTROL_PLANE_SERVICE_TOKEN: `mutation-${token}`, CONTROL_PLANE_READ_TOKEN: token, CONNECTOR_ID: connectorId,
    AGENT_RUNNER_SERVICE_URL: 'http://127.0.0.1:1', AGENT_RUNNER_SERVICE_TOKEN: 'unused'
  })
  const { startControlPlaneServer } = await import('../../src/server.js')
  const base = `http://127.0.0.1:${port}`
  const readAuth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const mutationAuth = { authorization: `Bearer mutation-${token}`, 'content-type': 'application/json' }
  let server = await startControlPlaneServer()
  try {
    const unauthorized = await fetch(`${base}/v1/runs?limit=1`)
    assert.equal(unauthorized.status, 401)

    const runIds: string[] = []
    for (const ingressKey of [`delivery:${randomUUID()}`, `delivery:${randomUUID()}`]) {
      const admitted = await fetch(`${base}/v1/store`, {
        method: 'POST', headers: mutationAuth,
        body: JSON.stringify({ operation: 'admit_review_run', args: [{
          workflow: 'issue-review', ingress_kind: 'github_webhook', ingress_key: ingressKey,
          publish_context: { secret: 'must-not-leak' }
        }] })
      })
      assert.equal(admitted.status, 200)
      const body = await admitted.json() as { result: { record: { run_id: string } } }
      runIds.push(body.result.record.run_id)
    }

    const detail = await fetch(`${base}/v1/runs/${runIds[0]}`, { headers: readAuth })
    const detailText = await detail.text()
    assert.equal(detail.status, 200)
    assert.equal(detailText.includes('must-not-leak'), false)
    assert.equal(detailText.includes('publish_context'), false)

    const firstPage = await fetch(`${base}/v1/runs?limit=1`, { headers: readAuth })
    const firstBody = await firstPage.json() as { runs: Array<{ run_id: string }>, next_cursor: string | null }
    assert.equal(firstBody.runs.length, 1)
    assert.notEqual(firstBody.next_cursor, null)
    const secondPage = await fetch(`${base}/v1/runs?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`, { headers: readAuth })
    const secondBody = await secondPage.json() as { runs: Array<{ run_id: string }> }
    assert.equal(secondBody.runs.length, 1)
    assert.notEqual(secondBody.runs[0]?.run_id, firstBody.runs[0]?.run_id)

    await server.close()
    server = await startControlPlaneServer()
    const afterRestart = await fetch(`${base}/v1/runs/${runIds[0]}`, { headers: readAuth })
    assert.equal(afterRestart.status, 200)
  } finally { await server.close() }
})
