import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

import { catalog, gateway, request, runs } from './http.js'
import { serviceToken, readToken, catalogOperatorToken } from './credentials.js'

type Run = {
  run_id: string
  workflow: string
  preparation: { status: string }
  execution: { status: string }
}
export type Admission = {
  record: Run
  created: boolean
  preparation_token: string | null
}
type RunPage = { runs: Run[] }
type ObservedRun = { run: Run }

export async function admit(): Promise<void> {
  for (const base of [gateway, runs, catalog]) {
    const response = await request({
      base: base,
      method: 'GET',
      path: '/healthz',
      expectedStatus: 200
    })
    assert.equal(((await response.json()) as { status: string }).status, 'ok')
  }
  await request({
    base: runs,
    method: 'GET',
    path: '/readyz',
    expectedStatus: 200
  })
  await request({
    base: runs,
    method: 'GET',
    path: '/v1/runs',
    expectedStatus: 401
  })
  const page = await request({
    base: runs,
    method: 'GET',
    path: '/v1/runs',
    expectedStatus: 200,
    token: readToken
  })
  assert.deepEqual(((await page.json()) as RunPage).runs, [])
  await request({
    base: catalog,
    method: 'GET',
    path: '/v1/memory-tree/versions',
    expectedStatus: 401
  })
  await request({
    base: catalog,
    method: 'GET',
    path: '/v1/memory-tree/versions',
    expectedStatus: 200,
    token: catalogOperatorToken
  })

  const publishContext = { smoke: true }
  const admissionInput = {
    workflow: 'issue-review',
    publish_context: publishContext,
    preparation_input_version: 'smoke-v1',
    preparation_input: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'compose-smoke'
  }
  const admission = (await (
    await request({
      base: runs,
      method: 'POST',
      path: '/v1/runs',
      expectedStatus: 200,
      token: serviceToken,
      json: admissionInput
    })
  ).json()) as Admission
  assert.equal(admission.created, true)
  assert.equal(typeof admission.preparation_token, 'string')
  const runId = admission.record.run_id
  const replay = (await (
    await request({
      base: runs,
      method: 'POST',
      path: '/v1/runs',
      expectedStatus: 200,
      token: serviceToken,
      json: admissionInput
    })
  ).json()) as Admission
  assert.equal(replay.created, false)
  assert.equal(replay.record.run_id, runId)
  assert.equal(replay.preparation_token, null)
  const admitted = (await (
    await request({
      base: runs,
      method: 'GET',
      path: '/v1/runs',
      expectedStatus: 200,
      token: readToken
    })
  ).json()) as RunPage
  assert.deepEqual(
    admitted.runs.map((run) => run.run_id),
    [runId]
  )
  console.error('ok: Repeated ingress retained one task and its original claim')
  // Preserve the original claim across the out-of-process storage probe.
  console.log(JSON.stringify(admission))
}

export async function verifyRecovery(runId: string): Promise<void> {
  assert.match(runId ?? '', /^[0-9a-f-]{36}$/, 'A workflow ID is required')
  const persisted = (await (
    await request({
      base: runs,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: readToken
    })
  ).json()) as ObservedRun
  assert.equal(persisted.run.run_id, runId)
  assert.equal(persisted.run.workflow, 'issue-review')
  assert.equal(persisted.run.preparation.status, 'submitted')
  const page = (await (
    await request({
      base: runs,
      method: 'GET',
      path: '/v1/runs',
      expectedStatus: 200,
      token: readToken
    })
  ).json()) as RunPage
  assert.deepEqual(
    page.runs.map((run) => run.run_id),
    [runId]
  )
  console.error('ok: Submitted task survived the Review Runs restart')
  const deadline = Date.now() + 15000
  while (true) {
    const response = await request({
      base: runs,
      method: 'GET',
      path: `/v1/runs/${runId}`,
      expectedStatus: 200,
      token: readToken
    })
    const { run } = (await response.json()) as ObservedRun
    if (run.execution.status === 'failed') break
    assert.ok(
      Date.now() < deadline,
      `Execution did not become failed: ${run.execution.status}`
    )
    await setTimeout(250)
  }
  console.error(
    'ok: Restarted Review Runs observed the execution terminated while it was offline'
  )
}
