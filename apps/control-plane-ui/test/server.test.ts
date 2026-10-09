import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createControlPlaneUiServer } from '../server/index.js'

test('BFF authenticates sessions and proxies only read queries', async () => {
  let authorization = ''
  let upstreamPath = ''
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization ?? ''
    upstreamPath = request.url ?? ''
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
    assert.equal(upstreamPath, '/v1/runs')
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
    const unicodeLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: '\u00e9'.repeat('login-secret'.length) })
    })
    assert.equal(unicodeLogin.status, 401)
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
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

test('BFF streams only the artifact referenced by an authenticated run', async () => {
  const runId = 'run-1'
  const artifactBody = 'artifact'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/zstd',
              digest: `sha256:${crypto.createHash('sha256').update(artifactBody).digest('hex')}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  let requestedKey = ''
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(key): Promise<{ body: Readable; contentLength: number }> {
        requestedKey = key
        return { body: Readable.from([artifactBody]), contentLength: 8 }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(`${base}/api/runs/${runId}/artifact`)).status, 401)
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.equal(download.status, 200)
    assert.equal(await download.text(), 'artifact')
    assert.equal(requestedKey, `runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`)
    assert.equal(download.headers.get('content-type'), 'application/octet-stream')
    assert.equal(
      download.headers.get('content-disposition'),
      'attachment; filename="diagnostic-tree.v1.tar.zst"'
    )
    assert.equal(download.headers.get('cache-control'), 'private, no-store')
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects artifact metadata that does not belong to the requested run', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: 'run-1',
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: 's3://sec-review/runs/run-2/artifacts/diagnostic-tree.v1.tar.zst',
              media_type: 'application/zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  let storageCalled = false
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable }> {
        storageCalled = true
        return { body: Readable.from([]) }
      }
    }
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
    assert(cookie)
    const download = await fetch(`${base}/api/runs/run-1/artifact`, { headers: { cookie } })
    assert.equal(download.status, 409)
    assert.equal(storageCalled, false)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects an object whose size does not match the available artifact', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body: Readable.from(['wrong']), contentLength: 5 }
      }
    }
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
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, { headers: { cookie } })
    assert.equal(download.status, 502)
    assert.deepEqual(await download.json(), { error: 'artifact_identity_mismatch' })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects same-size artifact content that does not match the stored digest', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/zstd',
              digest: `sha256:${crypto.createHash('sha256').update('expected').digest('hex')}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body: Readable.from(['replaced']), contentLength: 8 }
      }
    }
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
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, { headers: { cookie } })
    assert.equal(download.status, 502)
    assert.deepEqual(await download.json(), { error: 'artifact_identity_mismatch' })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF times out a stalled artifact download', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    artifactDownloadIdleTimeoutMs: 20,
    artifactStore: {
      async getObject(_key, signal): Promise<{ body: Readable }> {
        return await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
    }
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
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, { headers: { cookie } })
    assert.equal(download.status, 504)
    assert.deepEqual(await download.json(), { error: 'artifact_download_timeout' })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF reports a Control Plane metadata timeout separately', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"run":')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret',
    controlPlaneRequestTimeoutMs: 20,
    artifactStore: {
      async getObject(): Promise<{ body: Readable }> {
        throw new Error('must not be called')
      }
    }
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
    assert(cookie)
    const download = await fetch(`${base}/api/runs/run-1/artifact`, { headers: { cookie } })
    assert.equal(download.status, 504)
    assert.deepEqual(await download.json(), { error: 'control_plane_timeout' })
  } finally {
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})
