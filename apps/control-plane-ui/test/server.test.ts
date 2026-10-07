import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createControlPlaneUiServer } from '../server/index.js'

test('BFF authenticates sessions and proxies only read queries', async () => {
  let authorization = ''
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization ?? ''
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"runs":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    assert.equal((await fetch(`${base}/api/runs`)).status, 401)
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    assert.equal(login.status, 204)
    const cookie = login.headers.get('set-cookie')
    assert(cookie?.includes('HttpOnly'))
    assert(cookie !== null)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.equal(query.status, 200)
    assert.equal(authorization, 'Bearer read-secret')
    assert.equal(
      (await fetch(`${base}/api/runs`, { method: 'POST', headers: { cookie } })).status,
      404
    )
    assert.equal((await fetch(`${base}/api/store`, { headers: { cookie } })).status, 404)
    const oversizedLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(1024 * 1024) })
    })
    assert.equal(oversizedLogin.status, 413)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF returns a gateway error when Control Plane is unavailable', async () => {
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: 'http://127.0.0.1:1',
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert.equal(login.status, 204)
    assert(cookie)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.equal(query.status, 502)
    assert.deepEqual(await query.json(), { error: 'control_plane_unavailable' })
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})
