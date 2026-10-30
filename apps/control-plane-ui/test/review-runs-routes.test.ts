import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'
import { loginCookie } from './server-support.js'

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
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
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
      headers: { 'content-type': 'application/json', origin: base },
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
    // The BFF forwards only the parameters Review Runs declares: UI state (`range`) and
    // anything else the browser adds (UTM, typos) are dropped rather than passed upstream.
    await fetch(`${base}/api/runs?range=1h&utm_source=twitter&limit=10`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs?limit=10')
    await fetch(
      `${base}/api/runs?workflow=issue-review&source_platform=github&range=7d&cursor=abc`,
      { headers: { cookie } }
    )
    assert.strictEqual(
      upstreamPath,
      '/v1/runs?cursor=abc&source_platform=github&workflow=issue-review'
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
    // today (Review Runs answers 400), but it would forward any future path shape upstream,
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
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef/../..%2Fparked',
      '/api/runs/..%2F..%2Fparked',
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
      'a rejected path must never reach the upstream Review Runs'
    )
    // The blocked-preparation queue is a fixed sub-resource of the run collection, not a run id,
    // so it must pass the allow-list before the UUID check rejects it.
    await fetch(`${base}/api/runs/parked`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs/parked')

    // The one write the console may proxy. The admin credential is supplied by the operator for
    // this request and forwarded as-is; the BFF holds no copy of its own.
    const abandonUrl = `${base}/api/admin/runs/${runUuid}/abandon`
    // Same origin but no operator credential: the request is well formed, it just cannot act.
    const noToken = await fetch(abandonUrl, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(noToken.status, 401)
    const crossSite = await fetch(abandonUrl, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-review-runs-admin-token': 'admin-value'
      },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(
      crossSite.status,
      403,
      'a cross-site POST must not carry the session into an abandonment'
    )
    authorization = ''
    const abandon = await fetch(abandonUrl, {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'content-type': 'application/json',
        'x-review-runs-admin-token': 'admin-value'
      },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(abandon.status, 200)
    assert.strictEqual(upstreamPath, `/v1/admin/runs/${runUuid}/abandon`)
    assert.strictEqual(
      authorization,
      'Bearer admin-value',
      'the operator credential, not the read token, must authorise the abandonment'
    )
    const oversizedLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ token: 'x'.repeat(1024 * 1024) })
    })
    assert.strictEqual(oversizedLogin.status, 413)
    const unicodeLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { origin: base },
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

test('BFF rejects an upstream JSON body whose declared size exceeds its budget', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '5'
    })
    response.end('12345')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    upstreamJsonMaxBytes: 4
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'upstream_response_too_large'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF stops buffering a chunked upstream JSON body at its budget', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('1234')
    response.end('5')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    upstreamJsonMaxBytes: 4
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'upstream_response_too_large'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF returns a gateway error when Review Runs is unavailable', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert.strictEqual(login.status, 204)
    assert(cookie)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(query.status, 502)
    assert.deepStrictEqual(await query.json(), {
      error: 'review_runs_unavailable'
    })
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})

test('BFF does not echo an upstream content-type it would serve as script', async () => {
  // The upstream `content-type` could be `text/html` if Review Runs were compromised or
  // misconfigured. Echoing it from the console's own origin would let a browser run the body as
  // script; the BFF must answer with a fixed JSON type instead, regardless of what it is sent.
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<script>alert(1)</script>')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{"token":"login-secret"}'
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie !== null)
    const proxied = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(proxied.status, 200)
    assert.strictEqual(
      proxied.headers.get('content-type'),
      'application/json; charset=utf-8',
      'the upstream text/html must not be echoed'
    )
    assert.strictEqual(
      proxied.headers.get('x-content-type-options'),
      'nosniff',
      'nosniff is still set so the body cannot be reinterpreted'
    )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})
