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
  // combination Review Runs cannot produce (for example a failed execution
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

test('dev fixtures page the run list in the order their cursor describes', async () => {
  // The run list is built in scenario order, and an active run's timestamp is anchored near
  // now rather than at its newest historical slot, so array order is not creation order. The
  // fixture has to sort by the same `(created_at, run_id)` key its cursor compares against,
  // or `created_at < cursor.createdAt` matches every row and page two repeats page one - the
  // paging affordance then silently disappears wherever the fixture is the only server.
  const fixture = await startFixtureServer()
  try {
    const first = await (
      await fetch(`${fixture.base}/api/runs?limit=50`)
    ).json()
    const stamps = first.runs.map(
      (run: { created_at: string }) => run.created_at
    )
    assert.deepStrictEqual(
      stamps,
      [...stamps].sort().reverse(),
      'the list is newest-first, which is what the cursor walks'
    )
    assert.ok(
      first.next_cursor,
      'sixty-two fixtures must not fit one page of fifty'
    )

    const second = await (
      await fetch(
        `${fixture.base}/api/runs?limit=50&cursor=${first.next_cursor}`
      )
    ).json()
    const firstIds = new Set(
      first.runs.map((run: { run_id: string }) => run.run_id)
    )
    assert.ok(second.runs.length > 0, 'the cursor must return a second page')
    for (const run of second.runs as { run_id: string }[]) {
      assert.ok(
        !firstIds.has(run.run_id),
        `${run.run_id} appears on both pages`
      )
    }
  } finally {
    await fixture.close()
  }
})

test('the unfiltered list does not lead with a row that satisfies a filter lookup', async () => {
  // The browser smoke test opens "the first row" after selecting a filter, and waits for that
  // row to look filtered. When the newest run already looks like the filter's result before
  // the filtered response arrives, the wait passes against the stale list and the test opens
  // a run the filter excluded - which is how a run with no publication start reached an
  // assertion about a published phase.
  //
  // The smoke test now checks two columns instead of one, but the fixtures must not depend on
  // that: the newest run stays outside the (workflow, publication) combination the smoke test
  // filters for, so a one-column wait cannot pass early again.
  const fixture = await startFixtureServer()
  try {
    const unfiltered = await (
      await fetch(`${fixture.base}/api/runs?limit=1`)
    ).json()
    const newest = unfiltered.runs[0]
    assert.ok(newest, 'the fixtures must serve at least one run')
    assert.ok(
      !(
        newest.workflow === 'repository-review' &&
        newest.publication.status === 'published'
      ),
      'the newest run must not already look like the published repository filter'
    )
  } finally {
    await fixture.close()
  }
})
