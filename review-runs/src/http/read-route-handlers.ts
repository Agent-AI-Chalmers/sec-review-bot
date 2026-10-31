import { decodeRunListCursor } from '../persistence/review-run-queries.js'
import { observePublicationStep, observeRun } from '../observability.js'
import type { ReviewRunStore } from '../persistence/review-run-store.js'
import type { OperationHandlers, OperationRequest } from './route-handlers.js'

type ListQueryOptions = NonNullable<
  Parameters<ReviewRunStore['queries']['listRunsPage']>[0]
>

function invalidQuery(message: string): Error {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'INVALID_QUERY'
  })
}

function parseListQuery(
  query: NonNullable<OperationRequest<'listRuns'>['query']>
): ListQueryOptions {
  const { from, to, ...filters } = query
  if (
    filters.cursor !== undefined &&
    decodeRunListCursor(filters.cursor) === null
  )
    throw invalidQuery('cursor must be a valid run list cursor.')
  return {
    ...filters,
    limit: filters.limit ?? 50,
    ...(from === undefined ? {} : { from: new Date(from).toISOString() }),
    ...(to === undefined ? {} : { to: new Date(to).toISOString() })
  }
}

export function buildReadRouteHandlers({
  store,
  logReadinessFailure,
  logDroppedRunRow
}: {
  store: ReviewRunStore
  logReadinessFailure: (error: unknown) => void
  logDroppedRunRow: (dropped: { run_id: string; error: unknown }) => void
}) {
  return {
    getHealth: async () => ({ status: 'ok' }),

    getReadiness: async (_request, reply) => {
      try {
        await store.checkReadiness()
        return { status: 'ok' }
      } catch (error) {
        logReadinessFailure(error)
        return reply.code(503).send({ status: 'unavailable' })
      }
    },

    listRuns: async (request) => {
      const { runs, next_cursor, dropped } = await store.queries.listRunsPage(
        parseListQuery(request.query ?? {})
      )
      const statistics = await store.queries.getExecutionStatistics(
        runs.map((run) => run.run_id)
      )
      for (const droppedRow of dropped) logDroppedRunRow(droppedRow)
      return {
        runs: runs.map((run) =>
          observeRun(run, statistics.get(run.run_id) ?? null)
        ),
        next_cursor
      }
    },

    getRun: async (request, reply) => {
      const { runId } = request.params
      const run = await store.queries.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      const statistics = await store.queries.getExecutionStatistics([
        run.run_id
      ])
      return { run: observeRun(run, statistics.get(run.run_id) ?? null) }
    },

    listRunPublicationSteps: async (request, reply) => {
      const { runId } = request.params
      const run = await store.queries.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      const steps = await store.publications.listPublicationSteps(run.run_id)
      return {
        run_id: run.run_id,
        publication_steps: steps.map(observePublicationStep)
      }
    },

    listRunEvents: async (request, reply) => {
      const { runId } = request.params
      if (!(await store.queries.runExists(runId)))
        return reply.code(404).send({ error: 'run_not_found' })
      return { run_id: runId, events: await store.queries.listEvents(runId) }
    }
  } satisfies Partial<OperationHandlers>
}
