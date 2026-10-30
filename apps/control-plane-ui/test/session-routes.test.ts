import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'
import { loginCookie } from './server-support.js'

test('BFF marks session cookies secure for HTTPS proxy deployments', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    secureCookies: true
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const login = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })

    assert.match(login.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/)
  } finally {
    await new Promise<void>((resolve, reject) =>
      ui.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('BFF bounds browser sessions by evicting the oldest login', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"runs":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    maximumSessions: 2
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const first = await loginCookie(base)
    const second = await loginCookie(base)
    const third = await loginCookie(base)

    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie: first } })).status,
      401
    )
    for (const cookie of [second, third])
      assert.strictEqual(
        (await fetch(`${base}/api/runs`, { headers: { cookie } })).status,
        200
      )
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
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
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
