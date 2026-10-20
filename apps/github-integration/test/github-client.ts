// The one way this suite builds a GitHub client.
//
// Every test gets a REAL `Octokit` and replaces only its transport with a fake `fetch`. That is
// the SDK's own documented testing approach (`@octokit/request` README: "Simple to test: mock
// requests by passing a custom fetch method"). Because the client itself is real, request
// building, error mapping and response parsing all run for real, and no test has to cast a
// hand-made object into the client type.
//
// A test that does not expect GitHub to be called still gets a real client; reaching the network
// is impossible, because the default transport throws a message naming the offending test.
import { Octokit } from 'octokit'

type OctokitOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>
type FetchOption = NonNullable<NonNullable<OctokitOptions['request']>['fetch']>

/**
 * Adapt a simple `(input, init) => Response` handler to the SDK's `request.fetch` type.
 *
 * The SDK types `fetch` as the DOM `fetch`, which a test double cannot implement in full. Rather
 * than asserting through `any`/`never`, this narrows the difference in one typed place: the
 * adapter matches the full signature and delegates to the handler.
 */
export function testFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Promise<Response>
): FetchOption {
  return ((input: Parameters<FetchOption>[0], init?: RequestInit) =>
    handler(
      typeof input === 'string' || input instanceof URL
        ? input
        : (input as Request),
      init
    )) as FetchOption
}

/** A request as the fake transport sees it. */
export interface RecordedRequest {
  method: string
  url: string
  body: unknown
}

export interface FakeGitHub {
  /** The client to hand to production code. */
  octokit: Octokit
  /** Every request that reached the transport, in order. */
  requests: RecordedRequest[]
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>

/**
 * A real client whose transport is `respond`.
 *
 * `respond` receives the method, the full URL and the parsed JSON body, and returns a `Response`.
 * Use `githubJson` / `githubFile` for the common replies, or build a `Response` directly for an
 * error status.
 */
export function fakeGitHub(respond: Handler): FakeGitHub {
  const requests: RecordedRequest[] = []
  const octokit = new Octokit({
    auth: 'test-token',
    // Throttling is a production concern: it keeps this app inside GitHub's rate limit by
    // delaying mutating requests, and its counters are process-global, so a suite that builds a
    // client per test would otherwise spend seconds sleeping between tests. The rate-limit
    // headers below are still sent, so response parsing stays faithful; only the sleeping is off.
    // Documented opt-out: `new Octokit({ throttle: { enabled: false } })` in the octokit README.
    throttle: { enabled: false },
    // Retry is likewise a production resilience feature. Left on, a test that returns a 5xx to
    // exercise error handling would sit through the plugin's exponential backoff (seconds per
    // test) and then still see the same status. Turning it off keeps the error path observable
    // without the waiting; retry behaviour itself is not what these tests assert.
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
  return { octokit, requests }
}

/** A real client that must not be called. Any call fails with a message that names the mistake. */
export function unusedGitHub(): FakeGitHub {
  return fakeGitHub(() => {
    throw new Error(
      'This test passed a GitHub client that the code under test then called. Stub that call, or use fakeGitHub().'
    )
  })
}

/** A JSON reply, which is what every GitHub REST endpoint returns. */
export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** A `file` entry as `repos.getContent` returns it. */
export function githubFile(
  content: string,
  path = '.sec-review/config.yml'
): Response {
  return githubJson({
    type: 'file',
    path,
    encoding: 'base64',
    content: Buffer.from(content, 'utf-8').toString('base64')
  })
}
