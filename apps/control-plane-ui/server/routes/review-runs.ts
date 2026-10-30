import type { IncomingMessage, ServerResponse } from 'node:http'

import { LIST_RUN_QUERY_PARAMS } from '../../shared/list-run-query-params.js'
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody,
  sendJson
} from '../http.js'
import { requireSameOrigin } from '../request-security.js'
import { sendUpstreamFailure, writeUpstreamResult } from '../upstream/relay.js'
import type { ReviewRunsClient } from '../upstream/review-runs-client.js'

/** The UUID a Review Runs run id is (see the contract's `runId` path parameter). */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The operator writes the console may proxy: `/api/admin/runs/<uuid>/<action>`.
 *
 * The admin credential is supplied by the operator for that one request and forwarded as-is; the
 * BFF never reads or stores it. Keeping it out of the server means a compromised BFF cannot
 * abandon or resume runs, and Review Runs decides who is allowed to.
 */
const ADMIN_DECISION = new RegExp(
  `^/api/admin/runs/(${RUN_ID.source.slice(1, -1)})/(abandon|resume|give-up)$`
)

/**
 * The upstream path a read proxy should request: the BFF path minus its `/api` prefix,
 * with the query reduced to the parameters Review Runs declares (generated from
 * `openapi.yaml`). Anything else the browser put in the URL (UI state such as `range`,
 * analytics parameters, typos) is dropped rather than forwarded, so this proxy cannot send
 * a request outside Review Runs's contract.
 */
function forwardedPath(bffUrl: string): string {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  const forwarded = new URLSearchParams()
  for (const name of LIST_RUN_QUERY_PARAMS) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') forwarded.set(name, value)
  }
  const query = forwarded.toString()
  return `${url.pathname.slice('/api'.length)}${query === '' ? '' : `?${query}`}`
}

/** Whether this BFF path is one of the reads the console may proxy upstream.
 *
 * The run-id segment is matched against the contract's UUID shape after percent-decoding, not
 * with a catch-all. A catch-all would still be safe today - Review Runs rejects a malformed id
 * with a 400 - but it widens the reachable surface to whatever path a future upstream read
 * endpoint might parse, so the allow-list states the exact shape it means.
 */
function isAllowedReadPath(bffUrl: string): boolean {
  const url = new URL(bffUrl, 'http://control-plane-ui.local')
  if (url.pathname === '/api/runs') return true
  // A fixed sub-resource of the run collection, not a run id: it lists the runs coordination
  // has stopped retrying, so the console can show the operator queue without any write access.
  if (url.pathname === '/api/runs/parked') return true
  const segments = url.pathname.split('/')
  // ['', 'api', 'runs', '<runId>', ...optional suffix]
  if (segments.length < 4 || segments[1] !== 'api' || segments[2] !== 'runs')
    return false
  let runId: string
  try {
    runId = decodeURIComponent(segments[3] ?? '')
  } catch {
    // A malformed escape (`%zz`) is not a path this BFF proxies.
    return false
  }
  if (!RUN_ID.test(runId)) return false
  if (segments.length === 4) return true
  if (segments.length !== 5) return false
  return segments[4] === 'publication-steps' || segments[4] === 'events'
}

export interface ReviewRunsRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

/** Own the Review Runs read proxy and the operator decision writes. */
export function createReviewRunsRoutes({
  reviewRuns
}: {
  reviewRuns: ReviewRunsClient
}): ReviewRunsRoutes {
  const decide = async (
    request: IncomingMessage,
    response: ServerResponse,
    decision: RegExpExecArray
  ): Promise<void> => {
    // A session cookie alone must not authorise a cross-site POST: the same check the
    // sign-out route uses.
    if (!requireSameOrigin(request, response)) return
    const adminToken = request.headers['x-review-runs-admin-token']
    if (typeof adminToken !== 'string' || adminToken.trim() === '') {
      // 401 rather than 400: the request is well-formed, it just carries no operator
      // credential. The console turns this into its admin-token prompt.
      sendJson(response, 401, { error: 'admin_token_required' })
      return
    }
    let body: Buffer
    try {
      body = await readBoundedRequestBody(request)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: 'request_too_large' })
        return
      }
      throw error
    }
    try {
      // The action is taken from the matched route, never from the raw URL, so the
      // upstream path can only be one of the decisions this BFF states it proxies.
      const action =
        decision[2] === 'resume'
          ? 'resume'
          : decision[2] === 'give-up'
            ? 'give-up'
            : 'abandon'
      const upstream = await reviewRuns.decide(
        decodeURIComponent(decision[1] ?? ''),
        action,
        adminToken,
        body
      )
      writeUpstreamResult(response, upstream)
    } catch (error) {
      sendUpstreamFailure(response, 'review_runs', error)
    }
  }

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (request.method === 'POST') {
      const decision = ADMIN_DECISION.exec(request.url ?? '')
      if (decision !== null) {
        await decide(request, response, decision)
        return true
      }
    }
    if (request.method !== 'GET' || !isAllowedReadPath(request.url ?? ''))
      return false
    try {
      const upstream = await reviewRuns.read(forwardedPath(request.url ?? '/'))
      writeUpstreamResult(response, upstream)
    } catch (error) {
      sendUpstreamFailure(response, 'review_runs', error)
    }
    return true
  }

  return { handle }
}
