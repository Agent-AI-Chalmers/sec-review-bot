import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { Plugin } from 'vite'

import { devFixtures } from '../dev-fixtures.js'

/**
 * The fixture plugin registers one connect-style middleware. Capturing it lets a real
 * http server drive it, so the test exercises the same request/response objects the
 * plugin sees in `vite` instead of hand-rolled fakes.
 */
function captureMiddleware(): (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void {
  const plugin: Plugin = devFixtures()
  const configureServer = plugin.configureServer
  assert(typeof configureServer === 'function')
  let middleware:
    | ((
        request: IncomingMessage,
        response: ServerResponse,
        next: () => void
      ) => void)
    | undefined
  const fakeServer = {
    middlewares: {
      use(
        handler: (
          request: IncomingMessage,
          response: ServerResponse,
          next: () => void
        ) => void
      ): void {
        middleware = handler
      }
    }
  }
  // `devFixtures` never reads `this`, so invoking the hook with the fake server alone is
  // faithful; the cast only satisfies Vite's `this: MinimalPluginContext` signature.
  const runConfigureServer = configureServer as (
    server: typeof fakeServer
  ) => void
  runConfigureServer(fakeServer)
  assert(middleware !== undefined)
  return middleware
}

/** Starts the fixture middleware behind a real server and returns a close helper. */
async function startFixtureServer(): Promise<{
  base: string
  close: () => Promise<void>
}> {
  const middleware = captureMiddleware()
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('dev fixtures only describe reachable run states', async () => {
  // dev-fixtures.ts validates every generated run at import time and throws on a
  // combination the Control Plane cannot produce (for example a failed execution
  // whose publication is still `pending`). Importing it is therefore the assertion:
  // this test exists so an unreachable fixture fails CI instead of silently
  // showing operators a state that cannot happen.
  await assert.doesNotReject(() => import('../dev-fixtures.js'))
})

test('dev fixtures track sign-out so the console reaches the sign-in form', async () => {
  // The fixtures exist to show the console's real screens with no access token, so
  // they start signed in — a run list must be reachable before any session call.
  const fixture = await startFixtureServer()
  try {
    const signedIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(signedIn.status, 200)

    // Signing out mirrors the BFF: 204, and every later API call is unauthorized so
    // the console switches to its sign-in form rather than reloading the run list.
    const signOut = await fetch(`${fixture.base}/api/session`, {
      method: 'DELETE'
    })
    assert.strictEqual(signOut.status, 204)

    const afterSignOut = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(afterSignOut.status, 401)
    assert.deepStrictEqual(await afterSignOut.json(), { error: 'unauthorized' })

    // Signing back in restores the run list: POST is the only way to become signed in.
    const signIn = await fetch(`${fixture.base}/api/session`, {
      method: 'POST'
    })
    assert.strictEqual(signIn.status, 204)

    const afterSignIn = await fetch(`${fixture.base}/api/runs?limit=1`)
    assert.strictEqual(afterSignIn.status, 200)
  } finally {
    await fixture.close()
  }
})

test('dev fixtures leave non-API requests to the next middleware', async () => {
  // The middleware must not claim routes outside `/api/`; the fixture server's `next`
  // handler answers 404, which stands in for Vite's own asset middleware.
  const fixture = await startFixtureServer()
  try {
    const asset = await fetch(`${fixture.base}/index.html`)
    assert.strictEqual(asset.status, 404)
  } finally {
    await fixture.close()
  }
})
