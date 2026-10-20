// A real GitHub App for tests.
//
// The App is the SDK's own class, so `app.octokit` is a real client and the installation lookup
// behaves as it does in production. Only the transport is replaced: `respond` receives the
// request and returns the HTTP response, exactly like a real GitHub call would. A test therefore
// never hands production code a hand-made object, and never casts one into the App type.
import { App, Octokit } from 'octokit'
import crypto from 'node:crypto'

import { githubJson, testFetch, type RecordedRequest } from './github-client.js'

/** A throwaway key, generated once per process: the App constructor requires one, but these
 * tests only exercise the unauthenticated `apps.getRepoInstallation` lookup, which never signs. */
const TEST_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
}).privateKey

export interface FakeApp {
  app: App
  /** Every request that reached the transport, in order. */
  requests: RecordedRequest[]
}

export interface FakeAppOptions {
  /**
   * What the installation lookup returns. Defaults to a 404, so a test that does not expect any
   * installation has nothing to stub and a stray lookup shows up as a failed request rather than
   * succeeding silently.
   */
  respond?: (request: RecordedRequest) => Response | Promise<Response>
  /**
   * The client `getInstallationOctokit` hands back. When omitted, requesting one throws, so a
   * test that never installs a client cannot accidentally use one.
   */
  installationOctokit?: Octokit
}

/**
 * A real `App` whose transport answers `respond`.
 *
 * `getRepoInstallation` is the only endpoint these tests reach through the App itself; every
 * other GitHub call is made with an injected client. `respond` can therefore answer just that
 * lookup, which keeps each test's setup small without faking the App.
 */
export function fakeApp({
  respond = () => githubJson({ message: 'Not Found' }, 404),
  installationOctokit
}: FakeAppOptions = {}): FakeApp {
  const requests: RecordedRequest[] = []
  const FakeOctokit = Octokit.defaults({
    throttle: { enabled: false },
    retry: { enabled: false },
    request: {
      fetch: testFetch(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        const rawBody = init?.body
        const body =
          typeof rawBody === 'string' && rawBody !== ''
            ? (JSON.parse(rawBody) as unknown)
            : undefined
        const request: RecordedRequest = { method, url, body }
        requests.push(request)
        return await respond(request)
      })
    }
  })
  const app = new App({
    appId: 1,
    privateKey: TEST_PRIVATE_KEY,
    webhooks: { secret: 'test-webhook-secret' },
    Octokit: FakeOctokit
  })
  if (installationOctokit !== undefined) {
    // Replace the method so the test controls the client. Note what this does NOT cover: the real
    // method mints an installation token and builds a client from it, and that exchange is never
    // exercised here (it needs a real private key and a live installation). The wiring that feeds
    // it - the installation id from `getRepoInstallation` - is covered directly in
    // `test/github/installation-client.test.ts`.
    app.getInstallationOctokit = (async () =>
      installationOctokit) as typeof app.getInstallationOctokit
  }
  return { app, requests }
}
