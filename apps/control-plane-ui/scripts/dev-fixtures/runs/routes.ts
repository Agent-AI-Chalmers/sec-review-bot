import type { IncomingMessage, ServerResponse } from 'node:http'

import artifactContent from '../data/artifact-content.json' with { type: 'json' }
import {
  DECLARED_QUERY_PARAMS,
  DEV_PAGE_SIZE,
  decodeCursor,
  eventsFor,
  parkedIndexes,
  runs,
  stepsByRun,
  type FixtureRun
} from './generate.js'

export function createRunsHandler(): (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void> {
  // Runs the operator abandoned while this dev server has been running. Remembering them is
  // what makes the abandon button actually work locally: the queue shrinks and the detail
  // page stops offering the decision, instead of the button being permanently inert.
  const abandoned = new Set<string>()
  // Runs the operator handed back to automatic recovery. The resume button has to do
  // something locally too, or the console teaches a decision that visibly fails: the real
  // endpoint moves the row to `uncertain` with a fresh budget, so the detail page must stop
  // reporting `disconnected` and the run must leave the operator queue.
  const resumed = new Set<string>()
  // The runs the mutation above parked, read from their own axes rather than from the index
  // set that produced them. Deriving from state is what lets all three axes appear in the
  // queue: a run parked on execution or publication is as invisible to an operator as one
  // parked on preparation if the list is built from a preparation-only source.
  const parkedAxis = (
    run: FixtureRun
  ): 'preparation' | 'execution' | 'publication' | null =>
    run.preparation.status === 'disconnected'
      ? 'preparation'
      : run.execution.status === 'disconnected'
        ? 'execution'
        : run.publication.status === 'disconnected'
          ? 'publication'
          : null
  const blockedRuns = (): Array<{
    run_id: string
    axis: 'preparation' | 'execution' | 'publication'
    reason:
      | 'EXECUTION_ALREADY_ADVANCED'
      | 'SUBMISSION_RECOVERY_EXHAUSTED'
      | 'PUBLICATION_RECONCILIATION_EXHAUSTED'
  }> =>
    runs.flatMap((run, index) => {
      // Only the runs this fixture deliberately parked are queued. A run whose state
      // merely happens to be `disconnected` (the lifecycle scenarios, repeated across the
      // page) is not an operator backlog: listing all of them turned four sample states into
      // thirteen queue entries. The parked ones are what an operator is actually shown.
      if (!parkedIndexes.has(index)) return []
      const axis = parkedAxis(run)
      if (axis === null) return []
      if (abandoned.has(run.run_id) || resumed.has(run.run_id)) return []
      return [
        {
          run_id: run.run_id,
          axis,
          reason:
            axis === 'preparation'
              ? ('EXECUTION_ALREADY_ADVANCED' as const)
              : axis === 'execution'
                ? ('SUBMISSION_RECOVERY_EXHAUSTED' as const)
                : ('PUBLICATION_RECONCILIATION_EXHAUSTED' as const)
        }
      ]
    })
  const blockedRunIds = (): string[] =>
    blockedRuns().map((block) => block.run_id)
  return async (request, response): Promise<void> => {
    const requestUrl = request.url
    if (requestUrl === undefined) return
    if (requestUrl.startsWith('/api/runs?')) {
      const url = new URL(requestUrl, 'http://fixture.local')
      const unknown = [...url.searchParams.keys()].filter(
        (name) => !DECLARED_QUERY_PARAMS.has(name)
      )
      if (unknown.length > 0) {
        response.statusCode = 400
        response.end(
          JSON.stringify({
            error: 'unexpected query parameter',
            code: 'INVALID_QUERY'
          })
        )
        return
      }
      const limit = Number(url.searchParams.get('limit') ?? DEV_PAGE_SIZE)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        response.statusCode = 400
        response.end(
          JSON.stringify({
            error: 'limit is invalid.',
            code: 'INVALID_QUERY'
          })
        )
        return
      }
      const cursorValue = url.searchParams.get('cursor')
      const cursor = decodeCursor(cursorValue)
      if (cursorValue !== null && cursor === null) {
        response.statusCode = 400
        response.end(
          JSON.stringify({
            error: 'cursor is invalid.',
            code: 'INVALID_QUERY'
          })
        )
        return
      }
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const executionStatus = url.searchParams.get('execution_status')
      const publicationStatus = url.searchParams.get('publication_status')
      const preparationStatus = url.searchParams.get('preparation_status')
      const workflow = url.searchParams.get('workflow')
      const filtered = runs.filter(
        (run) =>
          (executionStatus === null ||
            run.execution.status === executionStatus) &&
          (publicationStatus === null ||
            run.publication.status === publicationStatus) &&
          // Fixtures always carry a preparation summary (see `validateRun`), matching the
          // store, which never returns a run without one.
          (preparationStatus === null ||
            run.preparation?.status === preparationStatus) &&
          (from === null || run.created_at >= from) &&
          (to === null || run.created_at < to) &&
          (workflow === null || run.workflow === workflow) &&
          // Matches the store's `(created_at, run_id) < (cursor)` page walk.
          (cursor === null ||
            run.created_at < cursor.createdAt ||
            (run.created_at === cursor.createdAt && run.run_id < cursor.runId))
      )
      // The store walks pages by `(created_at, run_id)` descending, and the cursor below is
      // that same ordering; the fixture must apply it before slicing, or the cursor compares
      // against rows that were never ahead of it. The run list is built in scenario order,
      // and an active run's timestamp is anchored near now rather than at its newest
      // historical slot, so array order is not creation order. Without this sort the
      // predicate `created_at < cursor.createdAt` matched everything and every page repeated
      // the first one.
      const ordered = [...filtered].sort((left, right) =>
        left.created_at === right.created_at
          ? right.run_id.localeCompare(left.run_id)
          : right.created_at.localeCompare(left.created_at)
      )
      const page = ordered.slice(0, limit)
      const last = page.at(-1)
      const nextCursor =
        last === undefined || page.length < limit
          ? null
          : Buffer.from(`${last.created_at}|${last.run_id}`).toString(
              'base64url'
            )
      response.end(JSON.stringify({ runs: page, next_cursor: nextCursor }))
      return
    }
    const runArtifactContentMatch =
      /^\/api\/runs\/([^/?]+)\/artifact\/content$/.exec(requestUrl)
    if (request.method === 'GET' && runArtifactContentMatch !== null) {
      const runId = decodeURIComponent(runArtifactContentMatch[1] ?? '')
      const run = runs.find((item) => item.run_id === runId)
      if (run?.artifact_storage?.status !== 'available') {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'artifact_unavailable' }))
        return
      }
      response.end(
        JSON.stringify({
          ...artifactContent,
          files: {
            ...artifactContent.files,
            'manifest.json': artifactContent.files['manifest.json'].replace(
              '__RUN_ID__',
              runId
            )
          }
        })
      )
      return
    }
    // Before the run-detail match below, which would otherwise read this fixed segment as a
    // run id. Mirrors `GET /v1/runs/parked`.
    const abandonMatch = /^\/api\/admin\/runs\/([^/?]+)\/abandon$/.exec(
      requestUrl
    )
    // Mirrors `POST /v1/admin/runs/{runId}/resume`: the same eligibility (a run in the
    // queue), the same credential, and the same transition to `uncertain`.
    const resumeMatch = /^\/api\/admin\/runs\/([^/?]+)\/resume$/.exec(
      requestUrl
    )
    if (request.method === 'POST' && resumeMatch !== null) {
      if (request.headers['x-review-runs-admin-token'] === undefined) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'admin_token_required' }))
        return
      }
      const runId = decodeURIComponent(resumeMatch[1] ?? '')
      if (
        !blockedRunIds().includes(runId) ||
        abandoned.has(runId) ||
        resumed.has(runId)
      ) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'not_disconnected' }))
        return
      }
      const run = runs.find((item) => item.run_id === runId)
      if (run === undefined) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      // The same transition Review Runs performs: preparation returns to `uncertain`
      // with a fresh attempt budget, and the reason that parked it is cleared. The axes are
      // left as they are, because resuming asserts nothing about them.
      run.preparation.status = 'uncertain'
      run.preparation.disconnect_reason = null
      run.preparation.attempt_count = 0
      run.preparation.failure_code = null
      run.preparation.updated_at = new Date().toISOString()
      resumed.add(runId)
      response.end(JSON.stringify({ run }))
      return
    }
    if (request.method === 'POST' && abandonMatch !== null) {
      // Mirrors the real endpoint's contract closely enough for local use: an operator token
      // is required, the run must be in the queue, and success removes it from the queue.
      if (request.headers['x-review-runs-admin-token'] === undefined) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'admin_token_required' }))
        return
      }
      const runId = decodeURIComponent(abandonMatch[1] ?? '')
      if (!blockedRunIds().includes(runId)) {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'not_blocked' }))
        return
      }
      const run = runs.find((item) => item.run_id === runId)
      if (run === undefined) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      // The same transition Review Runs performs: conclude the axes that were still
      // open, keep the execution result, and record why. Clearing only the marker would show
      // the operator a run that looks untouched after an irreversible decision.
      const now = new Date().toISOString()
      run.preparation.status = 'failed'
      run.preparation.failure_code = 'PREPARATION_ABANDONED'
      run.notices = [
        {
          notice_id: `fixture-${run.run_id}-abandoned`,
          kind: 'failure',
          status: 'pending',
          axis: 'preparation',
          reason_code: 'PREPARATION_ABANDONED',
          comment_url: null
        }
      ]
      run.preparation.finished_at = now
      run.preparation.status = 'failed'
      run.preparation.disconnect_reason = null
      if (
        run.publication.status === 'pending' ||
        run.publication.status === 'publishing'
      ) {
        run.publication.status = 'skipped'
        run.publication.finished_at = now
      }
      abandoned.add(runId)
      response.end(JSON.stringify({ run }))
      return
    }
    if (requestUrl === '/api/runs/parked') {
      // Synthetic: a blocked run is not a lifecycle stage any scenario can describe (it is
      // the contradictory shape coordination refuses to resolve), so it is invented here
      // rather than mutating a real run. The ids are real, so following one opens a detail
      // page that loads.
      response.end(JSON.stringify({ blocks: blockedRuns() }))
      return
    }
    const stepsMatch = /^\/api\/runs\/([^/?]+)\/publication-steps$/.exec(
      requestUrl
    )
    if (stepsMatch) {
      const runId = decodeURIComponent(stepsMatch[1] ?? '')
      response.end(
        JSON.stringify({
          run_id: runId,
          publication_steps: stepsByRun.get(runId) ?? []
        })
      )
      return
    }
    const eventsMatch = /^\/api\/runs\/([^/?]+)\/events$/.exec(requestUrl)
    if (eventsMatch) {
      const runId = decodeURIComponent(eventsMatch[1] ?? '')
      const run = runs.find((item) => item.run_id === runId)
      if (!run) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      response.end(
        JSON.stringify({ run_id: run.run_id, events: eventsFor(run) })
      )
      return
    }
    const runMatch = /^\/api\/runs\/([^/?]+)$/.exec(requestUrl)
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1] ?? '')
      const run = runs.find((item) => item.run_id === runId)
      if (run) {
        // The run already carries its real axes. Forcing preparation to `disconnected` here
        // (as this used to) mislabelled every parked run as preparation-parked, including
        // the ones parked on execution or publication, and made their resume ineligible.
        response.end(JSON.stringify({ run }))
        return
      }
    }
  }
}
