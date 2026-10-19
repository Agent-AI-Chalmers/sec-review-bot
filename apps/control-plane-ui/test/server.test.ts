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
    assert.strictEqual((await fetch(`${base}/api/runs`)).status, 401)
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    assert.strictEqual(login.status, 204)
    const cookie = login.headers.get('set-cookie')
    assert(cookie?.includes('HttpOnly'))
    assert(cookie !== null)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(query.status, 200)
    assert.strictEqual(authorization, 'Bearer read-secret')
    assert.strictEqual(upstreamPath, '/v1/runs')
    // The BFF forwards only the parameters Control Plane declares: UI state (`range`) and
    // anything else the browser adds (UTM, typos) are dropped rather than passed upstream.
    await fetch(`${base}/api/runs?range=1h&utm_source=twitter&limit=10`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs?limit=10')
    await fetch(`${base}/api/runs?workflow=issue-review&range=7d&cursor=abc`, {
      headers: { cookie }
    })
    assert.strictEqual(
      upstreamPath,
      '/v1/runs?cursor=abc&workflow=issue-review'
    )
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { method: 'POST', headers: { cookie } }))
        .status,
      404
    )
    assert.strictEqual(
      (await fetch(`${base}/api/store`, { headers: { cookie } })).status,
      404
    )
    // The run-id segment must be the contract's UUID shape. A catch-all would still be safe
    // today (Control Plane answers 400), but it would forward any future path shape upstream,
    // so the allow-list rejects a non-UUID id here instead of relaying it.
    const runUuid = '0123abcd-4567-89ef-0123-456789abcdef'
    await fetch(`${base}/api/runs/${runUuid}/events`, { headers: { cookie } })
    assert.strictEqual(upstreamPath, `/v1/runs/${runUuid}/events`)
    upstreamPath = ''
    // The allow-list matches the contract's run-id shape after percent-decoding. It is
    // deliberately shape-only, exactly like the contract's own `runId` pattern: rejecting a
    // version/variant nibble here would make the BFF stricter than the contract it proxies.
    // What it must never do is let a crafted segment reach a different upstream path, which is
    // what the traversal and encoding cases below pin.
    for (const rejected of [
      '/api/runs/not-a-uuid',
      '/api/runs/not-a-uuid/events',
      '/api/runs/%2e%2e/publication-steps',
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef/unknown-suffix',
      // Traversal hidden in the id segment: rejected before normalisation can reshape the path.
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef/../..%2Fblocked-preparations',
      '/api/runs/..%2F..%2Fblocked-preparations',
      // A valid id with an encoded separator glued to it is not a sub-resource.
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef%2Fevents'
    ]) {
      assert.strictEqual(
        (await fetch(`${base}${rejected}`, { headers: { cookie } })).status,
        404,
        `${rejected} must not be proxied upstream`
      )
    }
    assert.strictEqual(
      upstreamPath,
      '',
      'a rejected path must never reach the upstream Control Plane'
    )
    // The blocked-preparation queue is a fixed sub-resource of the run collection, not a run id,
    // so it must pass the allow-list before the UUID check rejects it.
    await fetch(`${base}/api/runs/blocked-preparations`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs/blocked-preparations')
    const oversizedLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(1024 * 1024) })
    })
    assert.strictEqual(oversizedLogin.status, 413)
    const unicodeLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: '\u00e9'.repeat('login-secret'.length) })
    })
    assert.strictEqual(unicodeLogin.status, 401)
    assert.strictEqual((await fetch(`${base}/healthz`)).status, 200)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

/**
 * Sign-out has to expire the session cookie server-side: it is HttpOnly, so the console
 * cannot clear it from script. The regression this prevents is a console that appears to
 * sign out while the cookie keeps working, which silently leaves the reader authenticated.
 */
test('BFF sign-out expires the session cookie it issued', async () => {
  const upstream = createServer((_request, response) => {
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
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie !== null)
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie } })).status,
      200
    )

    // A browser attaches `Origin` to a non-GET request, even same-origin; sign-out is
    // refused without it (see the cross-site test below).
    const signOut = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: base }
    })
    assert.strictEqual(signOut.status, 204)
    const cleared = signOut.headers.get('set-cookie')
    // Without Max-Age=0 the browser would keep the original cookie and stay signed in.
    assert(cleared?.includes('Max-Age=0'))
    assert(cleared?.includes('HttpOnly'))

    // The cleared value must not authenticate, even if a client replays it verbatim.
    const replayed = cleared ?? ''
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie: replayed } }))
        .status,
      401
    )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

/**
 * Another site must not be able to sign the reader out. The cookie is `SameSite=Strict`,
 * so a cross-site request will not carry it, but sign-out clears the cookie regardless —
 * a cross-site DELETE would still be obeyed without this check. The regression this
 * prevents is a request the browser would never have sent carrying a session.
 */
test('BFF refuses a cross-site sign-out', async () => {
  const ui = createControlPlaneUiServer({
    controlPlaneUrl: 'http://127.0.0.1:1',
    controlPlaneToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    // A different origin, and the shape an attacker can actually produce.
    const crossSite = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example' }
    })
    assert.strictEqual(crossSite.status, 403)
    assert.deepStrictEqual(await crossSite.json(), { error: 'cross_origin' })
    // No cookie is cleared on the rejected path: an attacker cannot even produce the
    // side effect they were after.
    assert.strictEqual(crossSite.headers.get('set-cookie'), null)

    // A request that carries neither `Origin` nor `Referer` is also refused, since an
    // attacker can omit both.
    assert.strictEqual(
      (await fetch(`${base}/api/session`, { method: 'DELETE' })).status,
      403
    )

    // `Referer` alone is enough, so a same-origin caller that could not set `Origin`
    // still signs out.
    const viaReferer = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { referer: `${base}/runs` }
    })
    assert.strictEqual(viaReferer.status, 204)
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
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
    assert.strictEqual(login.status, 204)
    assert(cookie)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(query.status, 502)
    assert.deepStrictEqual(await query.json(), {
      error: 'control_plane_unavailable'
    })
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
              media_type: 'application/tar+zstd',
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
    assert.strictEqual(
      (await fetch(`${base}/api/runs/${runId}/artifact`)).status,
      401
    )
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 200)
    assert.strictEqual(await download.text(), 'artifact')
    assert.strictEqual(
      requestedKey,
      `runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
    )
    assert.strictEqual(
      download.headers.get('content-type'),
      'application/octet-stream'
    )
    assert.strictEqual(
      download.headers.get('content-disposition'),
      'attachment; filename="diagnostic-tree.v1.tar.zst"'
    )
    assert.strictEqual(
      download.headers.get('cache-control'),
      'private, no-store'
    )
    assert.strictEqual(
      download.headers.get('x-content-type-options'),
      'nosniff'
    )
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
              media_type: 'application/tar+zstd',
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
    const download = await fetch(`${base}/api/runs/run-1/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 409)
    assert.strictEqual(storageCalled, false)
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
              media_type: 'application/tar+zstd',
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
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 502)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_identity_mismatch'
    })
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
              media_type: 'application/tar+zstd',
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
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 502)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_identity_mismatch'
    })
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
              media_type: 'application/tar+zstd',
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
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
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
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 504)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_download_timeout'
    })
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
    const download = await fetch(`${base}/api/runs/run-1/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 504)
    assert.deepStrictEqual(await download.json(), {
      error: 'control_plane_timeout'
    })
  } finally {
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})
