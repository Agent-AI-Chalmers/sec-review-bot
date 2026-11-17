import assert from 'node:assert/strict'

import { request as sendRequest, type RequestOptions } from './http.js'
import { uiAccessToken } from './credentials.js'

const ui = 'http://control-plane-ui:8091'

export async function verifyBff(runId: string) {
  let cookie = ''
  function request(
    options: Omit<RequestOptions, 'base' | 'token' | 'headers'>
  ) {
    return sendRequest({
      ...options,
      base: ui,
      headers: { origin: ui, ...(cookie ? { cookie } : {}) }
    })
  }

  await request({ method: 'GET', path: '/api/runs', expectedStatus: 401 })
  const session = await request({
    method: 'POST',
    path: '/api/session',
    expectedStatus: 204,
    json: {
      token: uiAccessToken
    }
  })
  const sessionCookie = session.headers.get('set-cookie')
  assert.ok(sessionCookie, 'Login must issue a session cookie')
  cookie = sessionCookie.split(';')[0] ?? ''
  assert.ok(cookie, 'Session cookie must not be empty')

  const page = (await (
    await request({ method: 'GET', path: '/api/runs', expectedStatus: 200 })
  ).json()) as {
    runs: { run_id: string }[]
  }
  assert.deepEqual(
    page.runs.map((run) => run.run_id),
    [runId]
  )
  const { run } = (await (
    await request({
      method: 'GET',
      path: `/api/runs/${runId}`,
      expectedStatus: 200
    })
  ).json()) as {
    run: { run_id: string; execution: { status: string } }
  }
  assert.equal(run.run_id, runId)
  assert.equal(run.execution.status, 'failed')
  console.error('ok: Authenticated console read the real Review Runs task')

  const files = {
    'MEMORY.md': '# Smoke memory\n\nRemember the deployed storage boundary.\n'
  }
  const created = (await (
    await request({
      method: 'POST',
      path: '/api/memory/edit',
      expectedStatus: 201,
      json: {
        operation_id: 'smoke-memory-edit',
        expected_active_version: 0,
        files
      }
    })
  ).json()) as { created: boolean; version: number }
  assert.equal(created.created, true)
  assert.equal(created.version, 1)

  const versions = (await (
    await request({
      method: 'GET',
      path: '/api/memory/versions',
      expectedStatus: 200
    })
  ).json()) as {
    versions: { version: number }[]
  }
  assert.deepEqual(
    versions.versions.map((entry) => entry.version),
    [created.version]
  )
  const content = (await (
    await request({
      method: 'GET',
      path: `/api/memory/versions/${created.version}/content`,
      expectedStatus: 200
    })
  ).json()) as {
    files: Record<string, string>
  }
  assert.deepEqual(content.files, files)
  console.error(
    'ok: Console committed a memory version and read its stored contents'
  )
}
