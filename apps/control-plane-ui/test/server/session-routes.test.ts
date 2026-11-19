import { createServer } from 'node:http'
import { expect, test } from 'vitest'

import { createControlPlaneUiBffServer } from '../../server/create-bff.js'
import { loginCookie } from './support.js'

test('BFF rejects malformed login bodies without issuing a session or returning a server error', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  expect.assert(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    for (const body of [
      '{',
      'null',
      '[]',
      '123',
      '{}',
      '{"token":null}',
      '{"token":123}',
      '{"token":{}}',
      '{"token":["login-secret"]}',
      '{"token":"wrong"}'
    ]) {
      const login = await fetch(`${origin}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body
      })
      expect(login.status, body).toBe(401)
      expect(await login.json(), body).toStrictEqual({ error: 'unauthorized' })
      expect(login.headers.get('set-cookie'), body).toBe(null)
    }
    expect(await loginCookie(origin)).toContain('control_plane_ui_session=')
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})

test('BFF marks session cookies secure for HTTPS proxy deployments', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    secureCookies: true
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  expect.assert(address && typeof address === 'object')
  try {
    const origin = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{"token":"login-secret"}'
    })

    expect(login.headers.get('set-cookie') ?? '').toMatch(/; Secure(?:;|$)/)
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
  expect.assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    maximumSessions: 2
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  expect.assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const first = await loginCookie(base)
    const second = await loginCookie(base)
    const third = await loginCookie(base)

    expect((await fetch(`${base}/api/runs`, { headers: { cookie: first } })).status).toBe(401)
    for (const cookie of [second, third]) {
      expect((await fetch(`${base}/api/runs`, { headers: { cookie } })).status).toBe(200)
    }
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
  expect.assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  expect.assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{"token":"login-secret"}'
    })
    const cookie = login.headers.get('set-cookie')
    expect.assert(cookie !== null)
    expect((await fetch(`${base}/api/runs`, { headers: { cookie } })).status).toBe(200)

    // A browser attaches `Origin` to a non-GET request, even same-origin; sign-out is
    // refused without it (see the cross-site test below).
    const signOut = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: base }
    })
    expect(signOut.status).toBe(204)
    const cleared = signOut.headers.get('set-cookie')
    // Without Max-Age=0 the browser would keep the original cookie and stay signed in.
    expect.assert(cleared?.includes('Max-Age=0'))
    expect.assert(cleared?.includes('HttpOnly'))

    // The cleared value must not authenticate, even if a client replays it verbatim.
    const replayed = cleared ?? ''
    expect((await fetch(`${base}/api/runs`, { headers: { cookie: replayed } })).status).toBe(401)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

/**
 * Signing in is a state change: a cross-site POST could otherwise put the browser into a
 * session the reader never asked for. The refusal is the same one every mutating route
 * sends, so this asserts the shared code rather than a per-route message.
 */
test('BFF refuses a cross-site sign-in', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  expect.assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const crossSite = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example'
      },
      body: '{"token":"login-secret"}'
    })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toStrictEqual({
      error: 'cross_site_request'
    })
    // The refused request still must not mint a session.
    expect(crossSite.headers.get('set-cookie')).toBe(null)
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
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
  expect.assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    // A different origin, and the shape an attacker can actually produce.
    const crossSite = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example' }
    })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toStrictEqual({
      error: 'cross_site_request'
    })
    // No cookie is cleared on the rejected path: an attacker cannot even produce the
    // side effect they were after.
    expect(crossSite.headers.get('set-cookie')).toBe(null)

    // A request that carries neither `Origin` nor `Referer` is also refused, since an
    // attacker can omit both.
    expect((await fetch(`${base}/api/session`, { method: 'DELETE' })).status).toBe(403)

    // `Referer` alone is enough, so a same-origin caller that could not set `Origin`
    // still signs out.
    const viaReferer = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { referer: `${base}/runs` }
    })
    expect(viaReferer.status).toBe(204)
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})
